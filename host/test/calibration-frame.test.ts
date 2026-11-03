// The calibration-frame verification gate (task-7 fix round, E1/E2). A pan
// reference that arrives with NO known offset from the old frame -- a
// re-reference after a drop, or a rename the host never saw because its
// WebSocket was down -- may have put pan's zero anywhere (IMU north is off by
// the compass error; set_position takes any value). The calibration was
// solved in the old frame, so it is flagged unverified until the operator
// re-sights and solves, or confirms the head was not moved.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { HeadRefWatch } from "../src/mcp/head-ref-watch.js";

function tmpDir(): string { return mkdtempSync(join(tmpdir(), "tb3-frame-")); }

describe("CalibrationStore frame-unverified flag", () => {
  function solvedStore(f: string): CalibrationStore {
    const s = new CalibrationStore(f, 1);
    s.setRigLocation(33.4, -112.1, 341);
    s.setOrientation([[1, 0, 0], [0, 1, 0], [0, 0, 1]], new Date(0).toISOString());
    s.addSighting({ lat: 33.5, lon: -112.1, height: 3000, panDeg: 0, tiltDeg: 10 });
    return s;
  }

  it("is clear by default, set by markFrameUnverified, and persisted", () => {
    const f = join(tmpDir(), "cal.json");
    const s = solvedStore(f);
    expect(s.isFrameUnverified()).toBe(false);
    s.markFrameUnverified("pan referenced by imu with no previous frame");
    expect(s.isFrameUnverified()).toBe(true);
    expect(s.frameUnverifiedReason()).toMatch(/no previous frame/);
    const back = new CalibrationStore(f, 1);
    back.load();
    expect(back.isFrameUnverified()).toBe(true);
    expect(back.frameUnverifiedReason()).toMatch(/no previous frame/);
  });

  it("a solve over only pre-flag sightings does not clear it", () => {
    const s = solvedStore(join(tmpDir(), "cal.json"));
    s.markFrameUnverified("x");
    expect(s.clearFrameUnverifiedIfResighted(s.get().sightings)).toBe(false);
    expect(s.isFrameUnverified()).toBe(true);
  });

  it("a solve that uses a sighting taken after the flag clears it", () => {
    const s = solvedStore(join(tmpDir(), "cal.json"));
    s.markFrameUnverified("x");
    s.addSighting({ lat: 33.3, lon: -112.0, height: 5000, panDeg: 120, tiltDeg: 12 });
    expect(s.clearFrameUnverifiedIfResighted(s.get().sightings)).toBe(true);
    expect(s.isFrameUnverified()).toBe(false);
  });

  it("only sightings the solve actually used count", () => {
    const s = solvedStore(join(tmpDir(), "cal.json"));
    s.markFrameUnverified("x");
    s.addSighting({ lat: 33.3, lon: -112.0, height: 5000, panDeg: 120, tiltDeg: 12 });
    expect(s.clearFrameUnverifiedIfResighted(s.get().sightings.slice(0, 1))).toBe(false);
    expect(s.isFrameUnverified()).toBe(true);
  });

  it("a second unverified reference re-arms it: sightings from between the two no longer count", () => {
    const s = solvedStore(join(tmpDir(), "cal.json"));
    s.markFrameUnverified("first");
    s.addSighting({ lat: 33.3, lon: -112.0, height: 5000, panDeg: 120, tiltDeg: 12 });
    s.markFrameUnverified("second");
    expect(s.clearFrameUnverifiedIfResighted(s.get().sightings)).toBe(false);
  });

  it("confirmFrame clears it (the operator says the head did not move)", () => {
    const s = solvedStore(join(tmpDir(), "cal.json"));
    s.markFrameUnverified("x");
    expect(s.confirmFrame()).toBe(true);
    expect(s.isFrameUnverified()).toBe(false);
    expect(s.confirmFrame()).toBe(false);
  });

  it("a new rig location (a fresh calibration) drops it", () => {
    const s = solvedStore(join(tmpDir(), "cal.json"));
    s.markFrameUnverified("x");
    s.setRigLocation(1, 2, 3);
    expect(s.isFrameUnverified()).toBe(false);
  });
});

describe("HeadRefWatch", () => {
  const ref = (pan: "none" | "imu" | "host", ageS: number | null) => ({ pan, persisted: true, ageS });

  it("persists the identity and flags nothing on the very first tick ever", () => {
    const f = join(tmpDir(), "head-ref.json");
    const why: string[] = [];
    const w = new HeadRefWatch(f, (m) => why.push(m));
    w.load();
    w.observe(ref("imu", 10), true, 100_000);
    expect(why).toEqual([]);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ source: "imu", setAtMs: 90_000 });
  });

  it("flags a different source, or a set time more than 5 s off, on the first tick after a connect", () => {
    const f = join(tmpDir(), "head-ref.json");
    writeFileSync(f, JSON.stringify({ source: "imu", setAtMs: 90_000 }));
    for (const [r, now, flagged] of [
      [ref("imu", 10), 100_000, false],     // same identity
      [ref("imu", 14.9), 104_000, false],   // 0.9 s off: tick/rounding jitter
      [ref("imu", 2), 100_000, true],       // re-set 8 s later
      [ref("host", 10), 100_000, true],     // different source
    ] as const) {
      writeFileSync(f, JSON.stringify({ source: "imu", setAtMs: 90_000 }));
      const why: string[] = [];
      const w = new HeadRefWatch(f, (m) => why.push(m));
      w.load();
      w.observe(r, true, now);
      expect(why.length > 0, JSON.stringify(r)).toBe(flagged);
    }
  });

  it("does not flag a change seen on a later tick of the same connection (the event path owns that)", () => {
    const f = join(tmpDir(), "head-ref.json");
    const why: string[] = [];
    const w = new HeadRefWatch(f, (m) => why.push(m));
    w.load();
    w.observe(ref("imu", 10), true, 100_000);
    w.observe(ref("host", 0), false, 200_000);
    expect(why).toEqual([]);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ source: "host", setAtMs: 200_000 });
  });

  it("an unreferenced head is not an identity: nothing compared, nothing written", () => {
    const f = join(tmpDir(), "head-ref.json");
    writeFileSync(f, JSON.stringify({ source: "imu", setAtMs: 90_000 }));
    const why: string[] = [];
    const w = new HeadRefWatch(f, (m) => why.push(m));
    w.load();
    w.observe(ref("none", null), true, 100_000);
    expect(why).toEqual([]);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ source: "imu", setAtMs: 90_000 });
  });

  it("a corrupt file reads as no history", () => {
    const f = join(tmpDir(), "head-ref.json");
    writeFileSync(f, "{nope");
    const why: string[] = [];
    const w = new HeadRefWatch(f, (m) => why.push(m));
    w.load();
    w.observe(ref("imu", 10), true, 100_000);
    expect(why).toEqual([]);
    expect(existsSync(f)).toBe(true);
  });
});

describe("missed-rename detection across a WebSocket drop (FakeHead)", () => {
  let head: FakeHead | null = null;
  let device: Device | null = null;
  afterEach(async () => { device?.close(); device = null; if (head) { await head.stop(); head = null; } });

  async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    if (!pred()) throw new Error("waitFor timed out");
  }

  async function rig() {
    head = new FakeHead();
    head.model.ref = { pan: "imu", persisted: true, ageS: 600 };
    await head.start({ tickMs: 50 });
    const dir = tmpDir();
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: head.url });
    const store = new CalibrationStore(join(dir, "cal.json"), cfg.geoPanSign);
    store.setRigLocation(33.4, -112.1, 341);
    const why: string[] = [];
    const watch = new HeadRefWatch(join(dir, "head-ref.json"), (m) => { why.push(m); store.markFrameUnverified(m); });
    watch.load();
    device = new Device(cfg);
    device.onRefTick((r, first) => watch.observe(r, first, Date.now()));
    device.start();
    await waitFor(() => device!.getState().lastUpdateMs > 0);
    return { store, why };
  }

  it("a reference re-set while disconnected flags the calibration on reconnect", async () => {
    const { store, why } = await rig();
    expect(store.isFrameUnverified()).toBe(false);
    head!.dropClients();
    await waitFor(() => !device!.getState().connected);
    head!.model.ref = { pan: "imu", persisted: true, ageS: 1 };   // re-set ~10 min after the one we knew
    await waitFor(() => store.isFrameUnverified());
    expect(why.join("\n")).toMatch(/while the telemetry link was down|reconnect/i);
  });

  it("the same identity across a reconnect flags nothing", async () => {
    const { store } = await rig();
    head!.dropClients();
    await waitFor(() => !device!.getState().connected);
    await waitFor(() => device!.getState().connected);
    await new Promise((r) => setTimeout(r, 300));   // several ticks after the reconnect
    expect(store.isFrameUnverified()).toBe(false);
  });
});
