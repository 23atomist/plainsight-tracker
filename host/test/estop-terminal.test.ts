// I1: an E-STOP is terminal for host automation, whoever latched it. Driven
// entirely from the head side (the FakeHead's own latch, never a host route),
// so this covers the latch the host did not set itself: the dashboard's MCP
// leg timing out, MCP down at the time, another client, the head API.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { AgentStore } from "../src/shared/agent-store.js";
import { TrackingSession } from "../src/shared/track/session.js";
import { wireEstopDisarm } from "../src/mcp/estop-disarm.js";
import { Mat3 } from "../src/shared/geo/vec3.js";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
// 8 km north, 2 km up: pan 0, tilt ~14 under identity R.
const TARGET = { lat: RIG.lat + 8000 / 111_320, lon: RIG.lon, height: 2000 };
const MOTION_PATHS = new Set(["/api/goto", "/api/track", "/api/jog", "/api/home", "/api/setpos", "/api/reference"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

let head: FakeHead;
let device: Device;
let session: TrackingSession | undefined;

afterEach(async () => {
  session?.stop();
  session = undefined;
  device?.close();
  await head?.stop();
});

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "tb3-estop-")), name);
}

function armedAgent(): AgentStore {
  const agent = new AgentStore(tmpFile("agent.json"));
  agent.set(true);
  return agent;
}

function calibratedStore(): CalibrationStore {
  const store = new CalibrationStore(tmpFile("cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString());
  return store;
}

// The head latches on its own: the latch is set, the axes stop, the event goes out.
function latchFromHead(h: FakeHead): void {
  h.model.estop = true;
  for (const name of ["pan", "tilt"] as const) {
    const a = h.model.axes[name];
    h.model.axes[name] = { ...a, vel: 0, tgt: a.pos, mode: "I" };
  }
  h.emitEvent({ type: "event", t: Date.now(), name: "estop", axis: null, detail: null });
}

function clearFromHead(h: FakeHead): void {
  h.model.estop = false;
  h.emitEvent({ type: "event", t: Date.now(), name: "estop_cleared", axis: null, detail: null });
}

describe("E-STOP latched on the head while the agent is armed and tracking", () => {
  it("disarms the agent and ends the session; clearing the latch sends no motion", async () => {
    head = new FakeHead();
    await head.start();
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: head.url });
    device = new Device(cfg);
    const agent = armedAgent();
    const logs: string[] = [];
    wireEstopDisarm({ device, agent, log: (m) => logs.push(m) });
    device.start();
    await waitFor(() => device.getState().lastUpdateMs > 0, "first tick");

    session = new TrackingSession(device, cfg, calibratedStore());
    expect(session.start(TARGET, [0, 0, 0], "pass")).toBeNull();
    const feeder = setInterval(() => session?.updateTarget(TARGET, [0, 0, 0]), 200);
    try {
      await waitFor(() => session!.status().state === "tracking" && head.lastTrack !== null, "tracking");

      latchFromHead(head);
      await waitFor(() => session!.status().state === "stopped", "the session to end");
      expect(session.status().reason).toBe("estop");
      expect(agent.get().armed).toBe(false);
      expect(logs.filter((l) => /E-STOP latched.*agent disarmed/.test(l))).toHaveLength(1);

      // Several latched ticks go by: still one log line, still disarmed.
      await sleep(300);
      expect(logs).toHaveLength(1);

      const motionBefore = head.calls.filter((c) => MOTION_PATHS.has(c.path)).length;
      clearFromHead(head);
      await sleep(1000);   // fixes keep arriving; ~20 tracking ticks
      const motionAfter = head.calls.filter((c) => MOTION_PATHS.has(c.path)).length;
      expect(motionAfter).toBe(motionBefore);
      expect(session.status().state).toBe("stopped");
      expect(agent.get().armed).toBe(false);
    } finally {
      clearInterval(feeder);
    }
  }, 15000);

  it("a latch set while the daemon was not connected disarms on the first tick it sees", async () => {
    head = new FakeHead();
    await head.start();
    latchFromHead(head);   // nobody is listening: this event is lost
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: head.url });
    device = new Device(cfg);
    const agent = armedAgent();
    const logs: string[] = [];
    wireEstopDisarm({ device, agent, log: (m) => logs.push(m) });
    device.start();
    await waitFor(() => !agent.get().armed, "the agent to be disarmed");
    expect(logs).toEqual([expect.stringMatching(/seen by tick/)]);

    // A tracking start during the latch is refused, so nothing can be queued
    // to move the head when it is cleared.
    session = new TrackingSession(device, cfg, calibratedStore());
    expect(session.start(TARGET, [0, 0, 0], "pass")).toMatch(/^estop_latched/);

    // A new latch after a clear logs again.
    clearFromHead(head);
    await waitFor(() => !device.getState().estop, "the clear");
    agent.set(true);
    latchFromHead(head);
    await waitFor(() => !agent.get().armed, "the second disarm");
    expect(logs).toHaveLength(2);
  }, 15000);

  it("runs the onLatched hook once per latch, armed or not, and again after a clear", async () => {
    head = new FakeHead();
    await head.start();
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: head.url });
    device = new Device(cfg);
    const agent = armedAgent();
    agent.set(false);   // disarmed: the hook must still run
    let hookRuns = 0;
    wireEstopDisarm({ device, agent, log: () => {}, onLatched: () => { hookRuns += 1; } });
    device.start();
    await waitFor(() => device.getState().lastUpdateMs > 0, "first tick");

    latchFromHead(head);
    await waitFor(() => hookRuns === 1, "the hook");
    await sleep(300);   // latched ticks keep coming: still once
    expect(hookRuns).toBe(1);

    clearFromHead(head);
    await waitFor(() => !device.getState().estop, "the clear");
    latchFromHead(head);
    await waitFor(() => hookRuns === 2, "the hook on the second latch");
  }, 15000);
});
