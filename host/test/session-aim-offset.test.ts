import { describe, it, expect, beforeEach } from "vitest";
import { Mat3 } from "../src/shared/geo/vec3.js";
import { TrackingSession, type Scheduler } from "../src/shared/track/session.js";
import type { DeviceState } from "../src/shared/types.js";
import type { HeadTrackCmd } from "../src/shared/head-types.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { loadConfig, type Config } from "../src/shared/config.js";
import { MAX_OFFSET_DEG } from "../src/shared/track/offset.js";
import { reachablePanTilt } from "../src/mcp/geo-tools.js";
import { targetAimAt } from "../src/shared/track/control.js";
import { emptyEstimator, withFix } from "../src/shared/track/estimator.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same fixtures as test/session.test.ts (kept local/small rather than shared,
// so this file stands alone): identity R -> pan==azimuth, tilt==elevation.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
// 10km due north, level: pan 0 / tilt ~0 under identity R.
const NORTH = { lat: 45 + 10 / 111.32, lon: 10, height: 0 };

function manualScheduler(): Scheduler & { fire(): void } {
  let fn: (() => void) | null = null;
  return { every(_ms, f) { fn = f; return { cancel() { fn = null; } }; }, fire() { fn?.(); } };
}

class FakeDevice {
  panDeg = 0; tiltDeg = 0; moving = false; estop = false;
  lastUpdateMs = 1_000_000;
  // Every track() call, in order (the head's TRACK; Task 5 servos through it).
  tracks: HeadTrackCmd[] = [];
  stopCalls = 0;
  gotos: { pan: number; tilt: number }[] = [];
  gotoDeferreds: { resolve: () => void; reject: (e: Error) => void }[] = [];
  getState(): DeviceState {
    return {
      connected: true, panDeg: this.panDeg, tiltDeg: this.tiltDeg, zoomDeg: 0, focusDeg: 0,
      moving: this.moving, enabled: true, estop: this.estop, tiltDisagreeDeg: null,
      ref: { pan: "imu", persisted: true, ageS: 0 }, link: { pico: true, imu: true },
      lastUpdateMs: this.lastUpdateMs,
    };
  }
  async track(cmd: HeadTrackCmd) { this.tracks.push(cmd); }
  async gotoAngle(pan: number, tilt: number) {
    this.gotos.push({ pan, tilt });
    return new Promise<void>((resolve, reject) => { this.gotoDeferreds.push({ resolve, reject }); });
  }
  async waitForArrival() { return this.getState(); }
  async stop() { this.stopCalls++; }
}

let clockMs = 1_000_000;
let store: CalibrationStore;
let cfg: Config;
let dev: FakeDevice;
let sched: ReturnType<typeof manualScheduler>;

function newSession(overrideCfg: Partial<Config> = {}): TrackingSession {
  return new TrackingSession(dev as never, { ...cfg, ...overrideCfg }, store, () => clockMs, sched);
}

// Put the session in `tracking`, stationary target due north, rig at pan=0/tilt=0
// (i.e. zero pointing error before any offset is applied).
function tracking(overrideCfg: Partial<Config> = {}): TrackingSession {
  const s = newSession(overrideCfg);
  s.start(NORTH, [0, 0, 0], null);
  s.forceStateForTest("tracking");
  return s;
}

beforeEach(() => {
  clockMs = 1_000_000;
  cfg = loadConfig(undefined, { TB3_TILT_MIN: "-90", TB3_PARK_TILT_DEG: "-20" });
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-offs-")), "cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString());
  dev = new FakeDevice();
  dev.lastUpdateMs = clockMs;
  sched = manualScheduler();
});

// Independently recomputes the zero-offset setpoint and feed-forward:
// targetAimAt -> reachablePanTilt, with NO applyOffset anywhere in the chain.
// This is the reference the offset feature must reduce to exactly at
// offset=(0,0), and must equal baseline + offset otherwise -- NOT a hardcoded
// 0, since a due-north target's tilt is only ever "close to" zero. The offset
// moves the TRACK setpoint (pos) only: it is a constant correction, so it
// contributes no rate of its own and the feed-forward (vel) is unchanged.
function baseline() {
  const est = withFix(emptyEstimator(), RIG, NORTH, clockMs, [0, 0, 0]);
  const aim = targetAimAt(est, I, clockMs + cfg.trackLeadMs, [0, 1, 0], cfg.geoPanSign, {
    panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax,
  })!;
  const reach = reachablePanTilt(aim.panDeg, aim.tiltDeg, cfg.panMin, cfg.panMax, cfg.tiltMin, cfg.tiltMax);
  if ("error" in reach) throw new Error(reach.error);
  return { aim, reach };
}

function lastTrack(): Required<HeadTrackCmd> {
  const t = dev.tracks[dev.tracks.length - 1];
  if (!t?.pan || !t.tilt) throw new Error("expected a two-axis TRACK");
  return t as Required<HeadTrackCmd>;
}

describe("TrackingSession aim-offset — applied to the setpoint", () => {
  it("zero offset is IDENTICAL to the unshifted setpoint (strict extension, pinned)", () => {
    const s = tracking();
    expect(s.getOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
    sched.fire();
    const base = baseline();
    expect(lastTrack().pan.pos).toBeCloseTo(base.reach.pan, 9);
    expect(lastTrack().tilt.pos).toBeCloseTo(base.reach.tilt, 9);
    expect(s.status().commandedPanDps).toBeCloseTo(base.aim.ratePanDps, 9);
    expect(s.status().commandedTiltDps).toBeCloseTo(base.aim.rateTiltDps, 9);
  });

  it("a positive pan offset shifts the TRACK setpoint by exactly the offset, and leaves the feed-forward alone", () => {
    const base = baseline();
    const s = tracking();
    s.nudgeOffset(3, 0);
    expect(s.getOffset().panDeg).toBeCloseTo(3, 9);
    sched.fire();
    expect(lastTrack().pan.pos).toBeCloseTo(base.reach.pan + 3, 6);
    expect(lastTrack().tilt.pos).toBeCloseTo(base.reach.tilt, 6);
    expect(s.status().commandedPanDps).toBeCloseTo(base.aim.ratePanDps, 9);
  });

  it("a negative tilt offset shifts the TRACK setpoint BELOW the zero-offset baseline", () => {
    const base = baseline();
    const s = tracking();
    s.nudgeOffset(0, -2);
    sched.fire();
    expect(lastTrack().tilt.pos).toBeCloseTo(base.reach.tilt - 2, 6);
    expect(lastTrack().tilt.pos).toBeLessThan(base.reach.tilt);
  });

  it("magnitude scales with the offset (not just direction)", () => {
    const s1 = tracking();
    s1.nudgeOffset(1, 0);
    sched.fire();
    const small = lastTrack().pan.pos;

    // Fresh session, same setup, bigger offset.
    dev = new FakeDevice(); dev.lastUpdateMs = clockMs;
    const s2 = tracking();
    s2.nudgeOffset(MAX_OFFSET_DEG, 0);
    sched.fire();
    const big = lastTrack().pan.pos;

    expect(big).toBeGreaterThan(small);
  });

  it("the offset is reported in get status separately from the (unshifted) target angle", () => {
    const s = tracking();
    s.nudgeOffset(1.5, -0.25);
    sched.fire();
    expect(s.status().offsetPanDeg).toBeCloseTo(1.5, 9);
    expect(s.status().offsetTiltDeg).toBeCloseTo(-0.25, 9);
    // targetPanDeg/targetTiltDeg stay the TRUE geometric target (~0,~0 here),
    // not the offset-shifted one -- the offset is a separate, visible number.
    expect(s.status().targetPanDeg).toBeCloseTo(0, 0);
  });
});

describe("TrackingSession aim-offset — clamped, never an unbounded slew", () => {
  it("nudgeOffset clamps at MAX_OFFSET_DEG through the session, same as the pure helper", () => {
    const s = tracking();
    const result = s.nudgeOffset(500, -500);
    expect(result.panDeg).toBe(MAX_OFFSET_DEG);
    expect(result.tiltDeg).toBe(-MAX_OFFSET_DEG);
    // getOffset() returns the bare AimOffset; nudgeOffset() additionally
    // reports the clamp flags, so compare the two fields they share.
    expect(s.getOffset()).toEqual({ panDeg: result.panDeg, tiltDeg: result.tiltDeg });
    expect(result.panClamped).toBe(true);   // it DID ask to go further
    expect(result.tiltClamped).toBe(true);
  });

  it("an absurd nudge does not produce an absurd setpoint — bounded by the SAME clamp a legitimate offset uses", () => {
    const base = baseline();
    const s = tracking();
    s.nudgeOffset(500, 0); // clamps to MAX_OFFSET_DEG internally
    sched.fire();
    // Bounded to baseline + MAX_OFFSET_DEG -- nowhere near the 500° an
    // unclamped offset would have sent the head to.
    expect(lastTrack().pan.pos).toBeCloseTo(base.reach.pan + MAX_OFFSET_DEG, 6);
    expect(s.status().commandedPanDps).toBeCloseTo(base.aim.ratePanDps, 9);
  });
});

describe("TrackingSession aim-offset — resets on a new track", () => {
  it("start() zeroes a standing offset from a previous pass", () => {
    const s = tracking();
    s.nudgeOffset(3, -1);
    expect(s.getOffset()).toEqual({ panDeg: 3, tiltDeg: -1 });

    s.start(NORTH, [0, 0, 0], null); // a fresh track (e.g. a new aircraft)
    expect(s.getOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
  });

  it("clear_aim_offset's underlying method resets explicitly, independent of start()", () => {
    const s = tracking();
    s.nudgeOffset(2, 2);
    s.clearOffset();
    expect(s.getOffset()).toEqual({ panDeg: 0, tiltDeg: 0 });
  });
});

describe("TrackingSession aim-offset — safety: cannot bypass pan/tilt limits", () => {
  it("an offset that pushes the setpoint outside the tilt limit is refused, exactly like an unshifted target would be", () => {
    // tiltMax tight enough that the true target (tilt ~0) is IN range, but
    // target + a 5° offset is OUT of range.
    const s = tracking({ tiltMax: 4 });
    s.nudgeOffset(0, MAX_OFFSET_DEG); // true tilt ~0 + 5 = ~5, past tiltMax=4
    sched.fire();
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("below_tilt_limit");
    expect(dev.tracks).toHaveLength(0);
  });

  it("REGRESSION: the offset genuinely changes the reachability verdict — the unshifted target passes the SAME gate the shifted one fails", () => {
    // Demonstrates the bug this guards against is real, not a tautology:
    // reachablePanTilt (the exact gate session.tick() calls) accepts the true
    // target but rejects target+offset under the same tiltMax=4 limits.
    const limits = { panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: 4 };
    const unshifted = reachablePanTilt(0, 0, limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax);
    const shifted = reachablePanTilt(0, MAX_OFFSET_DEG, limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax);
    expect("error" in unshifted).toBe(false);
    expect("error" in shifted).toBe(true);

    // And the live session (which shifts before checking) lands on the
    // shifted (rejected) branch, not the unshifted (accepted) one.
    const s = tracking({ tiltMax: 4 });
    s.nudgeOffset(0, MAX_OFFSET_DEG);
    sched.fire();
    expect(s.status().state).toBe("waiting");
  });

  it("a reacquire's goto still includes the standing offset — the correction does not disappear across an acquire cycle", () => {
    const s = tracking();
    s.nudgeOffset(2, 0); // a small, legal correction
    // Force a reacquire via a large TRUE pointing error (unrelated to the
    // offset): rig physically far from where it should be.
    dev.panDeg = 90;
    const before = dev.gotos.length;
    sched.fire();
    expect(s.status().state).toBe("acquiring");
    expect(dev.gotos.length).toBe(before + 1);
    // The dispatched goto targets true-pan(0) + offset(2) = ~2, not bare 0.
    expect(dev.gotos[dev.gotos.length - 1].pan).toBeCloseTo(2, 0);
  });
});

describe("TrackingSession aim-offset — safety: E-STOP/stop() still halts motion regardless of offset", () => {
  it("stop() halts the head + cancels the tick even with a large standing offset", () => {
    const s = tracking();
    s.nudgeOffset(MAX_OFFSET_DEG, MAX_OFFSET_DEG);
    sched.fire();
    expect(dev.tracks).toHaveLength(1);

    s.stop(); // what stop_tracking (and the dashboard's E-STOP fan-out) calls

    expect(s.status().state).toBe("stopped");
    expect(dev.stopCalls).toBe(1);
    sched.fire();                              // the tick is cancelled: no more TRACKs
    expect(dev.tracks).toHaveLength(1);
  });
});

// The standing trim (aim-trim-store.ts). Until the calibration fit can solve
// the camera boresight, the operator dials the SAME correction at the start
// of every pass; this makes each pass start from it instead of from zero.
describe("standing aim trim", () => {
  const trim = { panDeg: -1.73, tiltDeg: -2.67 };

  it("a new pass starts from the trim, not from zero", () => {
    const s = new TrackingSession(dev as never, cfg, store, () => clockMs, sched,
      undefined, undefined, () => trim);
    s.start(NORTH, [0, 0, 0], null);
    expect(s.status().offsetPanDeg).toBeCloseTo(-1.73, 6);
    expect(s.status().offsetTiltDeg).toBeCloseTo(-2.67, 6);
  });

  it("nudges apply on TOP of the trim", () => {
    const s = new TrackingSession(dev as never, cfg, store, () => clockMs, sched,
      undefined, undefined, () => trim);
    s.start(NORTH, [0, 0, 0], null);
    s.nudgeOffset(0.5, 0.25);
    expect(s.status().offsetPanDeg).toBeCloseTo(-1.23, 6);
    expect(s.status().offsetTiltDeg).toBeCloseTo(-2.42, 6);
  });

  it("a SECOND pass starts from the trim again, discarding the last pass's nudges", () => {
    const s = new TrackingSession(dev as never, cfg, store, () => clockMs, sched,
      undefined, undefined, () => trim);
    s.start(NORTH, [0, 0, 0], null);
    s.nudgeOffset(2, 2);
    s.start(NORTH, [0, 0, 0], null);
    expect(s.status().offsetPanDeg).toBeCloseTo(-1.73, 6);
    expect(s.status().offsetTiltDeg).toBeCloseTo(-2.67, 6);
  });

  it("clearOffset returns to the trim, not to zero", () => {
    const s = new TrackingSession(dev as never, cfg, store, () => clockMs, sched,
      undefined, undefined, () => trim);
    s.start(NORTH, [0, 0, 0], null);
    s.nudgeOffset(1, 1);
    s.clearOffset();
    expect(s.status().offsetPanDeg).toBeCloseTo(-1.73, 6);
    expect(s.status().offsetTiltDeg).toBeCloseTo(-2.67, 6);
  });

  it("with no trim provider it behaves exactly as before (starts at zero)", () => {
    const s = newSession();
    s.start(NORTH, [0, 0, 0], null);
    expect(s.status().offsetPanDeg).toBe(0);
    expect(s.status().offsetTiltDeg).toBe(0);
  });

  // The trim is read fresh per pass, so set_aim_trim takes effect on the next
  // pass without a daemon restart -- same contract as sector/limits providers.
  it("reads the trim fresh on every pass", () => {
    let live = { panDeg: 0, tiltDeg: 0 };
    const s = new TrackingSession(dev as never, cfg, store, () => clockMs, sched,
      undefined, undefined, () => live);
    s.start(NORTH, [0, 0, 0], null);
    expect(s.status().offsetTiltDeg).toBe(0);
    live = { panDeg: -1, tiltDeg: -2 };
    s.start(NORTH, [0, 0, 0], null);
    expect(s.status().offsetTiltDeg).toBeCloseTo(-2, 6);
  });
});
