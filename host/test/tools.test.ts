import { describe, it, expect, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";
import { registerTools } from "../src/mcp/tools.js";
import { registerLimitsTools } from "../src/mcp/limits-tools.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { LimitsStore } from "../src/shared/limits-store.js";
import { TrackingSession } from "../src/shared/track/session.js";
import { SunSupervisor } from "../src/shared/track/supervisor.js";
import { CaptureController, type CaptureDeps } from "../src/shared/capture/controller.js";
import { PassJournal } from "../src/shared/capture/pass-journal.js";
import { AgentStore } from "../src/shared/agent-store.js";

let mock: FakeHead | null = null;
let dev: Device | null = null;

async function harness(env: Record<string, string> = {}) {
  mock = new FakeHead(); await mock.start();   // ephemeral port
  const cfg = loadConfig(undefined, { TB3_HEAD_URL: mock.url, ...env });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const dir = mkdtempSync(join(tmpdir(), "tb3-tools-"));
  const store = new CalibrationStore(join(dir, "cal.json"));
  const limitsStore = new LimitsStore(join(dir, "limits.json"));
  limitsStore.load();
  const session = new TrackingSession(dev, cfg, store);
  const supervisor = new SunSupervisor(dev, cfg, store, session);
  const captureDeps: CaptureDeps = {
    setRecord: async () => {},
    snapshot: async (icao) => `/tmp/${icao}.jpg`,
    isArmed: async () => true,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };
  const capture = new CaptureController(captureDeps, { debounceMs: 5000, autoEnabled: true });
  const journal = new PassJournal(join(dir, "passes.jsonl"));
  const agentStore = new AgentStore(join(dir, "agent.json"));
  agentStore.load();
  const server = new McpServer({ name: "tb3-mcp", version: "test" });
  registerTools(server, dev, cfg, session, supervisor, store, capture, limitsStore, journal, agentStore);
  registerLimitsTools(server, dev, cfg, limitsStore);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, session, store, supervisor, capture, limitsStore, journal, cfg, agentStore };
}

afterEach(async () => {
  dev?.close(); dev = null;
  if (mock) { await mock.stop(); mock = null; }
});

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

// Intercepts every write to mock.lastJog so a test can see EVERY frame sent
// during a jog() call, not just whatever is left once the call has already
// resolved and self-cleared to zero (see device-jog.test.ts's identical
// helper — jog() always ends by clearing the vector, so a bare post-await
// read of mock.lastJog can never distinguish "blocked the whole time" from
// "ran fine and then stopped normally").
type JogFrame = Partial<Record<"pan" | "tilt" | "zoom" | "focus", number>>;
function captureJogFrames(m: FakeHead): JogFrame[] {
  const frames: JogFrame[] = [];
  Object.defineProperty(m, "lastJog", {
    configurable: true,
    get: () => frames[frames.length - 1] ?? null,
    set: (v: JogFrame) => { frames.push(v); },
  });
  return frames;
}

describe("MCP tools", () => {
  // 18 from registerTools + 3 from registerLimitsTools (teach/get/clear), both
  // wired into this file's shared harness — the Part 1 jog-guard tests below
  // need teach_limit available on the same server as "jog".
  it("lists all 23 tools; the retired ESP32 program/camera/zero tools are gone", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "capture_snapshot", "clear_estop", "clear_taught_limits", "confirm_taught_limits", "estop", "get_agent_armed", "get_capture_status",
      "get_head_config", "get_status", "get_taught_limits", "goto_angle", "home", "jog",
      "list_passes", "reference_pan", "set_agent_armed", "set_capture_mode", "set_head_config", "set_position",
      "start_recording", "stop", "stop_recording", "teach_limit",
    ]);
    // Built from parts so the repo-wide retired-name grep stays empty.
    for (const gone of [["set", "home"], ["trigger", "camera"], ["list", "programs"], ["select", "program"]].map((p) => p.join("_"))) {
      expect(names).not.toContain(gone);
    }
  });

  it("get_status reports position in degrees", async () => {
    const { client } = await harness();
    mock!.setPosition(30, -5);
    await new Promise((r) => setTimeout(r, 200));
    const res = await client.callTool({ name: "get_status", arguments: {} });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.pan_deg).toBe(30);
    expect(parsed.tilt_deg).toBe(-5);
  });

  it("get_status carries the head's state and none of the ESP32 fields", async () => {
    const { client } = await harness({ TB3_PAN_SIGN: "-1" });
    mock!.setPosition(30, 0);
    await new Promise((r) => setTimeout(r, 200));
    const parsed = JSON.parse(textOf(await client.callTool({ name: "get_status", arguments: {} })));
    expect(Object.keys(parsed).sort()).toEqual([
      "axes", "connected", "enabled", "estop", "focus_deg", "imu", "last_update_age_ms", "link", "moving",
      "pan_deg", "pan_ref", "stale", "tilt_deg", "tilt_disagree_deg", "zoom_deg",
    ]);
    expect(parsed.pan_deg).toBe(-30); // user frame: pan_sign applied
    expect(Object.keys(parsed.axes).sort()).toEqual(["focus", "pan", "tilt", "zoom"]);
    expect(Object.keys(parsed.axes.tilt).sort()).toEqual(["driver", "endstop", "homed", "mode", "pos", "tgt", "vel"]);
    expect(parsed.estop).toBe(false);
    expect(parsed.pan_ref).toEqual({ source: "imu", persisted: true, age_s: 0 });
    expect(parsed.link).toEqual({ pico: true, imu: true });
    expect(parsed.imu.ok).toBe(true);
    expect(parsed.imu).toHaveProperty("heading_deg");

    mock!.model.estop = true;
    mock!.tick();
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.parse(textOf(await client.callTool({ name: "get_status", arguments: {} }))).estop).toBe(true);
  });

  it("goto_angle moves and reports arrival", async () => {
    const { client } = await harness();
    mock!.setPosition(0, 0);
    const res = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(mock!.lastGoto!.pan).toBeCloseTo(20, 5);
    expect(textOf(res)).toMatch(/arrived|pan_deg/i);
  });

  it("goto_angle refuses an out-of-limit target", async () => {
    const { client } = await harness();
    const res = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 999, tilt_deg: 0 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/outside the allowed range/);
    expect(mock!.lastGoto).toBeNull();
  });

  it("goto_angle applies pan_sign to reach device frame", async () => {
    const { client } = await harness({ TB3_PAN_SIGN: "-1" });
    mock!.setPosition(0, 0);
    await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(mock!.lastGoto!.pan).toBeCloseTo(-20, 5); // user +20 → device -20
  });

  it("jog sends deg/s and zeroes the head on completion", async () => {
    const { client } = await harness();
    const frames = captureJogFrames(mock!);
    await client.callTool({ name: "jog", arguments: { pan_dps: 5, tilt_dps: 0, duration_ms: 150 } });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.some((f) => f.pan === 5)).toBe(true);
    expect(frames[frames.length - 1]).toEqual({ pan: 0, tilt: 0 });
  });

  it("jog replies with the rates it actually sent, in deg/s", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({ name: "jog", arguments: { pan_dps: -5, tilt_dps: 2.5, duration_ms: 100 } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("jogged for 100ms (pan -5°/s tilt 2.5°/s)");
  });

  it("jog reply rounds the rates to 2 decimals", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({ name: "jog", arguments: { pan_dps: 1.23456, tilt_dps: 0.005, duration_ms: 50 } });
    expect(textOf(res)).toBe("jogged for 50ms (pan 1.23°/s tilt 0.01°/s)");
  });

  it("jog caps each axis at maxJogDps (the manual-jog ceiling)", async () => {
    const { client, cfg } = await harness({ TB3_PAN_SIGN: "-1" });
    const frames = captureJogFrames(mock!);
    const res: any = await client.callTool({ name: "jog", arguments: { pan_dps: 100, tilt_dps: 100, duration_ms: 100 } });
    expect(textOf(res)).toBe(`jogged for 100ms (pan ${cfg.maxJogDps}°/s tilt ${cfg.maxJogDps}°/s)`);
    await new Promise((r) => setTimeout(r, 50));
    // pan_sign -1 mirrors the device frame; the cap applies to the magnitude.
    expect(frames.some((f) => f.pan === -cfg.maxJogDps && f.tilt === cfg.maxJogDps)).toBe(true);
    for (const f of frames) {
      expect(Math.abs(f.pan ?? 0)).toBeLessThanOrEqual(cfg.maxJogDps);
      expect(Math.abs(f.tilt ?? 0)).toBeLessThanOrEqual(cfg.maxJogDps);
    }
  });

  // REGRESSION: duration_ms required .positive(), so the dashboard's
  // press-and-hold jog (dashboard/public/jog-hold.js) posting an explicit
  // (0,0,0) stop vector on release was rejected by THIS tool's own schema on
  // every single release -- an MCP error dialog on every jog release, and
  // the designed "stop right away" behaviour never actually ran (motion
  // only ever stopped via the 500ms jog dead-man). duration_ms:0
  // must be accepted, and must actually zero the rig.
  it("REGRESSION: jog accepts duration_ms: 0 as an explicit stop, not rejected", async () => {
    const { client } = await harness();
    mock!.lastJog = { pan: 1, tilt: 1 }; // seed a non-zero value so the assertion below is meaningful
    const res: any = await client.callTool({ name: "jog", arguments: { pan_dps: 0, tilt_dps: 0, duration_ms: 0 } });
    expect(res.isError).toBeFalsy();
    await new Promise((r) => setTimeout(r, 50));
    expect(mock!.lastJog).toEqual({ pan: 0, tilt: 0 });
  });

  it("stop clears a live manual jog so the keep-alive cannot resume it", async () => {
    const { client } = await harness();
    dev!.setJogVector(5, 0, 2000);                    // a live jog, refreshed every 100ms
    await new Promise((r) => setTimeout(r, 150));
    const frames = captureJogFrames(mock!);
    await client.callTool({ name: "stop", arguments: {} });
    await new Promise((r) => setTimeout(r, 350));     // several keep-alive periods
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1]).toEqual({ pan: 0, tilt: 0 });
    // The STOP is the last motion command: no jog refresh follows it.
    const motion = mock!.calls.filter((c) => ["/api/jog", "/api/stop"].includes(c.path)).map((c) => c.path);
    expect(motion.at(-1)).toBe("/api/stop");
  });

  it("stop reaches the device", async () => {
    const { client } = await harness();
    await client.callTool({ name: "stop", arguments: {} });
    expect(mock!.stopCount).toBe(1);
  });

  it("goto_angle refuses while a tracking session is active", async () => {
    const { client, session } = await harness();
    session.forceStateForTest("tracking");
    const res: any = await client.callTool({ name: "goto_angle", arguments: { pan_deg: 20, tilt_deg: 0 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tracking active/i);
    expect(mock!.lastGoto).toBeNull();
    session.stop();
  });

  it("jog refuses while a tracking session is active", async () => {
    const { client, session } = await harness();
    session.forceStateForTest("tracking");
    const res: any = await client.callTool({ name: "jog", arguments: { pan_dps: 5, tilt_dps: 0, duration_ms: 100 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tracking active/i);
    session.stop();
  });

  it("stop ends an active tracking session as well as halting the device", async () => {
    const { client, session } = await harness();
    session.forceStateForTest("tracking");
    expect(session.isActive()).toBe(true);
    await client.callTool({ name: "stop", arguments: {} });
    expect(session.isActive()).toBe(false);
    expect(mock!.stopCount).toBe(1);
  });
});

// Part 1: the safety-critical fix. Rate jog (device.jog, driven by both the
// dashboard's press-and-hold control and the joystick — see tools.ts's "jog"
// handler doc comment for the traced call path) previously reached the
// device with NO check against panMin/panMax/tiltMin/tiltMax at all: holding
// a direction slewed straight through the software limit into the mechanical
// stop. These tests pin the fix directly at the MCP "jog" tool, the one
// choke point both dashboard control loops actually post through.
describe("jog rate-limit enforcement (Part 1 safety fix)", () => {
  it("rate jog toward a limit the rig is already AT commands zero on that axis", async () => {
    const { client } = await harness();
    mock!.setPosition(30, 0); // sitting exactly at pan 30
    await new Promise((r) => setTimeout(r, 200));
    const frames = captureJogFrames(mock!);
    // Teach a tighter pan_max right at the current position, then try to
    // keep pushing further in the SAME direction.
    await client.callTool({ name: "teach_limit", arguments: { edge: "pan_max" } });
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 10, tilt_dps: 0, duration_ms: 300 },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.pan ?? 0).toBe(0); // pan NEVER commanded, not just eventually zeroed
  });

  it("rate jog toward a limit from BEYOND it (already over-travelled) also commands zero", async () => {
    const { client } = await harness({ TB3_PAN_MAX: "30" });
    mock!.setPosition(35, 0); // already past the configured ceiling
    await new Promise((r) => setTimeout(r, 200));
    const frames = captureJogFrames(mock!);
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 5, tilt_dps: 0, duration_ms: 200 },
    });
    expect(textOf(res)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 50));
    for (const f of frames) expect(f.pan ?? 0).toBe(0);
  });

  // THE TRAP: a naive "am I outside the range" check would also block motion
  // back toward safety. It must not.
  it("rate jog AWAY from a limit is always permitted, even sitting exactly at it", async () => {
    const { client } = await harness();
    mock!.setPosition(30, 0);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "teach_limit", arguments: { edge: "pan_max" } });
    const frames = captureJogFrames(mock!);
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: -10, tilt_dps: 0, duration_ms: 300 },
    });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toMatch(/held at travel limit/);
    await new Promise((r) => setTimeout(r, 50));
    // The commanded (negative) rate reached the device at least once before
    // jog()'s own trailing zero — same non-zero-then-zero shape
    // device-jog.test.ts's REGRESSION case pins for the unguarded path.
    expect(frames.some((f) => (f.pan ?? 0) < 0)).toBe(true);
  });

  it("blocks only the offending axis — the other axis keeps its commanded rate", async () => {
    const { client } = await harness();
    mock!.setPosition(30, 0); // pan at its taught limit, tilt at 0 (wide open)
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "teach_limit", arguments: { edge: "pan_max" } });
    const frames = captureJogFrames(mock!);
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 10, tilt_dps: 5, duration_ms: 300 },
    });
    expect(textOf(res)).toMatch(/held at travel limit: pan$/);
    await new Promise((r) => setTimeout(r, 50));
    for (const f of frames) expect(f.pan ?? 0).toBe(0);          // pan: fully suppressed
    expect(frames.some((f) => (f.tilt ?? 0) > 0)).toBe(true);        // tilt: still commanded
  });

  // Enforcement must use the EFFECTIVE (taught-or-config) limit: the same
  // command that is fine under the bare config ceiling must be caught once a
  // tighter limit is taught.
  it("a taught limit stops rate jog earlier than the bare config limit would", async () => {
    const { client, limitsStore } = await harness(); // config panMax defaults to 180
    mock!.setPosition(160, 0);
    await new Promise((r) => setTimeout(r, 200));

    // Under the config-only ceiling (180), this command is not even close to
    // the limit and must NOT be blocked: 160 + 10 deg/s x (0.3s + 1s to stop
    // at the head's amax 10) = 173.
    const before: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 10, tilt_dps: 0, duration_ms: 300 },
    });
    expect(textOf(before)).not.toMatch(/held at travel limit/);
    // Let the "before" call's own trailing frame finish crossing the loopback
    // socket before the next call starts capturing — otherwise a message
    // still in flight from THIS call can land after captureJogFrames() below
    // is installed and be misread as belonging to the next one (same
    // settling wait device-jog.test.ts uses after every jog() call).
    await new Promise((r) => setTimeout(r, 100));

    // Teach a tighter ceiling that the SAME command would now cross.
    limitsStore.setEdge("panMax", 170);   // 173 > 170
    const frames = captureJogFrames(mock!);
    const after: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 10, tilt_dps: 0, duration_ms: 300 },
    });
    expect(textOf(after)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 50));
    for (const f of frames) expect(f.pan ?? 0).toBe(0);
  });

  // The head does not stop dead when a jog ends: it decelerates at its amax.
  // So the guard's horizon is the jog's duration PLUS the stopping time
  // |rate| / amax, from the head's GET /api/config (FakeHead: amax 10).
  it("the stopping reserve holds a jog that its duration alone would allow", async () => {
    const { client } = await harness();          // panMax 180
    mock!.setPosition(170, 0);
    await new Promise((r) => setTimeout(r, 200));
    const frames = captureJogFrames(mock!);
    // Duration alone: 170 + 10 x 0.3 = 173, inside. With the 1s stop: 183.
    const res: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 10, tilt_dps: 0, duration_ms: 300 },
    });
    expect(textOf(res)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 50));
    for (const f of frames) expect(f.pan ?? 0).toBe(0);
  });

  it("the stopping reserve uses trackFallbackAmaxDps2 until the head's config is known", async () => {
    // A gentler fallback amax only matters when the head has not answered
    // GET /api/config: make it unreadable before the Device connects.
    mock = new FakeHead(); await mock.start();   // ephemeral port
    mock.failNext("/api/config", 503, 1000);
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: mock.url, TB3_TRACK_FALLBACK_AMAX_DPS2: "1" });
    dev = new Device(cfg); dev.start();
    const t0 = Date.now();
    while (!dev.getState().connected && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
    expect(dev.getAxisConfig()).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "tb3-tools-fb-"));
    const store = new CalibrationStore(join(dir, "cal.json"));
    const limitsStore = new LimitsStore(join(dir, "limits.json"));
    limitsStore.load();
    const session = new TrackingSession(dev, cfg, store);
    const supervisor = new SunSupervisor(dev, cfg, store, session);
    const capture = new CaptureController({
      setRecord: async () => {}, snapshot: async (icao) => `/tmp/${icao}.jpg`, isArmed: async () => true,
      now: () => Date.now(), nowIso: () => new Date().toISOString(),
    }, { debounceMs: 5000, autoEnabled: true });
    const server = new McpServer({ name: "tb3-mcp", version: "test" });
    registerTools(
      server, dev, cfg, session, supervisor, store, capture, limitsStore, new PassJournal(join(dir, "p.jsonl")),
      new AgentStore(join(dir, "agent.json")),
    );
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [c, s2] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s2), client.connect(c)]);
    mock.setPosition(170, 0);
    await new Promise((r) => setTimeout(r, 200));
    // 170 + 4 x (0.1 + 4s to stop at amax 1) = 186.4: held. At amax 10 it
    // would be 170 + 4 x 0.5 = 172: allowed.
    const res: any = await client.callTool({ name: "jog", arguments: { pan_dps: 4, tilt_dps: 0, duration_ms: 100 } });
    expect(textOf(res)).toMatch(/held at travel limit: pan/);
  });

  // Both the dashboard's press-and-hold ramp (jog-hold.js) and the joystick
  // (joystick-hold.js) post to /api/control/jog -> controls.ts's "jog" case
  // -> McpDashboardClient.jog() -> this exact MCP tool (traced in tools.ts's
  // jog handler doc comment) — there is no third way to command a rate. Each
  // caller sends a DIFFERENT (rate, duration) shape (a ramped rate refreshed
  // at ~2/3 of the jog dead-man TTL for the hold; a stick-proportional rate posted
  // every ~100ms for the joystick), so exercise both shapes against the same
  // near-limit position rather than assuming one code path stands in for the
  // other.
  it("both the press-and-hold shape and the joystick shape hit the same enforcement", async () => {
    const { client } = await harness();
    mock!.setPosition(30, 0);
    await new Promise((r) => setTimeout(r, 200));
    await client.callTool({ name: "teach_limit", arguments: { edge: "pan_max" } });

    // jog-hold.js's JogHold posts at holdIntervalMs(<dead-man TTL>) with a
    // ramped rate; a mid-ramp value + its own interval, duration-shaped like
    // its keep-alive posts (see jog-hold.js's _tick).
    const holdFrames = captureJogFrames(mock!);
    const holdRes: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 12, tilt_dps: 0, duration_ms: 333 },
    });
    expect(textOf(holdRes)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 60));
    for (const f of holdFrames) expect(f.pan ?? 0).toBe(0);

    // joystick-hold.js's JoystickHold posts every POLL_INTERVAL_MS (100ms)
    // with a stick-proportional rate.
    const joyFrames = captureJogFrames(mock!);
    const joyRes: any = await client.callTool({
      name: "jog", arguments: { pan_dps: 19, tilt_dps: 0, duration_ms: 100 },
    });
    expect(textOf(joyRes)).toMatch(/held at travel limit: pan/);
    await new Promise((r) => setTimeout(r, 60));
    for (const f of joyFrames) expect(f.pan ?? 0).toBe(0);
  });
});

describe("head tools (home / set_position / reference_pan / estop / head config)", () => {
  const callsTo = (path: string) => mock!.calls.filter((c) => c.path === path);

  it("home posts /api/home with the axes and says where to watch", async () => {
    const { client } = await harness();
    const res: any = await client.callTool({ name: "home", arguments: { axes: ["tilt"] } });
    expect(res.isError ?? false).toBe(false);
    expect(textOf(res)).toMatch(/get_status\.axes\.tilt\.homed/);
    expect(callsTo("/api/home").map((c) => c.body)).toEqual([{ axes: ["tilt"] }]);
  });

  it("home refuses while tracking and while sun-locked", async () => {
    const { client, session, supervisor } = await harness();
    session.forceStateForTest("tracking");
    let res: any = await client.callTool({ name: "home", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tracking active/i);
    session.stop();
    vi.spyOn(supervisor, "isSunLocked").mockReturnValue(true);
    res = await client.callTool({ name: "home", arguments: {} });
    expect(res.isError).toBe(true);
    expect(callsTo("/api/home")).toHaveLength(0);
  });

  it("set_position posts /api/setpos in the device frame (signs applied) and leaves calibration and limits alone", async () => {
    const { client, store, limitsStore } = await harness({ TB3_PAN_SIGN: "-1" });
    const inv = vi.spyOn(store, "invalidateCalibration");
    const clr = vi.spyOn(limitsStore, "clear");
    const res: any = await client.callTool({ name: "set_position", arguments: { pan_deg: 10, tilt_deg: 5 } });
    expect(res.isError ?? false).toBe(false);
    expect(textOf(res)).toMatch(/pan_reference/);
    expect(callsTo("/api/setpos").map((c) => c.body)).toEqual([{ pan: -10, tilt: 5 }]);
    expect(inv).not.toHaveBeenCalled();
    expect(clr).not.toHaveBeenCalled();
  });

  it("set_position sends only the axes given, and refuses an empty call, tracking, and sun lock", async () => {
    const { client, session, supervisor } = await harness();
    await client.callTool({ name: "set_position", arguments: { tilt_deg: 3 } });
    expect(callsTo("/api/setpos").map((c) => c.body)).toEqual([{ tilt: 3 }]);
    let res: any = await client.callTool({ name: "set_position", arguments: {} });
    expect(res.isError).toBe(true);
    session.forceStateForTest("tracking");
    res = await client.callTool({ name: "set_position", arguments: { pan_deg: 1 } });
    expect(textOf(res)).toMatch(/tracking active/i);
    session.stop();
    vi.spyOn(supervisor, "isSunLocked").mockReturnValue(true);
    res = await client.callTool({ name: "set_position", arguments: { pan_deg: 1 } });
    expect(res.isError).toBe(true);
    expect(callsTo("/api/setpos")).toHaveLength(1);
  });

  it("reference_pan posts /api/reference; refused while tracking or sun-locked", async () => {
    const { client, session, supervisor } = await harness();
    const res: any = await client.callTool({ name: "reference_pan", arguments: {} });
    expect(textOf(res)).toMatch(/pan_reference event/);
    expect(callsTo("/api/reference")).toHaveLength(1);
    session.forceStateForTest("tracking");
    expect(((await client.callTool({ name: "reference_pan", arguments: {} })) as any).isError).toBe(true);
    session.stop();
    vi.spyOn(supervisor, "isSunLocked").mockReturnValue(true);
    expect(((await client.callTool({ name: "reference_pan", arguments: {} })) as any).isError).toBe(true);
    expect(callsTo("/api/reference")).toHaveLength(1);
  });

  it("estop latches, stops a tracking session, and works even sun-locked; clear_estop releases", async () => {
    const { client, session, supervisor } = await harness();
    session.forceStateForTest("tracking");
    vi.spyOn(supervisor, "isSunLocked").mockReturnValue(true);
    const res: any = await client.callTool({ name: "estop", arguments: {} });
    expect(res.isError ?? false).toBe(false);
    expect(textOf(res)).toBe("E-STOP latched; clear_estop to release");
    expect(session.isActive()).toBe(false);
    expect(callsTo("/api/estop")).toHaveLength(1);
    const clr: any = await client.callTool({ name: "clear_estop", arguments: {} });
    expect(clr.isError ?? false).toBe(false);
    expect(callsTo("/api/estop/clear")).toHaveLength(1);
  });

  // Spec 6.4: E-STOP clears the agent's armed flag before stopping motion,
  // and clear_estop does NOT re-arm it -- re-arming is an explicit operator act.
  it("estop disarms the agent even when the head post fails; clear_estop leaves it disarmed", async () => {
    const { client, agentStore } = await harness();
    agentStore.set(true);
    await client.callTool({ name: "estop", arguments: {} });
    expect(agentStore.get().armed).toBe(false);
    agentStore.set(true);
    mock!.failNext("/api/estop", 500);
    const res: any = await client.callTool({ name: "estop", arguments: {} });
    expect(res.isError).toBe(true);
    expect(agentStore.get().armed).toBe(false);
    await client.callTool({ name: "clear_estop", arguments: {} });
    expect(agentStore.get().armed).toBe(false);
  });

  // I1: an E-STOP latched on the head (by anyone) refuses every motion tool
  // up front; stop/estop/clear_estop stay open.
  it("every motion tool refuses with estop_latched while the head is latched, and sends nothing", async () => {
    const { client } = await harness();
    mock!.model.estop = true;
    const t0 = Date.now();
    while (!dev!.getState().estop && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    const before = mock!.calls.length;
    for (const [name, args] of [
      ["goto_angle", { pan_deg: 10, tilt_deg: 10 }],
      ["jog", { pan_dps: 2, tilt_dps: 0, duration_ms: 200 }],
      ["home", {}],
      ["set_position", { pan_deg: 1 }],
      ["reference_pan", {}],
    ] as const) {
      const res: any = await client.callTool({ name, arguments: args });
      expect(res.isError, name).toBe(true);
      expect(textOf(res), name).toMatch(/^estop_latched/);
    }
    expect(mock!.calls.slice(before)).toEqual([]);
    const stop: any = await client.callTool({ name: "stop", arguments: {} });
    expect(stop.isError ?? false).toBe(false);
  });

  it("get_head_config returns the head's config; set_head_config posts scope/key/value with save and force", async () => {
    const { client } = await harness();
    const cfgRes = JSON.parse(textOf(await client.callTool({ name: "get_head_config", arguments: {} })));
    expect(cfgRes).toHaveProperty("pan");
    expect(cfgRes).toHaveProperty("global");
    const res: any = await client.callTool({
      name: "set_head_config", arguments: { scope: "pan", key: "vmax", value: 42, save: true },
    });
    expect(res.isError ?? false).toBe(false);
    const posts = callsTo("/api/config").filter((c) => c.method === "POST");
    expect(posts[0].body).toEqual({ scope: "pan", key: "vmax", value: 42, save: true });
    expect(posts[0].query).toEqual({});
  });

  it("set_head_config surfaces the 403 guard text verbatim, and ?force=1 gets through", async () => {
    const { client } = await harness();
    const denied: any = await client.callTool({
      name: "set_head_config", arguments: { scope: "global", key: "track_timeout_ms", value: 500 },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("guarded setting; add ?force=1");
    const okRes: any = await client.callTool({
      name: "set_head_config", arguments: { scope: "global", key: "track_timeout_ms", value: 500, force: true },
    });
    expect(okRes.isError ?? false).toBe(false);
    const posts = mock!.calls.filter((c) => c.path === "/api/config" && c.method === "POST");
    expect(posts[1].query).toEqual({ force: "1" });
  });

  it("set_head_config validates input and is refused while tracking", async () => {
    const { client, session } = await harness();
    const bad: any = await client.callTool({
      name: "set_head_config", arguments: { scope: "pan", key: "a b", value: 1 },
    });
    expect(bad.isError).toBe(true);
    session.forceStateForTest("tracking");
    const res: any = await client.callTool({
      name: "set_head_config", arguments: { scope: "pan", key: "vmax", value: 1 },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tracking active/i);
    expect(mock!.calls.filter((c) => c.path === "/api/config" && c.method === "POST")).toHaveLength(0);
    session.stop();
  });
});

describe("agent armed flag tools (spec 6.4)", () => {
  it("get_agent_armed defaults to disarmed; set_agent_armed persists through the store", async () => {
    const { client, agentStore } = await harness();
    expect(JSON.parse(textOf(await client.callTool({ name: "get_agent_armed", arguments: {} })))).toEqual({ armed: false });
    const res: any = await client.callTool({ name: "set_agent_armed", arguments: { armed: true } });
    expect(res.isError ?? false).toBe(false);
    expect(agentStore.get().armed).toBe(true);
    expect(JSON.parse(textOf(await client.callTool({ name: "get_agent_armed", arguments: {} })))).toEqual({ armed: true });
    await client.callTool({ name: "set_agent_armed", arguments: { armed: false } });
    expect(agentStore.get().armed).toBe(false);
  });

  it("set_agent_armed rejects a non-boolean", async () => {
    const { client, agentStore } = await harness();
    const res: any = await client.callTool({ name: "set_agent_armed", arguments: { armed: "yes" } });
    expect(res.isError).toBe(true);
    expect(agentStore.get().armed).toBe(false);
  });
});
