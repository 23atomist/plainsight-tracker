import { describe, it, expect } from "vitest";
import { Mat3, Vec3 } from "../src/shared/geo/vec3.js";
import {
  wrapDeg180, boresightEnu, targetAimAt, limitGuard, limitHorizonMs,
} from "../src/shared/track/control.js";
import { emptyEstimator, withFix } from "../src/shared/track/estimator.js";
import { enuToPanTiltOffsetAll } from "../src/shared/geo/imu-orientation.js";

// Identity R means the mount frame IS the ENU frame, so pan == azimuth and
// tilt == elevation. That makes every expectation below hand-checkable.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
const LIMITS = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };

describe("wrapDeg180", () => {
  it("leaves in-range angles alone", () => {
    expect(wrapDeg180(0)).toBe(0);
    expect(wrapDeg180(179)).toBe(179);
    expect(wrapDeg180(-179)).toBe(-179);
  });
  it("wraps the short way across the seam", () => {
    expect(wrapDeg180(358)).toBeCloseTo(-2, 9);
    expect(wrapDeg180(-358)).toBeCloseTo(2, 9);
    expect(wrapDeg180(540)).toBeCloseTo(180, 9);
  });
});

describe("boresightEnu", () => {
  it("under identity R, pan 0/tilt 0 points due North", () => {
    const u = boresightEnu(I, 0, 0);
    expect(u[0]).toBeCloseTo(0, 9);
    expect(u[1]).toBeCloseTo(1, 9);
    expect(u[2]).toBeCloseTo(0, 9);
  });
  it("under identity R, pan 90 points due East", () => {
    const u = boresightEnu(I, 90, 0);
    expect(u[0]).toBeCloseTo(1, 9);
    expect(u[1]).toBeCloseTo(0, 9);
    expect(u[2]).toBeCloseTo(0, 9);
  });
});

describe("targetAimAt", () => {
  it("returns null with no fix", () => {
    expect(targetAimAt(emptyEstimator(), I, 1000)).toBeNull();
  });

  it("aims North at a stationary target due north, with zero rate", () => {
    // 10km north, level with the rig.
    const s = withFix(emptyEstimator(), RIG, { lat: 45 + 10 / 111.32, lon: 10, height: 0 }, 1000, [0, 0, 0]);
    const aim = targetAimAt(s, I, 1000)!;
    expect(aim.panDeg).toBeCloseTo(0, 3);
    expect(aim.ratePanDps).toBeCloseTo(0, 6);
    expect(aim.rateTiltDps).toBeCloseTo(0, 6);
    expect(aim.rangeM).toBeGreaterThan(9000);
  });

  it("feedforward matches the analytic rate for a crossing target", () => {
    // 1000m due north, flying East at 100 m/s, level. At the crossing point the
    // line of sight is 1000m and fully perpendicular to velocity, so the
    // angular rate is v/r = 100/1000 = 0.1 rad/s = 5.7296 deg/s, increasing
    // azimuth (turning from North toward East).
    const s = withFix(emptyEstimator(), RIG, { lat: 45 + 1 / 111.32, lon: 10, height: 0 }, 1000, [100, 0, 0]);
    const aim = targetAimAt(s, I, 1000)!;
    expect(aim.ratePanDps).toBeCloseTo((100 / 1000) * (180 / Math.PI), 1);
  });

  it("returns null when the target is at essentially the rig location", () => {
    // Target at the same location as the rig; ENU position is ~zero, below MIN_RANGE_M.
    const s = withFix(emptyEstimator(), RIG, RIG, 1000, [0, 0, 0]);
    expect(targetAimAt(s, I, 1000)).toBeNull();
  });
});

describe("targetAimAt's root[0] selection (branch-consistency invariant)", () => {
  // targetAimAt intentionally takes enuToPanTiltOffsetAll(...)[0] rather than
  // the in-range-preferring enuToPanTiltOffset (see the comment on
  // targetAimAt in control.ts) -- root[0]'s panDeg/tiltDeg double as BOTH the
  // commanded posture and the finite-difference gradient input, and the rate
  // computation would break if the two nearby samples could independently
  // pick different physical branches near a boundary. That is only safe
  // because root[0] is, empirically, always the in-range physical branch for
  // every cHead[1]>0 geometry the calibration solver produces. Lock that
  // invariant here across a spread of directions and both the default and a
  // real field cHead (from imu-calib-field.json, see
  // enu-to-pantilt-offset.test.ts), so a future change to the root ordering
  // in enuToPanTiltOffsetAll fails loudly here instead of silently
  // degrading tracking.
  const FIELD_CHEAD: Vec3 = [-0.520849, 0.735122, 0.433949];
  const cases: Array<{ cHead: Vec3; geoPanSign: number }> = [
    { cHead: [0, 1, 0], geoPanSign: 1 },
    { cHead: FIELD_CHEAD, geoPanSign: -1 },
  ];

  it("root[0] is the in-range branch whenever ANY root is in range", () => {
    for (const { cHead, geoPanSign } of cases) {
      for (let az = -170; az <= 170; az += 10) {
        for (let el = -25; el <= 80; el += 15) {
          const azR = (az * Math.PI) / 180, elR = (el * Math.PI) / 180;
          const u: Vec3 = [Math.cos(elR) * Math.sin(azR), Math.cos(elR) * Math.cos(azR), Math.sin(elR)];
          const roots = enuToPanTiltOffsetAll(I, cHead, geoPanSign, u, LIMITS);
          const anyInRange = roots.some((r) => r.inRange);
          if (anyInRange) expect(roots[0].inRange).toBe(true);
        }
      }
    }
  });
});

// The old fixed lookahead: 3 ticks x 100ms, same for both axes.
const H300 = { panMs: 300, tiltMs: 300 };

describe("limitGuard", () => {
  it("applies its horizon per axis, not one scalar to both", () => {
    // Symmetric setup: pan sits 1deg under panMax, tilt sits 1deg over tiltMin,
    // both closing at 20 deg/s. So each axis breaches exactly when its OWN
    // horizon exceeds 50ms, and nothing but the horizon differs between these
    // two calls. Swapping the horizons must swap which axis blocks -- a single
    // scalar horizon could not produce both of these results.
    const long = 700, short = 10;
    const a = limitGuard({ panDps: 20, tiltDps: -20 }, 179, -89, LIMITS, { panMs: long, tiltMs: short });
    expect(a.panBlocked).toBe(true);
    expect(a.out.panDps).toBe(0);
    expect(a.tiltBlocked).toBe(false);
    expect(a.out.tiltDps).toBe(-20);

    const b = limitGuard({ panDps: 20, tiltDps: -20 }, 179, -89, LIMITS, { panMs: short, tiltMs: long });
    expect(b.panBlocked).toBe(false);
    expect(b.out.panDps).toBe(20);
    expect(b.tiltBlocked).toBe(true);
    expect(b.out.tiltDps).toBe(0);
  });

  it("passes a rate that stays in range", () => {
    const g = limitGuard({ panDps: 5, tiltDps: 0 }, 0, 0, LIMITS, H300);
    expect(g.out.panDps).toBe(5);
    expect(g.panBlocked).toBe(false);
  });

  // FIELD BUG 2026-07-29: after teaching all four travel limits the rig would
  // not move at all, in any direction, until the operator cleared them.
  //
  // The cause is here. Blocking purely on "is the PREDICTION outside the
  // range" is correct only while the rig is INSIDE it. Once the rig is
  // outside -- which teaching an inverted pair puts it -- every prediction on
  // that axis is also outside, so both directions get zeroed and there is no
  // way to drive back in. The guard must consider DIRECTION, not just
  // membership: motion that reduces the violation has to be allowed even
  // though it does not fully re-enter the range within one command.
  it("lets an axis that is ALREADY past its limit drive back toward the range", () => {
    // pan 200 with panMax 180: 300ms at -20 deg/s lands at 194 -- still out of
    // range, but 6deg closer. Blocking this is what trapped the rig.
    const back = limitGuard({ panDps: -20, tiltDps: 0 }, 200, 0, LIMITS, H300);
    expect(back.panBlocked).toBe(false);
    expect(back.out.panDps).toBe(-20);

    // ...and the same position must still refuse to go FURTHER out.
    const worse = limitGuard({ panDps: 20, tiltDps: 0 }, 200, 0, LIMITS, H300);
    expect(worse.panBlocked).toBe(true);
    expect(worse.out.panDps).toBe(0);
  });

  it("lets an axis below its minimum drive back up, but not further down", () => {
    const back = limitGuard({ panDps: 0, tiltDps: 20 }, 0, -120, LIMITS, H300);
    expect(back.tiltBlocked).toBe(false);
    expect(back.out.tiltDps).toBe(20);

    const worse = limitGuard({ panDps: 0, tiltDps: -20 }, 0, -120, LIMITS, H300);
    expect(worse.tiltBlocked).toBe(true);
    expect(worse.out.tiltDps).toBe(0);
  });

  it("still blocks a rate that would carry an in-range axis out", () => {
    // The regression guard for the fix above: allowing "moving toward the
    // range" must not accidentally allow "leaving the range".
    const g = limitGuard({ panDps: 20, tiltDps: 0 }, 179, 0, LIMITS, H300);
    expect(g.panBlocked).toBe(true);
    expect(g.out.panDps).toBe(0);
  });

  it("zeroes an axis whose predicted position would breach its limit", () => {
    // At pan 179 moving +20 deg/s, in 300ms we reach ~185 > panMax 180.
    const g = limitGuard({ panDps: 20, tiltDps: 0 }, 179, 0, LIMITS, H300);
    expect(g.out.panDps).toBe(0);
    expect(g.panBlocked).toBe(true);
  });

  it("blocks per-axis: pan held, tilt still tracking", () => {
    const g = limitGuard({ panDps: 20, tiltDps: 3 }, 179, 0, LIMITS, H300);
    expect(g.out.panDps).toBe(0);
    expect(g.out.tiltDps).toBe(3);
    expect(g.tiltBlocked).toBe(false);
  });

  it("allows moving away from a limit it is already at", () => {
    const g = limitGuard({ panDps: -20, tiltDps: 0 }, 179, 0, LIMITS, H300);
    expect(g.out.panDps).toBe(-20);
    expect(g.panBlocked).toBe(false);
  });

  it("guards the tilt floor (below-horizon)", () => {
    const g = limitGuard({ panDps: 0, tiltDps: -20 }, 0, -89, LIMITS, H300);
    expect(g.out.tiltDps).toBe(0);
    expect(g.tiltBlocked).toBe(true);
  });

  // The bug the computed horizon exists for. A soft limit is the host-side
  // net in front of the Pico's own, so it must predict where the axis ends up
  // once it has actually STOPPED, not where it is one tick from now.
  it("REGRESSION: a fixed 300ms horizon is too short to stop the head before a limit", () => {
    // Budget at 19 deg/s with the Pico's default amax (10 deg/s^2), from pan
    // 174 (6 deg of room to panMax 180):
    //   telemetry up to 200ms old                                  +3.8
    //   100ms until the next tick re-evaluates                     +1.9
    //   stopping time |rate|/amax = 1.9s, ~half of it at full rate +18
    // The old fixed 3-tick horizon predicts only 174 + 19*0.3 = 179.7, calls
    // that safe and commands the rate anyway. The honest horizon (2.2s at the
    // full rate, a deliberate over-estimate) stops the axis.
    const rigPan = 174, rate = 19;
    const honest = { panMs: limitHorizonMs(rate, 200, 100, 10), tiltMs: 0 };
    expect(honest.panMs).toBe(2200);

    expect(limitGuard({ panDps: rate, tiltDps: 0 }, rigPan, 0, LIMITS, H300).panBlocked).toBe(false);
    expect(limitGuard({ panDps: rate, tiltDps: 0 }, rigPan, 0, LIMITS, honest).panBlocked).toBe(true);
  });

  it("the dynamic horizon costs almost nothing at low rate", () => {
    // Computed instead of a bigger constant: at 1 deg/s the head stops in
    // 100ms, so a horizon sized for the saturated worst case would surrender
    // travel it never needed.
    expect(limitHorizonMs(1, 200, 100, 10)).toBe(400);
    // ...and it never blocks a slow creep that is genuinely safe.
    expect(limitGuard({ panDps: 1, tiltDps: 0 }, 179, 0, LIMITS,
      { panMs: limitHorizonMs(1, 200, 100, 10), tiltMs: 0 }).panBlocked).toBe(false);
  });

  it("fails closed on a prediction it cannot compute (NaN/Infinity blocks the axis)", () => {
    expect(limitGuard({ panDps: NaN, tiltDps: 0 }, 0, 0, LIMITS, H300).panBlocked).toBe(true);
    expect(limitGuard({ panDps: 1, tiltDps: 0 }, 0, 0, LIMITS, { panMs: Infinity, tiltMs: 0 }).panBlocked).toBe(true);
    // The healthy axis is untouched.
    expect(limitGuard({ panDps: NaN, tiltDps: 0 }, 0, 0, LIMITS, H300).tiltBlocked).toBe(false);
  });
});

describe("limitHorizonMs (stopping time from the Pico's amax)", () => {
  it("limitHorizonMs grows as amax shrinks", () => expect(limitHorizonMs(10, 0, 100, 5)).toBeGreaterThan(limitHorizonMs(10, 0, 100, 20)));
  it("limitHorizonMs includes telemetry age and one tick", () => expect(limitHorizonMs(0, 200, 100, 10)).toBe(300));

  it("stopping time is |rate| / amax, sign-agnostic", () => {
    expect(limitHorizonMs(10, 0, 0, 10)).toBe(1000);
    expect(limitHorizonMs(-10, 0, 0, 10)).toBe(1000);
    expect(limitHorizonMs(5, 0, 0, 20)).toBe(250);
  });

  it("a negative telemetry age (clock skew) adds nothing", () => {
    expect(limitHorizonMs(0, -500, 100, 10)).toBe(100);
  });

  it("an unusable amax is an infinite horizon, never a zero one", () => {
    expect(limitHorizonMs(5, 0, 100, 0)).toBe(Infinity);
    expect(limitHorizonMs(5, 0, 100, NaN)).toBe(Infinity);
    expect(limitHorizonMs(5, 0, 100, -3)).toBe(Infinity);
  });
});
