import { applySign } from "../shared/angles.js";
import type { DeviceState } from "../shared/types.js";

// Sighting while the rig moves (sight_aircraft during tracking).
//
// A sighting pairs "where the camera pointed" with "where the aircraft was" at
// ONE instant. The operator judges centring on video that lags real time by
// calibVideoLatencyMs, and the aircraft position is already extrapolated to
// that instant (extrapolateSightingPosition), so the posture must be the one
// at the same instant: the last telemetry read, moved along by the axis
// velocity to (now - video latency).
//
// Field bug 2026-08-30 (a lagging read recorded a posture 51 deg from the
// aircraft) is why a moving or stale read used to be refused outright. A
// moving read is accepted now only when telemetry is FRESH and the rig is
// turning slowly -- a distant aircraft under tracking moves well under 1 deg/s
// -- and the timing uncertainty that remains is charged to the sighting's
// sigma, so the fit weights it accordingly.

/** Fresher than the general stale limit: a moving posture ages fast. */
export const SIGHT_MOVING_MAX_AGE_MS = 500;
/** Above this the timing error dominates the operator's centring error. */
export const SIGHT_MAX_RATE_DPS = 3;
/** 1-sigma uncertainty of the video latency, used to inflate sigma. */
export const SIGHT_LATENCY_SIGMA_SEC = 0.15;

export type SightPosture =
  | { panDeg: number; tiltDeg: number; moving: boolean; rateDps: number; timingSigmaDeg: number }
  | { error: string };

export function sightPosture(
  s: DeviceState, signs: { panSign: number; tiltSign: number }, videoLatencyMs: number, nowMs: number,
): SightPosture {
  const panDeg = applySign(s.panDeg, signs.panSign);
  const tiltDeg = applySign(s.tiltDeg, signs.tiltSign);
  if (!s.moving) return { panDeg, tiltDeg, moving: false, rateDps: 0, timingSigmaDeg: 0 };

  const ageMs = nowMs - s.lastUpdateMs;
  if (!s.axes || ageMs > SIGHT_MOVING_MAX_AGE_MS) {
    return {
      error: `the rig is moving and its posture reading is ${Math.round(ageMs)} ms old (limit ` +
        `${SIGHT_MOVING_MAX_AGE_MS} ms while moving) — re-sight once telemetry is live`,
    };
  }
  const vPan = applySign(s.axes.pan.vel, signs.panSign);
  const vTilt = applySign(s.axes.tilt.vel, signs.tiltSign);
  const rateDps = Math.hypot(vPan, vTilt);
  if (rateDps > SIGHT_MAX_RATE_DPS) {
    return {
      error: `the rig is turning ${rateDps.toFixed(1)}°/s (limit ${SIGHT_MAX_RATE_DPS}°/s for a sighting while ` +
        "moving) — pick a more distant aircraft, or stop tracking and sight it as it crosses the centre",
    };
  }
  // Posture at the instant the operator saw the aircraft centred.
  const dtSec = (nowMs - videoLatencyMs - s.lastUpdateMs) / 1000;
  return {
    panDeg: panDeg + vPan * dtSec,
    tiltDeg: tiltDeg + vTilt * dtSec,
    moving: true,
    rateDps,
    timingSigmaDeg: rateDps * SIGHT_LATENCY_SIGMA_SEC,
  };
}
