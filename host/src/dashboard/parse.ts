import { HeadTickZ, type HeadImu, type HeadLink, type HeadRef } from "../shared/head-types.js";

/**
 * The dashboard's direct read of the head (`GET /api/state`, the tick
 * object), independent of the MCP daemon. Angles are the raw head values
 * (device frame, degrees). Every field is null when the head is unreachable or
 * the body does not validate as a tick; `panDeg`/`tiltDeg`/`moving` are also
 * null on a tick without `axes` (the Pico link is down: no motion telemetry).
 */
export interface HeadDirect {
  connected: boolean;
  panDeg: number | null;
  tiltDeg: number | null;
  // Focus: output-shaft degrees as the Pico counts them (no frame), and where
  // it is heading. The dashboard's focus nudges step from the target, so quick
  // taps add up instead of each restarting from a lagging position.
  focusDeg: number | null;
  focusTgtDeg: number | null;
  moving: boolean | null;
  estop: boolean;
  ref: HeadRef | null;
  imu: HeadImu | null;
  tiltDisagreeDeg: number | null;
  link: HeadLink | null;
}

const DISCONNECTED: HeadDirect = {
  connected: false, panDeg: null, tiltDeg: null, focusDeg: null, focusTgtDeg: null, moving: null, estop: false,
  ref: null, imu: null, tiltDisagreeDeg: null, link: null,
};

/** Never throws: anything that is not a valid tick reads as "not connected". */
export function parseHeadState(raw: unknown): HeadDirect {
  const r = HeadTickZ.safeParse(raw);
  if (!r.success) return { ...DISCONNECTED };
  const t = r.data;
  return {
    connected: true,
    panDeg: t.axes ? t.axes.pan.pos : null,
    tiltDeg: t.axes ? t.axes.tilt.pos : null,
    focusDeg: t.axes ? t.axes.focus.pos : null,
    focusTgtDeg: t.axes ? t.axes.focus.tgt : null,
    moving: t.axes ? (t.moving ?? null) : null,
    estop: t.estop,
    ref: { ...t.ref },
    imu: { ...t.imu, cal: t.imu.cal ? { ...t.imu.cal } : null },
    tiltDisagreeDeg: t.tiltDisagreeDeg,
    link: { ...t.link },
  };
}
