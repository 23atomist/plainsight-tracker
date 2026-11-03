// TRANSITIONAL — removed in Task 4 ("degrees everywhere").
//
// The head API is in degrees; the ESP32 rig was in steps. Task 3 rewrote the
// device layer, but the ~10 modules that still read step fields / import the
// step helpers are ported in Task 4. This file exists only so `npm run build`
// stays green in between: it re-exposes the retired step helpers and the
// retired DeviceState fields, derived from the new degree fields. Task 4
// deletes this file together with every import of it.

/** @deprecated TRANSITIONAL — removed in Task 4 */
export const STEPS_PER_DEG = 444.444;

/** @deprecated TRANSITIONAL — removed in Task 4 */
export function stepsToDeg(steps: number): number {
  return steps / STEPS_PER_DEG;
}

/** @deprecated TRANSITIONAL — removed in Task 4 */
export function degToSteps(deg: number): number {
  return deg * STEPS_PER_DEG;
}

/** @deprecated TRANSITIONAL — removed in Task 4 */
export interface LegacyDeviceStateFields {
  /** @deprecated TRANSITIONAL — removed in Task 4 (= panDeg * 444.444) */
  readonly panSteps: number;
  /** @deprecated TRANSITIONAL — removed in Task 4 (= tiltDeg * 444.444) */
  readonly tiltSteps: number;
  /** @deprecated TRANSITIONAL — removed in Task 4 (= zoomDeg * 444.444) */
  readonly auxSteps: number;
  /** @deprecated TRANSITIONAL — removed in Task 4 (the head has no battery: always 0) */
  readonly batteryV: number;
  /** @deprecated TRANSITIONAL — removed in Task 4 (always "") */
  readonly staIp: string;
  /** @deprecated TRANSITIONAL — removed in Task 4 (= estop) */
  readonly programEngaged: boolean;
}

/** @deprecated TRANSITIONAL — removed in Task 4 */
export function legacyDeviceStateFields(
  s: { panDeg: number; tiltDeg: number; zoomDeg: number; estop: boolean },
): LegacyDeviceStateFields {
  return {
    panSteps: degToSteps(s.panDeg),
    tiltSteps: degToSteps(s.tiltDeg),
    auxSteps: degToSteps(s.zoomDeg),
    batteryV: 0,
    staIp: "",
    programEngaged: s.estop,
  };
}
