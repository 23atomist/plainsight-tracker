// I3: a pan reference of unknown offset (`previous: null`, e.g. after a Pico
// reboot) flags the calibration AND the taught pan limits. A frame-verifying
// solve re-verifies the calibration, but it does not re-teach the limits, so
// automation must stay blocked (and say so) until the pan edges are re-taught
// or confirm_taught_limits. Driven end to end through the FakeHead: the
// reference comes from a real set_position on an unhomed pan.
import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { LimitsStore } from "../src/shared/limits-store.js";
import { AgentStore } from "../src/shared/agent-store.js";
import { TrackingSession, realScheduler } from "../src/shared/track/session.js";
import { SunSupervisor } from "../src/shared/track/supervisor.js";
import { HeadRefWatch } from "../src/mcp/head-ref-watch.js";
import { wireReferenceShift } from "../src/mcp/reference-shift.js";
import { registerTools } from "../src/mcp/tools.js";
import { registerGeoTools } from "../src/mcp/geo-tools.js";
import { registerTrackTools } from "../src/mcp/track-tools.js";
import { registerLimitsTools } from "../src/mcp/limits-tools.js";
import { AdsbSource } from "../src/shared/adsb/source.js";
import { CaptureController } from "../src/shared/capture/controller.js";
import { PassJournal } from "../src/shared/capture/pass-journal.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (r: any): string => r.content.map((c: any) => c.text).join("\n");

let head: FakeHead | null = null;
let device: Device | null = null;
let session: TrackingSession | null = null;

afterEach(async () => {
  session?.stop();
  device?.close();
  if (head) await head.stop();
  head = null; device = null; session = null;
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "tb3-panlim-"));
  head = new FakeHead();
  await head.start();
  const cfg = loadConfig(undefined, { TB3_HEAD_URL: head.url, TB3_TILT_MIN: "-90" });
  device = new Device(cfg);
  const store = new CalibrationStore(join(dir, "cal.json"), cfg.geoPanSign);
  store.load();
  const limits = new LimitsStore(join(dir, "limits.json"));
  limits.load();
  const frames = new HeadRefWatch(join(dir, "head-ref.json"), (why) => { store.markFrameUnverified(why); });
  frames.load();
  wireReferenceShift(device, { panSign: cfg.panSign, stores: { calibration: store, limits }, frames, log: () => {} });
  device.onRefTick((ref, first) => frames.observe(ref, first));
  device.start();
  const t0 = Date.now();
  while (device.getState().lastUpdateMs === 0 && Date.now() - t0 < 3000) await sleep(20);

  session = new TrackingSession(device, cfg, store, Date.now, realScheduler, undefined, () => limits.get());
  const supervisor = new SunSupervisor(device, cfg, store, session, Date.now, realScheduler, () => limits.get());
  const source = new AdsbSource(cfg, { fetchFn: (async () => ({ ok: true, json: async () => ({ aircraft: [] }) })) as unknown as typeof fetch });
  const capture = new CaptureController({
    setRecord: async () => {}, snapshot: async (icao) => `/tmp/${icao}.jpg`, isArmed: async () => true,
    now: () => Date.now(), nowIso: () => new Date().toISOString(),
  }, { debounceMs: 5000, autoEnabled: false });
  const agent = new AgentStore(join(dir, "agent.json"));
  agent.load();
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, device, cfg, session, supervisor, store, capture, limits, new PassJournal(join(dir, "p.jsonl")), agent);
  registerGeoTools(server, device, cfg, store, session, supervisor, source, limits);
  registerTrackTools(server, session, supervisor);
  registerLimitsTools(server, device, cfg, limits);
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const sight = async (pan: number, tilt: number, lat: number, lon: number, label: string) => {
    head!.setPosition(pan, tilt);
    await sleep(150);
    expect((await call("sight_landmark", { lat, lon, height_m: 100, label }) as any).isError ?? false).toBe(false);
  };
  return { call, sight, store, limits };
}

const TARGET = { lat: 46, lon: 10, height_m: 3000 };

describe("taught pan limits after a reference of unknown offset", () => {
  it("re-sight + solve verifies the calibration but automation stays blocked until confirm_taught_limits", async () => {
    const { call, sight, store, limits } = await harness();
    await call("set_rig_location", { lat: 45, lon: 10, height_m: 100 });
    await sight(0, 2, 46, 10, "N_old");
    await sight(80, 1, 45, 11.4, "E_old");
    await call("solve_calibration");
    limits.setEdge("panMin", -100);
    limits.setEdge("panMax", 100);

    // A Pico reboot: pan is no longer homed, so the head's next reference
    // carries no old frame.
    head!.model.axes.pan = { ...head!.model.axes.pan, homed: false };
    expect((await call("set_position", { pan_deg: 30 }) as any).isError ?? false).toBe(false);
    const t0 = Date.now();
    while (!store.isFrameUnverified() && Date.now() - t0 < 2000) await sleep(20);
    expect(store.isFrameUnverified()).toBe(true);
    expect(limits.panUnverifiedEdges()).toEqual(["panMin", "panMax"]);
    let taught = JSON.parse(textOf(await call("get_taught_limits")));
    expect(taught).toMatchObject({ pan_limits_verified: false, unverified_edges: ["pan_min", "pan_max"] });
    expect(taught.note).toMatch(/taught pan limits unverified/);

    // Re-sight twice in the new frame and solve: the calibration is verified...
    await sight(45, 1, 45.7, 10.99, "NE");
    await sight(80, 1, 45, 11.4, "E");
    const solved = await call("solve_calibration") as any;
    expect(solved.isError ?? false).toBe(false);
    expect(store.isFrameUnverified()).toBe(false);
    // ...but the reply must not announce that automation is back.
    expect(textOf(solved)).toMatch(/frame verified/i);
    expect(textOf(solved)).not.toMatch(/allowed again/);
    expect(textOf(solved)).toMatch(/STILL BLOCKED: taught pan limits unverified/);
    let status = JSON.parse(textOf(await call("get_tracking_status")));
    expect(status).toMatchObject({ calibration_verified: true, pan_limits_verified: false });
    let start = await call("start_tracking", TARGET) as any;
    expect(start.isError).toBe(true);
    expect(textOf(start)).toMatch(/^taught pan limits unverified/);
    expect(JSON.parse(textOf(await call("park_idle")))).toEqual({ parked: false, reason: "pan_limits_unverified" });

    // The operator vouches for them: confirmed, idempotent, unblocked.
    const confirmed = JSON.parse(textOf(await call("confirm_taught_limits")));
    expect(confirmed).toMatchObject({ confirmed: { pan_min: -100, pan_max: 100 }, was_unverified: ["pan_min", "pan_max"] });
    const again = JSON.parse(textOf(await call("confirm_taught_limits")));
    expect(again).toMatchObject({ confirmed: { pan_min: -100, pan_max: 100 }, was_unverified: [] });
    expect(again.note).toMatch(/already verified/);
    taught = JSON.parse(textOf(await call("get_taught_limits")));
    expect(taught).toMatchObject({ pan_limits_verified: true, unverified_edges: [] });
    status = JSON.parse(textOf(await call("get_tracking_status")));
    expect(status.pan_limits_verified).toBe(true);
    start = await call("start_tracking", TARGET) as any;
    expect(start.isError ?? false).toBe(false);
  }, 20000);

  it("re-teaching every flagged pan edge clears the block; one edge alone does not", async () => {
    const { call, store, limits } = await harness();
    limits.setEdge("panMin", -100);
    limits.setEdge("panMax", 100);
    head!.model.axes.pan = { ...head!.model.axes.pan, homed: false };
    await call("set_position", { pan_deg: 0 });
    const t0 = Date.now();
    while (!limits.isPanUnverified() && Date.now() - t0 < 2000) await sleep(20);
    store.confirmFrame();   // the calibration side is not under test here

    head!.setPosition(-90, 10);
    await sleep(150);
    const first = JSON.parse(textOf(await call("teach_limit", { edge: "pan_min" })));
    expect(first.note).toMatch(/pan_max are still unverified/);
    expect(limits.panUnverifiedEdges()).toEqual(["panMax"]);

    head!.setPosition(95, 10);
    await sleep(150);
    const second = JSON.parse(textOf(await call("teach_limit", { edge: "pan_max" })));
    expect(second.note).not.toMatch(/unverified/);
    expect(limits.isPanUnverified()).toBe(false);
    expect(limits.get()).toMatchObject({ panMin: -90, panMax: 95 });
  }, 20000);
});
