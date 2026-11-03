import type { HeadAxis, HeadAxisName, HeadImu, HeadLink, HeadRef } from "./head-types.js";

/**
 * The host's cached view of the head, built from `/ws` ticks. Angles are the
 * raw head values (device frame, degrees); `applySign` maps them to the user
 * frame at the call sites.
 *
 * `panDeg`/`tiltDeg`/`zoomDeg`/`focusDeg`, `axes`, `moving`, `enabled` and
 * `lastUpdateMs` change ONLY on a tick that carries `axes`. While the Pico
 * link is down the head still publishes IMU-only ticks; those refresh `estop`,
 * `imu`, `tiltDisagreeDeg`, `ref` and `link` but leave the motion fields (and
 * so `lastUpdateMs`) frozen, so every staleness check keeps working instead of
 * servoing on angles nobody is measuring. `connected` is the WebSocket state.
 */
export interface DeviceState {
  connected: boolean;
  panDeg: number;
  tiltDeg: number;
  zoomDeg: number;
  focusDeg: number;
  axes?: Record<HeadAxisName, HeadAxis>;
  moving: boolean;
  enabled: boolean;
  estop: boolean;
  imu?: HeadImu;
  tiltDisagreeDeg: number | null;
  ref: HeadRef;
  link: HeadLink;
  lastUpdateMs: number;
}
