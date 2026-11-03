import { Vec3, Mat3, norm, normalize } from "../geo/vec3.js";
import { boresightToEnu, enuToPanTiltOffsetAll } from "../geo/imu-orientation.js";
import { EstimatorState, estimateAt } from "./estimator.js";

// Feedforward finite-difference step. The position extrapolation is exact
// (linear), but pan/tilt are nonlinear functions (atan2/asin), so the
// finite difference is a first-order approximation. Error is negligibly
// small at Δt=10ms relative to realistic target dynamics. The estimate is
// a smooth analytic function (not a sensor), so there is no measurement
// noise to amplify.
const FF_DELTA_MS = 10;

// Below this range the pointing direction is undefined.
const MIN_RANGE_M = 1e-3;

// Wrap to (-180, 180] so errors always take the short way round.
export function wrapDeg180(d: number): number {
  const x = ((d % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
}

export interface GuardLimits {
  readonly panMin: number; readonly panMax: number;
  readonly tiltMin: number; readonly tiltMax: number;
}

// Canonical full range -- matches enuToPanTilt's own output domain (pan in
// (-180,180], tilt in [-90,90]) exactly. Used as the default `limits` for the
// offset-aware helpers below so that, at the default cHead/geoPanSign, the
// in-range root selection can never diverge from the legacy closed-form
// regardless of the caller's actual device limits (deliberately NOT sourced
// here -- these are pure geometry helpers; reachability is checked elsewhere).
const FULL_RANGE: GuardLimits = { panMin: -180, panMax: 180, tiltMin: -90, tiltMax: 90 };

// Where the rig is actually pointing, as an ENU unit vector. R maps mount->ENU.
// cHead/geoPanSign default to the no-offset/legacy-handed identity, so every
// existing caller (and test) that doesn't know about the camera-offset model
// keeps getting exactly matVec(R, panTiltToMount(panDeg, tiltDeg)) -- proven
// to reduce exactly in Task 5 (enu-to-pantilt-offset.test.ts).
export function boresightEnu(
  R: Mat3, panDeg: number, tiltDeg: number,
  cHead: Vec3 = [0, 1, 0], geoPanSign: number = 1,
): Vec3 {
  return boresightToEnu(R, cHead, geoPanSign, panDeg, tiltDeg);
}

export interface TargetAim {
  readonly panDeg: number;      // user frame
  readonly tiltDeg: number;     // user frame
  readonly ratePanDps: number;  // feedforward
  readonly rateTiltDps: number; // feedforward
  readonly enuUnit: Vec3;
  readonly rangeM: number;
}

// Where the target is at tMs, and how fast that aim point is moving.
// cHead/geoPanSign/limits default to the legacy no-offset identity (see
// boresightEnu above). This is a local error-gradient (finite-difference)
// calc, not a commanded posture -- take the first root (the same
// deterministic branch for both nearby points, so the delta stays
// consistent) and ignore inRange, exactly as the legacy enuToPanTilt had no
// notion of range either.
//
// NOTE this is deliberately NOT enuToPanTiltOffset's in-range-preferring
// selection, even though `a`'s panDeg/tiltDeg below double as the COMMANDED
// posture (session.ts feeds them straight into reachablePanTilt and on to
// the head's TRACK setpoint, not just into the ratePanDps/rateTiltDps
// feedforward). Those two uses share one deterministic root selection ON
// PURPOSE: `a` (u0) and `b` (the +FF_DELTA_MS lookahead point) must pick the
// SAME physical branch, or a target passing near a branch boundary could
// have them land on DIFFERENT branches on consecutive ticks -- and the
// finite difference between two different physical branches is not a rate,
// it is a discontinuity that would spike ratePanDps/rateTiltDps and
// destabilize the feedforward loop. Switching only the commanded-posture use
// to prefer in-range (while keeping `a`/`b` coupled for the gradient) is not
// possible because they are the same computed value.
//
// This is safe in practice because root[0] (the `Math.asin(val)` branch in
// enuToPanTiltOffsetAll) is, empirically, always the in-range physical
// branch for every cHead[1]>0 geometry fitCalibration (geo/calibration-fit.ts) can
// produce (its candidates are filtered to c·+Y>0) -- i.e. it already agrees
// with point_at/point_at_azel's in-range preference, it just does not rely
// on `inRange` to get there. See "root[0] selection (branch-consistency
// invariant)" in control.test.ts, which pins this across a spread of
// directions for both the default and a real field cHead as a regression
// guard -- if a future change to enuToPanTiltOffsetAll's root ordering ever
// breaks this, that test fails loudly instead of tracking silently
// degrading.
export function targetAimAt(
  s: EstimatorState, R: Mat3, tMs: number,
  cHead: Vec3 = [0, 1, 0], geoPanSign: number = 1, limits: GuardLimits = FULL_RANGE,
): TargetAim | null {
  const p0 = estimateAt(s, tMs);
  const p1 = estimateAt(s, tMs + FF_DELTA_MS);
  if (!p0 || !p1) return null;
  const rangeM = norm(p0);
  if (rangeM < MIN_RANGE_M) return null;
  const u0 = normalize(p0);
  const a = enuToPanTiltOffsetAll(R, cHead, geoPanSign, u0, limits)[0];
  const b = enuToPanTiltOffsetAll(R, cHead, geoPanSign, normalize(p1), limits)[0];
  const dtSec = FF_DELTA_MS / 1000;
  return {
    panDeg: a.panDeg,
    tiltDeg: a.tiltDeg,
    ratePanDps: wrapDeg180(b.panDeg - a.panDeg) / dtSec,
    rateTiltDps: (b.tiltDeg - a.tiltDeg) / dtSec,
    enuUnit: u0,
    rangeM,
  };
}

export interface ControlOutput {
  readonly panDps: number;
  readonly tiltDps: number;
}

/**
 * A usable per-axis rate or acceleration from the head's config: finite and
 * positive, else the fallback. A head that reports 0, a negative value or no
 * config at all must never turn into a zero stopping time or a zero rate cap.
 */
export function usableOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * How far ahead the limit guard must predict, in ms, for ONE axis.
 *
 * A flat few ticks is shorter than the head's real stopping distance, and the
 * shortfall is invisible in a simulation that stops dead. Every term below is
 * a real delay between "the axis is here" and "the axis has actually
 * stopped", so the guard has to cover their sum:
 *
 *   telemetryAgeMs     the reading is already this old
 *   tickPeriodMs       nothing re-evaluates until the next tick
 *   |rate| / amax      the Pico decelerates at its configured amax (deg/s^2)
 *
 * Computed rather than a bigger constant on purpose: the stopping term scales
 * with the rate, so this spends real lookahead only when actually fast and
 * next to nothing when creeping. A constant sized for the worst case would
 * surrender that travel at every rate. An unusable amax (0, negative, NaN)
 * is an infinite horizon -- limitGuard blocks it -- never a zero one.
 */
export function limitHorizonMs(
  rateDps: number, telemetryAgeMs: number, tickPeriodMs: number, amaxDps2: number,
): number {
  if (!(amaxDps2 > 0)) return Infinity;
  return Math.max(0, telemetryAgeMs) + tickPeriodMs + (Math.abs(rateDps) / amaxDps2) * 1000;
}

/** Per-axis lookahead. Each axis decelerates on its own rate, so each gets its own. */
export interface GuardHorizon {
  readonly panMs: number;
  readonly tiltMs: number;
}

// The host-side soft-limit net, in front of the Pico's own. Check the
// PREDICTED position over the horizon, not the current one: by the time we are
// outside, it is already too late.
//
// Predicting at the FULL commanded rate for the whole horizon deliberately
// over-estimates the stopping distance (a linear decel ramp averages half the
// rate). Erring long is the correct direction.
// Whether this axis' commanded rate must be zeroed, judged on DIRECTION and
// not merely on whether the prediction sits inside [min,max].
//
// Membership alone is only a correct test while the rig is inside the range.
// Once it is outside -- which teaching an inverted pair of travel limits will
// do, and which a config edit that narrows the ceiling under a parked rig will
// also do -- every prediction on that axis is outside too, so a
// membership-only test zeroes BOTH directions and strands the rig with no way
// back. That is the 2026-07-29 field bug: after teaching all four limits the
// rig would not move at all until the limits were cleared.
//
// So: a prediction that lands inside is always fine; one that lands outside is
// allowed only when it is strictly closer to the range than where the rig is
// now. Motion that reduces a violation is never blocked; motion that creates
// or deepens one always is.
//
// A prediction that is not a finite number (a NaN rate, an infinite horizon
// from an unusable amax) blocks the axis: an unknown stopping point is not a
// safe one.
function axisBlocked(cur: number, pred: number, min: number, max: number): boolean {
  if (!Number.isFinite(pred)) return true;
  if (pred <= max && pred >= min) return false;
  if (pred > max) return pred >= cur;  // above the top: only descending is allowed
  return pred <= cur;                  // below the bottom: only ascending is allowed
}

export function limitGuard(
  out: ControlOutput, rigPanDeg: number, rigTiltDeg: number,
  limits: GuardLimits, horizon: GuardHorizon,
): { out: ControlOutput; panBlocked: boolean; tiltBlocked: boolean } {
  const predPan = rigPanDeg + out.panDps * (horizon.panMs / 1000);
  const predTilt = rigTiltDeg + out.tiltDps * (horizon.tiltMs / 1000);
  const panBlocked = axisBlocked(rigPanDeg, predPan, limits.panMin, limits.panMax);
  const tiltBlocked = axisBlocked(rigTiltDeg, predTilt, limits.tiltMin, limits.tiltMax);
  return {
    out: {
      panDps: panBlocked ? 0 : out.panDps,
      tiltDps: tiltBlocked ? 0 : out.tiltDps,
    },
    panBlocked,
    tiltBlocked,
  };
}
