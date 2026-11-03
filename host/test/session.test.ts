import { describe, it, expect, beforeEach } from "vitest";
import { Mat3, Vec3 } from "../src/shared/geo/vec3.js";
import { TrackingSession, COAST_ENTER_MS, type Scheduler } from "../src/shared/track/session.js";
import type { DeviceState } from "../src/shared/types.js";
import type { HeadAxisConfig, HeadTrackCmd } from "../src/shared/head-types.js";
import { Device, DeviceHttpError } from "../src/shared/device.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { loadConfig, type Config } from "../src/shared/config.js";
import { targetAimAt } from "../src/shared/track/control.js";
import { emptyEstimator, withFix } from "../src/shared/track/estimator.js";
import { reachablePanTilt } from "../src/mcp/geo-tools.js";
import { FakeHead } from "./fake-head.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
// 10km due north, level: pan 0 / tilt ~0 under identity R.
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };

// A point ~distM from the rig at compass bearing bearingDeg (flat-earth
// approx, same one NORTH above already relies on -- fine at this range).
// Under identity R, pan == azimuth, so this gives direct control over the
// target's pan angle without hand-solving geodesy.
function bearingTarget(bearingDeg: number, distM = 10000): typeof RIG {
  const brg = (bearingDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(brg)) / 111320;
  const dLon = (distM * Math.sin(brg)) / (111320 * Math.cos((RIG.lat * Math.PI) / 180));
  return { lat: RIG.lat + dLat, lon: RIG.lon + dLon, height: 0 };
}

// The ENU velocity (m/s) that sweeps a target at bearingDeg toward a LARGER
// azimuth (clockwise), i.e. toward panMax under identity R.
function clockwiseVel(bearingDeg: number, speedMs: number): Vec3 {
  const brg = (bearingDeg * Math.PI) / 180;
  return [speedMs * Math.cos(brg), -speedMs * Math.sin(brg), 0];
}

// A hand-driven scheduler: tests call fire() instead of waiting.
function manualScheduler(): Scheduler & { fire(): void; cancelled(): boolean } {
  let fn: (() => void) | null = null;
  let cancelledFlag = false;
  return {
    every(_ms, f) { fn = f; return { cancel() { fn = null; cancelledFlag = true; } }; },
    fire() { fn?.(); },
    cancelled() { return cancelledFlag; },
  };
}

interface Deferred {
  resolve: () => void;
  reject: (err: Error) => void;
}

class FakeDevice {
  panDeg = 0; tiltDeg = 0; moving = false; estop = false;
  // ref.pan: "none" means the head lost pan's zero (Pico reboot, ENABLE 0).
  refPan: "none" | "imu" | "host" = "imu";
  lastUpdateMs = 1_000_000;
  // Every track() call, in order (the head's TRACK).
  tracks: HeadTrackCmd[] = [];
  // Every stop() call's axes argument, in order (undefined = all axes).
  stops: (string[] | undefined)[] = [];
  get stopCalls(): number { return this.stops.length; }
  gotos: { pan: number; tilt: number }[] = [];
  // Each gotoAngle() call parks a deferred here instead of resolving
  // immediately, so tests can drive the goto's settlement (and its timing
  // relative to gate trips / re-start()) by hand.
  gotoDeferreds: Deferred[] = [];
  // Set to make the arrival wait fail, which is where a real goto TIMEOUT comes
  // from. It matters that this is separate from a gotoAngle rejection:
  // moveToUserAngle only wraps the latter, so the two arrive at the session's
  // .catch() in genuinely different shapes.
  arrivalError: Error | null = null;
  getState(): DeviceState {
    return {
      connected: true, panDeg: this.panDeg, tiltDeg: this.tiltDeg, zoomDeg: 0, focusDeg: 0,
      moving: this.moving, enabled: true, estop: this.estop, tiltDisagreeDeg: null,
      ref: { pan: this.refPan, persisted: true, ageS: 0, frameId: "00000000000000a1" }, link: { pico: true, imu: true },
      lastUpdateMs: this.lastUpdateMs,
    };
  }
  async track(cmd: HeadTrackCmd) { this.tracks.push(cmd); }
  async gotoAngle(pan: number, tilt: number) {
    this.gotos.push({ pan, tilt });
    return new Promise<void>((resolve, reject) => {
      this.gotoDeferreds.push({ resolve, reject });
    });
  }
  async waitForArrival() {
    if (this.arrivalError) throw this.arrivalError;
    return this.getState();
  }
  async stop(axes?: string[]) { this.stops.push(axes); }
}

// Drains the microtask queue (and any already-due macrotasks) so a resolved
// gotoDeferred's continuation -- moveToUserAngle's remaining awaits, then
// beginAcquire's .then()/.catch() -- has actually run before assertions.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let clockMs = 1_000_000;
let store: CalibrationStore;
let cfg: Config;
let dev: FakeDevice;
let sched: ReturnType<typeof manualScheduler>;

type AxisConfig = Record<"pan" | "tilt", HeadAxisConfig>;

function newSession(c: Config = cfg, axisConfig: AxisConfig | null = null): TrackingSession {
  return new TrackingSession(
    dev as never, c, store, () => clockMs, sched,
    undefined, undefined, undefined, undefined, () => axisConfig,
  );
}

// What the session must compute for a target started at clockMs, recomputed
// here independently of the session (same estimator, same lead, same limits).
function expectedAim(target: typeof RIG, vel: Vec3, c: Config = cfg) {
  const est = withFix(emptyEstimator(), RIG, target, clockMs, vel);
  const limits = { panMin: c.panMin, panMax: c.panMax, tiltMin: c.tiltMin, tiltMax: c.tiltMax };
  const aim = targetAimAt(est, I, clockMs + c.trackLeadMs, [0, 1, 0], c.geoPanSign, limits)!;
  const reach = reachablePanTilt(aim.panDeg, aim.tiltDeg, c.panMin, c.panMax, c.tiltMin, c.tiltMax);
  if ("error" in reach) throw new Error(reach.error);
  return { aim, reach };
}

beforeEach(() => {
  clockMs = 1_000_000;
  cfg = loadConfig(undefined, { TB3_TILT_MIN: "-90", TB3_PARK_TILT_DEG: "-20" });
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sess-")), "cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString());
  dev = new FakeDevice();
  dev.lastUpdateMs = clockMs;
  sched = manualScheduler();
});

describe("TrackingSession lifecycle", () => {
  it("starts stopped", () => {
    expect(newSession().status().state).toBe("stopped");
  });

  it("refuses to start without a calibration", () => {
    store.clear();
    const s = newSession();
    expect(s.start(NORTH, null, null)).toMatch(/calibrat/i);
    expect(s.status().state).toBe("stopped");
  });

  it("start enters acquiring and issues a goto", () => {
    const s = newSession();
    expect(s.start(NORTH, null, null)).toBeNull();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(1);
    expect(dev.gotos[0].pan).toBeCloseTo(0, 1);
  });

  it("stop halts the head exactly once and cancels the tick", () => {
    const s = newSession();
    s.start(NORTH, null, null);
    s.stop();
    expect(s.status().state).toBe("stopped");
    expect(dev.stops).toEqual([undefined]);   // all axes
    expect(sched.cancelled()).toBe(true);
    s.stop();                                  // nothing is moving any more
    expect(dev.stopCalls).toBe(1);
  });
});

describe("TrackingSession servo: the head's TRACK", () => {
  // Put the session in `tracking`, pointing straight at the target.
  function trackingAt(target: typeof RIG, vel: Vec3, c: Config = cfg, axisConfig: AxisConfig | null = null) {
    const s = newSession(c, axisConfig);
    s.start(target, vel, null);
    s.forceStateForTest("tracking");
    const { aim, reach } = expectedAim(target, vel, c);
    dev.panDeg = reach.pan * c.panSign;
    dev.tiltDeg = reach.tilt * c.tiltSign;
    return { s, aim, reach };
  }

  it("tracking sends TRACK with reach setpoint and aim feedforward every tick", () => {
    // pan_sign -1: the device frame is mirrored, and BOTH pos and vel must
    // cross the boundary with the sign applied.
    const c = { ...cfg, panSign: -1 as const };
    const { aim, reach } = trackingAt(NORTH, [120, 0, 0], c);
    expect(Math.abs(aim.ratePanDps)).toBeGreaterThan(0.5);   // a genuinely moving target

    sched.fire();
    expect(dev.tracks).toHaveLength(1);
    expect(dev.tracks[0]).toEqual({
      pan: { pos: expect.closeTo(-reach.pan, 9), vel: expect.closeTo(-aim.ratePanDps, 9) },
      tilt: { pos: expect.closeTo(reach.tilt, 9), vel: expect.closeTo(aim.rateTiltDps, 9) },
    });

    sched.fire();
    expect(dev.tracks).toHaveLength(2);
  });

  it("tilt_sign -1 mirrors the TRACK tilt setpoint and feed-forward", () => {
    // A climbing target 2km up: a real tilt and a real tilt rate to mirror.
    const climbing = { ...NORTH, height: 2000 };
    const c = { ...cfg, tiltSign: -1 as const };
    const { aim, reach } = trackingAt(climbing, [0, 0, 100], c);
    expect(reach.tilt).toBeGreaterThan(5);
    expect(Math.abs(aim.rateTiltDps)).toBeGreaterThan(0.1);

    sched.fire();
    expect(dev.tracks[0]).toEqual({
      pan: { pos: expect.closeTo(reach.pan, 9), vel: expect.closeTo(aim.ratePanDps, 9) },
      tilt: { pos: expect.closeTo(-reach.tilt, 9), vel: expect.closeTo(-aim.rateTiltDps, 9) },
    });
  });

  it("status reports the feed-forward rates actually sent, in the user frame", () => {
    const c = { ...cfg, panSign: -1 as const };
    const { s, aim } = trackingAt(NORTH, [120, 0, 0], c);
    sched.fire();
    expect(s.status().commandedPanDps).toBeCloseTo(aim.ratePanDps, 9);
    expect(s.status().commandedTiltDps).toBeCloseTo(aim.rateTiltDps, 9);
  });

  it("clamps the feed-forward to the head's vmax when the axis config is known", () => {
    const axisConfig: AxisConfig = {
      pan: { min: -180, max: 180, vmax: 0.25, amax: 10 },
      tilt: { min: -90, max: 90, vmax: 0.25, amax: 10 },
    };
    const { s, aim } = trackingAt(NORTH, [120, 0, 0], cfg, axisConfig);
    expect(aim.ratePanDps).toBeGreaterThan(0.25);
    sched.fire();
    expect(dev.tracks[0].pan!.vel).toBe(0.25);
    expect(s.status().commandedPanDps).toBe(0.25);
  });

  it("clamps the feed-forward to maxJogDps while the axis config is unknown", () => {
    // ~1km out at 400 m/s: ~23 deg/s of azimuth rate, past the 19 deg/s cap.
    const { s, aim } = trackingAt(bearingTarget(0, 1000), [400, 0, 0]);
    expect(aim.ratePanDps).toBeGreaterThan(cfg.maxJogDps);
    sched.fire();
    expect(dev.tracks[0].pan!.vel).toBe(cfg.maxJogDps);
    expect(s.status().commandedPanDps).toBe(cfg.maxJogDps);
  });

  it("no TRACK is sent while waiting", () => {
    const { s } = trackingAt(NORTH, [0, 0, 0]);
    dev.estop = true;
    for (let i = 0; i < 5; i++) sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(dev.tracks).toHaveLength(0);
  });

  it("no TRACK is sent while acquiring", () => {
    const s = newSession();
    s.start(NORTH, [0, 0, 0], null);
    for (let i = 0; i < 5; i++) sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.tracks).toHaveLength(0);
  });
});

describe("TrackingSession safety gates", () => {
  // Put the session in `tracking` with a stationary target due north.
  // Signature is start(target, statedVelocity, label).
  function tracking(): TrackingSession {
    const s = newSession();
    s.start(NORTH, [0, 0, 0], null);
    s.forceStateForTest("tracking");
    return s;
  }

  it("stops and waits on stale telemetry", () => {
    const s = tracking();
    dev.lastUpdateMs = clockMs - (cfg.trackStaleTelemetryMs + 1);
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("telemetry_stale");
    expect(dev.tracks).toHaveLength(0);
    expect(dev.stopCalls).toBe(1);
  });

  it("a tick without axes makes telemetry stale and the session waits", async () => {
    // Against the real Device and FakeHead: while the Pico link is down the
    // head keeps publishing IMU-only ticks. They must NOT count as fresh
    // telemetry, or the session would servo on a frozen position.
    const head = new FakeHead();
    await head.start({ tickMs: 0 });
    const c = loadConfig(undefined, { TB3_HEAD_URL: head.url, TB3_TILT_MIN: "-90", TB3_PARK_TILT_DEG: "-20" });
    const device = new Device(c, () => clockMs);
    device.start();
    const s = new TrackingSession(device, c, store, () => clockMs, sched);
    try {
      await waitFor(() => device.getState().lastUpdateMs === clockMs);
      const lastAxesTickMs = clockMs;
      s.start(NORTH, [0, 0, 0], null);
      s.forceStateForTest("tracking");

      clockMs += c.trackStaleTelemetryMs + 1;
      head.model.link.pico = false;
      head.tickNoAxes();
      await waitFor(() => device.getState().link.pico === false);
      expect(device.getState().lastUpdateMs).toBe(lastAxesTickMs);

      sched.fire();
      expect(s.status().state).toBe("waiting");
      expect(s.status().reason).toBe("telemetry_stale");
      expect(head.lastTrack).toBeNull();
    } finally {
      s.stop();
      device.close();
      await head.stop();
    }
  });

  it("stops and waits on a stale target fix", () => {
    const s = tracking();
    clockMs += cfg.trackMaxTargetAgeMs + 1;
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("target_stale");
    expect(dev.tracks).toHaveLength(0);
    expect(dev.stopCalls).toBe(1);
  });

  it("head estop puts the session in waiting with reason estop", () => {
    const s = tracking();
    dev.estop = true;
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("estop");
    expect(dev.tracks).toHaveLength(0);
    expect(dev.stopCalls).toBe(1);
  });

  it("waits when the target is below the tilt limit", () => {
    // A target 10km north but 5km BELOW the rig sits at elevation ~ -26deg,
    // outside a tiltMin of -5.
    const tightCfg = { ...cfg, tiltMin: -5 };
    const s = new TrackingSession(dev as never, tightCfg, store, () => clockMs, sched);
    s.start({ lat: 45 + 10 / 111.32, lon: 10, height: -5000 }, [0, 0, 0], null);
    s.forceStateForTest("tracking");
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("below_tilt_limit");
    expect(dev.tracks).toHaveLength(0);
  });

  it("the deadman ends the session outright", () => {
    const s = tracking();
    clockMs += cfg.trackDeadmanMs + 1;
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().state).toBe("stopped");
    expect(dev.stopCalls).toBe(1);
  });

  it("auto-reacquires when a waiting target becomes reachable again", () => {
    const s = tracking();
    dev.estop = true;
    sched.fire();
    expect(s.status().state).toBe("waiting");

    dev.estop = false;
    dev.lastUpdateMs = clockMs;
    s.updateTarget(NORTH, null);   // refresh the fix
    const before = dev.gotos.length;
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
  });

  it("drops back to acquiring when the pointing error is large", () => {
    const s = tracking();
    dev.panDeg = 90;    // 90 deg off target
    const before = dev.gotos.length;
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
    expect(dev.tracks).toHaveLength(0);
    // The head retargets an accepted goto (it replaces the TRACK), so nothing
    // is stopped first.
    expect(dev.stopCalls).toBe(0);
  });

  it("reports pointing error in status", () => {
    const s = tracking();
    dev.panDeg = 3;
    sched.fire();
    expect(s.status().pointingErrorDeg).toBeCloseTo(3, 0);
  });
});

describe("TrackingSession goto cancellation (generation stamp)", () => {
  it("promotes to tracking when the in-flight goto genuinely resolves", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotoDeferreds.length).toBe(1);

    dev.gotoDeferreds[0].resolve();
    await flush();

    expect(s.status().state).toBe("tracking");
  });

  it("ignores a stale goto's late resolution once a re-start() has superseded it", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    expect(dev.gotoDeferreds.length).toBe(1);
    const stale = dev.gotoDeferreds[0];

    // A second start() arrives while the first goto is still in flight. It
    // must abandon the stale attempt (generation bump) and issue a fresh
    // goto. No stop: the head retargets an accepted goto.
    s.start(NORTH, null, null);
    expect(dev.stopCalls).toBe(0);
    expect(dev.gotoDeferreds.length).toBe(2);
    expect(s.status().state).toBe("acquiring");

    stale.resolve();
    await flush();

    // The stale resolution belongs to a superseded generation: it must not
    // have promoted the session (the fresh goto is still unresolved).
    expect(s.status().state).toBe("acquiring");
  });

  it("cancels the in-flight goto (device.stop() exactly once) when a gate trips during acquire", () => {
    const s = newSession();
    s.start(NORTH, null, null);
    expect(s.status().state).toBe("acquiring");
    expect(dev.stopCalls).toBe(0);

    dev.estop = true;
    sched.fire();

    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("estop");
    expect(dev.stopCalls).toBe(1);

    // Edge-triggered: further waiting ticks send nothing.
    sched.fire();
    sched.fire();
    expect(dev.stopCalls).toBe(1);
  });

  it("a gate trip while tracking stops the head once, not on every waiting tick", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    dev.gotoDeferreds[0].resolve();
    await flush();
    expect(s.status().state).toBe("tracking");
    sched.fire();
    expect(dev.tracks).toHaveLength(1);
    await flush();

    dev.estop = true;
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(dev.stopCalls).toBe(1);

    sched.fire();
    sched.fire();
    await flush();
    expect(dev.stopCalls).toBe(1);
  });
});

// The ESP32 refused a goto while motorMoving was set (a 409), so the session
// used to sit in a busy wait for the rig to come to rest before every
// reacquire. The head accepts a goto while moving and retargets, so that dance
// is gone.
// Spec 6.8 rule 2: with pan's origin unknown, the host has no idea where the
// camera points, so no automated motion may run -- but the operator's manual
// jog/goto must keep working, they are how pan gets re-referenced.
describe("TrackingSession: pan unreferenced", () => {
  it("ref.pan none mid-track stops motion once and waits with pan_unreferenced; it resumes when re-referenced", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    dev.gotoDeferreds[0].resolve();
    await flush();
    sched.fire();
    expect(s.status().state).toBe("tracking");
    expect(dev.tracks).toHaveLength(1);

    dev.refPan = "none";
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("pan_unreferenced");
    expect(dev.stopCalls).toBe(1);
    sched.fire();
    sched.fire();
    expect(dev.stopCalls).toBe(1);          // edge-triggered: one STOP, not one per tick
    expect(dev.tracks).toHaveLength(1);     // and no TRACK while unreferenced
    expect(dev.gotos).toHaveLength(1);      // nor a reacquire goto

    dev.refPan = "host";
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos).toHaveLength(2);
    s.stop();
  });

  it("an unverified calibration frame holds the session exactly like an unreferenced pan", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    dev.gotoDeferreds[0].resolve();
    await flush();
    sched.fire();
    expect(s.status().state).toBe("tracking");

    store.markFrameUnverified("test");
    sched.fire();
    sched.fire();
    expect(s.status().reason).toBe("calibration_unverified");
    expect(dev.stopCalls).toBe(1);
    expect(dev.tracks).toHaveLength(1);
    expect(s.automationBlock()).toBe("calibration_unverified");

    store.confirmFrame();
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    s.stop();
  });

  it("start() with an unverified frame issues no acquire goto; pan_unreferenced wins when both hold", () => {
    store.markFrameUnverified("test");
    const s = newSession();
    s.start(NORTH, null, null);
    expect(dev.gotos).toHaveLength(0);
    expect(s.status().reason).toBe("calibration_unverified");
    dev.refPan = "none";
    sched.fire();
    expect(s.status().reason).toBe("pan_unreferenced");
    s.stop();
  });

  it("start() while unreferenced issues no acquire goto and waits with pan_unreferenced", () => {
    dev.refPan = "none";
    const s = newSession();
    expect(s.start(NORTH, null, null)).toBeNull();
    expect(dev.gotos).toHaveLength(0);
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("pan_unreferenced");
    expect(s.panReferenced()).toBe(false);
    s.stop();
  });

  it("against the head: the session holds while unreferenced, and a manual jog and goto still reach the head", async () => {
    const head = new FakeHead();
    await head.start({ tickMs: 0 });
    const c = loadConfig(undefined, { TB3_HEAD_URL: head.url, TB3_TILT_MIN: "-90", TB3_PARK_TILT_DEG: "-20" });
    const device = new Device(c, () => clockMs);
    device.start();
    const s = new TrackingSession(device, c, store, () => clockMs, sched);
    try {
      await waitFor(() => device.getState().lastUpdateMs === clockMs);
      head.model.ref = { pan: "none", persisted: false, ageS: null, frameId: null };
      head.tick();
      await waitFor(() => device.getState().ref.pan === "none");

      expect(s.start(NORTH, [0, 0, 0], null)).toBeNull();
      sched.fire();
      expect(s.status().reason).toBe("pan_unreferenced");
      await flush();
      expect(head.gotoCount).toBe(0);
      expect(head.lastTrack).toBeNull();

      // Manual motion is the operator's way back to a reference: never gated.
      await device.gotoAngle(12, 8);
      expect(head.gotoCount).toBe(1);
      await device.jog(3, 0, 120);
      expect(head.calls.some((call) => call.path === "/api/jog")).toBe(true);
    } finally {
      s.stop();
      device.close();
      await head.stop();
    }
  });
});

describe("TrackingSession reacquire on the head", () => {
  function trackingWithError(): TrackingSession {
    const s = newSession();
    s.start(NORTH, [0, 0, 0], null);
    s.forceStateForTest("tracking");
    dev.panDeg = 90;   // 90 deg off: well past trackReacquireDeg
    return s;
  }

  it("no busy wait: a goto is issued while the head reports moving", () => {
    const s = trackingWithError();
    dev.moving = true;
    const before = dev.gotos.length;

    sched.fire();

    expect(s.status().state).toBe("acquiring");
    expect(s.status().reason).toBeNull();
    expect(dev.gotos.length).toBe(before + 1);
  });

  it("a refused goto reports goto_failed, not telemetry_stale", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    expect(s.status().state).toBe("acquiring");

    dev.gotoDeferreds[0].reject(new DeviceHttpError("injected failure 409", 409));
    await flush();

    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("goto_failed");
    // Telemetry is perfectly healthy here; saying otherwise sends the operator
    // hunting a network fault that does not exist.
    expect(s.status().telemetryAgeMs).toBe(0);
  });

  it("a goto that times out reports goto_failed, still not telemetry_stale", async () => {
    const s = newSession();
    s.start(NORTH, null, null);

    // A real timeout surfaces from waitForArrival, not from the POST: the rig
    // accepted the goto and then never arrived. Distinct cause, same reason.
    dev.arrivalError = new Error("goto timed out after 5000ms at pan=1.00° tilt=0.00°");
    dev.gotoDeferreds[0].resolve();
    await flush();

    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("goto_failed");
  });

  it("recovers on the next tick after a refused goto (the churn is bounded, not a wedge)", async () => {
    const s = newSession();
    s.start(NORTH, null, null);
    dev.gotoDeferreds[0].reject(new DeviceHttpError("injected failure 503", 503));
    await flush();
    expect(s.status().reason).toBe("goto_failed");

    s.updateTarget(NORTH, null);
    const before = dev.gotos.length;
    sched.fire();

    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
  });
});

// limitGuard() (src/track/control.ts) zeroes a blocked axis and returns
// panBlocked/tiltBlocked. A held axis must be visible: state stays
// "tracking", reason stays null, and only commanded_*_dps / *Limited say why
// the rig is not following. And a block is a STOP of that axis on the head,
// not a clamped TRACK: the Pico extrapolates a TRACK, so anything but a stop
// would keep it moving toward the limit.
describe("TrackingSession limit guard", () => {
  // panMax 30, target at bearing 28 sweeping clockwise at ~1.15 deg/s.
  // Horizon at 200ms telemetry age: 200 + 100 (tick) + 115 (stop at amax 10)
  // = 415ms, ~0.48 deg. Rig at 29.6 predicts 30.08: past panMax, blocked.
  // Rig at 28.2 predicts 28.68: fine.
  const c = (): Config => ({ ...cfg, panMax: 30 });
  const BLOCKED_PAN = 29.6;
  const FREE_PAN = 28.2;

  function nearLimit(axisConfig: AxisConfig | null = null): TrackingSession {
    const s = newSession(c(), axisConfig);
    s.start(bearingTarget(28), clockwiseVel(28, 200), null);
    s.forceStateForTest("tracking");
    return s;
  }
  function tickAt(panDeg: number): void {
    dev.panDeg = panDeg;
    dev.lastUpdateMs = clockMs - 200;   // realistic telemetry lag, not stale
    sched.fire();
  }

  it("REGRESSION: a guard-blocked axis is surfaced in status(), not discarded", () => {
    const s = nearLimit();
    tickAt(BLOCKED_PAN);

    expect(s.status().state).toBe("tracking");
    expect(s.status().reason).toBeNull();
    expect(s.status().commandedPanDps).toBe(0);
    expect(s.status().panLimited).toBe(true);
    // The tilt axis is nowhere near its limit and must not be swept in.
    expect(s.status().tiltLimited).toBe(false);
  });

  it("a blocked axis sends stop once and reports commanded 0 until unblocked", async () => {
    const s = nearLimit();
    tickAt(BLOCKED_PAN);
    expect(dev.stops).toEqual([["pan"]]);
    // The tilt axis keeps tracking; pan is left out of the TRACK entirely.
    expect(dev.tracks).toHaveLength(1);
    expect(dev.tracks[0].pan).toBeUndefined();
    expect(dev.tracks[0].tilt).toBeDefined();
    await flush();

    tickAt(BLOCKED_PAN);
    tickAt(BLOCKED_PAN);
    await flush();
    expect(dev.stops).toEqual([["pan"]]);          // once per block edge
    expect(dev.tracks.every((t) => t.pan === undefined)).toBe(true);
    expect(s.status().commandedPanDps).toBe(0);

    tickAt(FREE_PAN);                                // unblocked
    expect(dev.tracks[dev.tracks.length - 1].pan).toBeDefined();
    expect(s.status().commandedPanDps).toBeGreaterThan(1);
    expect(s.status().panLimited).toBe(false);
    await flush();

    tickAt(BLOCKED_PAN);                             // a fresh edge
    expect(dev.stops).toEqual([["pan"], ["pan"]]);
  });

  it("a block stops a STANDING TRACK on the same tick (a stop, not a ramp)", () => {
    const s = nearLimit();
    tickAt(FREE_PAN);
    const standing = dev.tracks[dev.tracks.length - 1].pan!;
    expect(standing.vel).toBeGreaterThan(1);         // the setup really armed it

    tickAt(BLOCKED_PAN);
    expect(dev.stops).toEqual([["pan"]]);
    expect(s.status().commandedPanDps).toBe(0);
  });

  it("the horizon uses the head's amax: a gentler amax blocks earlier", () => {
    // Rig at 27.5: with amax 10 the prediction is ~27.98 (free); with amax
    // 0.5 stopping alone takes ~2.3s, predicting ~30.5 (blocked).
    const gentle: AxisConfig = {
      pan: { min: -180, max: 180, vmax: 5, amax: 0.5 },
      tilt: { min: -90, max: 90, vmax: 5, amax: 0.5 },
    };
    const fallback = nearLimit();
    tickAt(27.5);
    expect(fallback.status().panLimited).toBe(false);
    fallback.stop();

    dev = new FakeDevice();
    const s = nearLimit(gentle);
    tickAt(27.5);
    expect(s.status().panLimited).toBe(true);
  });

  it("without the head's config the horizon uses trackFallbackAmaxDps2", () => {
    const s = newSession({ ...c(), trackFallbackAmaxDps2: 0.5 });
    s.start(bearingTarget(28), clockwiseVel(28, 200), null);
    s.forceStateForTest("tracking");
    tickAt(27.5);
    expect(s.status().panLimited).toBe(true);
  });

  it("panLimited/tiltLimited reset once motion stops", () => {
    const s = nearLimit();
    tickAt(BLOCKED_PAN);
    expect(s.status().panLimited).toBe(true);

    s.stop();

    expect(s.status().panLimited).toBe(false);
    expect(s.status().tiltLimited).toBe(false);
  });
});

// Dropout resilience: the estimator coasts on prediction after the newest
// accepted fix, so brief ADS-B dropouts must NOT freeze the rig (the old
// behavior), and re-served stale positions must NOT look like freshness.
describe("TrackingSession dropout coasting", () => {
  function tracking(): TrackingSession {
    const s = newSession();
    s.start(NORTH, [0, 0, 0], null);
    s.forceStateForTest("tracking");
    return s;
  }

  it("keeps commanding motion well past the last fix, then yields at the budget", () => {
    const s = tracking();
    // 11s of silence: under the 12s default coast budget. The servo must
    // still be driving on the predicted aim.
    clockMs += 11_000;
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().state).toBe("tracking");
    expect(dev.tracks.length).toBeGreaterThan(0);

    // Past the budget, the hard stop still applies.
    clockMs += 1_500;
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("target_stale");
    expect(dev.stopCalls).toBe(1);
  });

  it("reports coasting in status once the newest accepted fix ages past ~two reports", () => {
    const s = tracking();
    sched.fire();
    expect(s.status().coasting).toBe(false);

    clockMs += COAST_ENTER_MS + 500;
    dev.lastUpdateMs = clockMs;   // keep TELEMETRY fresh; only the fix ages
    sched.fire();
    expect(s.status().coasting).toBe(true);
    // Coasting is informational -- the servo is (correctly) still driving.
    expect(s.status().state).toBe("tracking");
  });

  it("REGRESSION: a re-served identical position does not reset the staleness clock", () => {
    const s = tracking();
    // The decoder keeps listing the aircraft with the SAME lat/lon and a
    // growing seen_pos through a dropout. updateTarget stamps by true fix
    // age, but the estimator must reject the position-repeat outright --
    // otherwise "freshness" would be manufactured from stale data forever
    // and the coast budget could never expire.
    clockMs += 6_000;
    s.updateTarget(NORTH, null);   // identical position to start()'s fix
    expect(s.status().targetAgeMs).toBeGreaterThan(5_000);

    clockMs += 6_500;   // total 12.5s since the only real fix
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().reason).toBe("target_stale");
  });

  it("a genuinely moved position DOES refresh the staleness clock", () => {
    const s = tracking();
    clockMs += 6_000;
    // ~300m East in 6s: a real report (well inside the estimator's outlier
    // gate -- the old [0,0,0] model allows up to its 500m floor here), not a
    // re-serve.
    const moved = { lat: NORTH.lat, lon: NORTH.lon + 300 / (111_320 * Math.cos((45 * Math.PI) / 180)), height: 0 };
    s.updateTarget(moved, [50, 0, 0]);
    expect(s.status().targetAgeMs).toBeLessThan(100);

    clockMs += 11_000;
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().state).toBe("tracking");   // budget measured from the NEW fix
  });
});

