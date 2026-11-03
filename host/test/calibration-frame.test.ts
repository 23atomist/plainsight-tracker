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
import { LimitsStore } from "../src/shared/limits-store.js";
import { wireReferenceShift } from "../src/mcp/reference-shift.js";

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

describe("HeadRefWatch (the head's frame id)", () => {
  const A = "00000000000000aa", B = "00000000000000bb";
  const ref = (frameId: string | null, pan: "none" | "imu" | "host" = frameId === null ? "none" : "imu") =>
    ({ pan, persisted: true, ageS: 3, frameId });
  function watch(file: string) {
    const why: string[] = [];
    const w = new HeadRefWatch(file, (m) => why.push(m));
    w.load();
    return { w, why };
  }
  const fileOf = (f: string) => JSON.parse(readFileSync(f, "utf8"));

  it("adopts the frame and flags nothing on the very first tick ever", () => {
    const f = join(tmpDir(), "head-ref.json");
    const { w, why } = watch(f);
    w.observe(ref(A), true);
    expect(why).toEqual([]);
    expect(fileOf(f)).toEqual({ frameId: A });
    expect(w.knownFrameId()).toBe(A);
  });

  it("the same frame on reconnect is not flagged, whatever ageS says (a late reconnect, a head restart)", () => {
    const f = join(tmpDir(), "head-ref.json");
    writeFileSync(f, JSON.stringify({ frameId: A }));
    const { w, why } = watch(f);
    w.observe({ pan: "host", persisted: true, ageS: 99999, frameId: A }, true);
    expect(why).toEqual([]);
  });

  it("a different frame on the first tick after a connect is flagged once, and adopted", () => {
    const f = join(tmpDir(), "head-ref.json");
    writeFileSync(f, JSON.stringify({ frameId: A }));
    const { w, why } = watch(f);
    w.observe(ref(B), true);
    w.observe(ref(B), false);
    w.observe(ref(B), true);
    expect(why).toHaveLength(1);
    expect(why[0]).toMatch(new RegExp(`${A}.*${B}`));
    expect(fileOf(f)).toEqual({ frameId: B });
  });

  it("a frame change mid-connection with no event explaining it is flagged too", () => {
    const f = join(tmpDir(), "head-ref.json");
    const { w, why } = watch(f);
    w.observe(ref(A), true);
    w.observe(ref(B), false);
    expect(why).toHaveLength(1);
  });

  it("a frame the event path accepted first is explained: its ticks flag nothing", () => {
    const f = join(tmpDir(), "head-ref.json");
    const { w, why } = watch(f);
    w.observe(ref(A), true);
    w.acceptFrame(B);
    w.observe(ref(B), false);
    expect(why).toEqual([]);
    expect(fileOf(f)).toEqual({ frameId: B });
  });

  it("an unreferenced tick is skipped and the known frame survives the drop", () => {
    const f = join(tmpDir(), "head-ref.json");
    writeFileSync(f, JSON.stringify({ frameId: A }));
    const { w, why } = watch(f);
    w.observe(ref(null), true);
    expect(fileOf(f)).toEqual({ frameId: A });
    w.observe(ref(A), false);   // the same frame restored
    expect(why).toEqual([]);
  });

  it("a corrupt file, or the old timestamp shape, reads as no history", () => {
    for (const body of ["{nope", JSON.stringify({ source: "imu", setAtMs: 90_000 })]) {
      const f = join(tmpDir(), "head-ref.json");
      writeFileSync(f, body);
      const { w, why } = watch(f);
      w.observe(ref(A), true);
      expect(why).toEqual([]);
      expect(existsSync(f) && fileOf(f)).toEqual({ frameId: A });
    }
  });
});

describe("missed-rename detection against FakeHead", () => {
  let head: FakeHead | null = null;
  let device: Device | null = null;
  afterEach(async () => { device?.close(); device = null; if (head) { await head.stop(); head = null; } });

  async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    if (!pred()) throw new Error("waitFor timed out");
  }

  // The same wiring as server.ts main(): the event path and the tick watch
  // share one frame memory.
  async function rig() {
    head = new FakeHead();
    await head.start({ tickMs: 50 });
    const dir = tmpDir();
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: head.url });
    const store = new CalibrationStore(join(dir, "cal.json"), cfg.geoPanSign);
    store.setRigLocation(33.4, -112.1, 341);
    const limits = new LimitsStore(join(dir, "limits.json"));
    const why: string[] = [];
    const watch = new HeadRefWatch(join(dir, "head-ref.json"), (m) => { why.push(m); store.markFrameUnverified(m); });
    watch.load();
    device = new Device(cfg);
    wireReferenceShift(device, {
      panSign: cfg.panSign, stores: { calibration: store, limits }, frames: watch, log: () => {},
    });
    device.onRefTick((r, first) => watch.observe(r, first));
    device.start();
    await waitFor(() => device!.getState().lastUpdateMs > 0);
    return { store, why, watch };
  }

  async function reconnect(change: () => void): Promise<void> {
    head!.dropClients();
    await waitFor(() => !device!.getState().connected);
    change();
    await waitFor(() => device!.getState().connected);
    await new Promise((r) => setTimeout(r, 300));   // several ticks after the reconnect
  }

  // The reviewer's case: while the host was away the head was renamed (new
  // frame), dropped, and that new frame restored -- no event reached us.
  it("a new frame that appeared while disconnected flags the calibration on reconnect", async () => {
    const { store, why } = await rig();
    expect(store.isFrameUnverified()).toBe(false);
    await reconnect(() => { head!.model.ref = { pan: "imu", persisted: true, ageS: 1, frameId: FakeHead.newFrameId() }; });
    expect(store.isFrameUnverified()).toBe(true);
    expect(why.join("\n")).toMatch(/no pan_reference event the host saw/);
  });

  it("the same frame across a reconnect flags nothing, even with a much younger ageS (a head restart)", async () => {
    const { store } = await rig();
    await reconnect(() => { head!.model.ref = { ...head!.model.ref, ageS: 0 }; });
    expect(store.isFrameUnverified()).toBe(false);
  });

  it("a live set_position is explained by its event before any tick carries the new frame", async () => {
    const { store, watch } = await rig();
    await device!.setPos({ pan: 90 });
    await waitFor(() => device!.getState().ref.frameId === head!.model.ref.frameId);
    await new Promise((r) => setTimeout(r, 300));
    expect(watch.knownFrameId()).toBe(head!.model.ref.frameId);
    expect(store.isFrameUnverified()).toBe(false);   // previous was known: a shift, not a flag
  });
});
