// Spec 6.8 rule 1: the head renamed pan's zero and told us, for the same
// physical position, its value in the old frame (`previous`) and the new one
// (`pan`). Everything the host keeps against pan's zero is re-expressed by
// that delta so it keeps meaning the same sky / the same cable position:
//
//   - the calibration (solved orientation, sightings, gravity anchors) --
//     CalibrationStore.shiftPanZero, an exact rotation, not a re-fit;
//   - the taught pan limits -- LimitsStore.shiftPan.
//
// Deliberately NOT shifted:
//   - the tracking sector: its edges are TRUE-NORTH BEARINGS (set_track_sector,
//     checked against the target's ENU azimuth in session.ts/enrich.ts), not
//     pan values. The calibration shift keeps every ENU direction where it
//     was, so the sector is already correct; shifting it would move the
//     allowed arc to a different patch of sky.
//   - the elevation floor: elevation, not pan.
//   - the aim trim (and a pass's aim offset): relative corrections added to a
//     setpoint, not positions against pan's zero, so a rename leaves them
//     meaning exactly what they meant.
//
// Rule 2 (`source: "none"`, the origin is unknown) carries no delta: nothing
// is shifted, and the unreferenced gates (session/supervisor/tools/agent) keep
// automated motion off the rig until a reference returns.
//
// A reference with no old frame (`previous: null` -- the head only knows one
// while the Pico stayed homed, so EVERY reference after a drop arrives like
// this) cannot be shifted either, and it may have put pan's zero anywhere:
// IMU north is off by the compass error, set_position takes whatever value
// the operator typed. So it flags the calibration frame unverified, which
// gates automation exactly like an unreferenced pan until a re-solve or
// confirm_pan_frame. The one exception is the head re-applying its persisted
// position file (`reason: "restored"`): that IS the old frame.
import type { ReferenceChange } from "../shared/device.js";

export interface PanZeroStores {
  readonly calibration: { shiftPanZero(deltaDeg: number): void; markFrameUnverified(reason: string): void };
  readonly limits: { shiftPan(deltaDeg: number): void };
}

/**
 * Applies one `pan_reference` change. Returns the USER-frame delta applied
 * (0 when the rename did not move the zero), or null when there was nothing
 * to shift by.
 *
 * The delta is `pan - previous` unwrapped: both are readings of the Pico's
 * continuous pan counter, so their difference IS the counter's shift. The
 * calibration does not care (it sees pan only through a periodic rotation),
 * but the taught limits do -- see LimitsStore.shiftPan. The head reports
 * device-frame pan; the stores hold user-frame pan (sightings and taught
 * edges are recorded through applySign), so the delta crosses cfg.panSign.
 */
export function applyPanReferenceChange(
  c: ReferenceChange, panSign: number, stores: PanZeroStores, log: (msg: string) => void,
): number | null {
  if (c.pan === null) {
    log(`[reference] pan reference lost (${c.reason ?? "no reason given"}); ` +
      "nothing to shift — automated motion is held until pan is referenced");
    return null;
  }
  if (c.previous === null) {
    if (c.reason === "restored") {
      log(`[reference] pan restored by ${c.source} from the head's persisted position (pan ${c.pan}); same frame, nothing to shift`);
      return null;
    }
    const why = `pan referenced by ${c.source} at ${c.pan} with no previous frame — its offset from the calibration's frame is unknown`;
    stores.calibration.markFrameUnverified(why);
    log(`[reference] ${why}; calibration flagged unverified — re-sight and solve_calibration, or confirm_pan_frame if the head was not moved`);
    return null;
  }
  const deltaUser = (c.pan - c.previous) * panSign;
  if (deltaUser === 0) return 0;
  stores.calibration.shiftPanZero(deltaUser);
  stores.limits.shiftPan(deltaUser);
  log(`[reference] pan re-referenced by ${c.source}: ${c.previous} -> ${c.pan} (device frame); ` +
    `calibration and taught pan limits shifted by ${deltaUser} deg (user frame)`);
  return deltaUser;
}

/** Subscribes the stores to the head's `pan_reference` events (server.ts main()). */
// `onRenamed` runs for EVERY pan_reference (server.ts: SunSupervisor.
// onPanRenamed): any of them changes what the pan counter means, so a
// rate derived across it is not motion.
export function wireReferenceShift(
  device: { onReferenceChanged(cb: (c: ReferenceChange) => void): void },
  panSign: number, stores: PanZeroStores, log: (msg: string) => void = (m) => console.error(m),
  onRenamed: () => void = () => {},
): void {
  device.onReferenceChanged((c) => {
    // Device isolates listener throws silently; a failed shift (e.g. a write
    // error persisting a store) must be loud instead.
    try { applyPanReferenceChange(c, panSign, stores, log); }
    catch (e) { log(`[reference] FAILED to shift stores for a pan rename: ${e instanceof Error ? e.message : String(e)}`); }
    try { onRenamed(); }
    catch (e) { log(`[reference] onRenamed hook threw: ${e instanceof Error ? e.message : String(e)}`); }
  });
}
