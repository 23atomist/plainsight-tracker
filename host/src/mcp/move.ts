import { AxisConfig, Device } from "../shared/device.js";
import { Config } from "../shared/config.js";
import { applySign, checkPanTilt, checkSpeed, Limits } from "../shared/angles.js";
import { usableOr } from "../shared/track/control.js";
import { hostCeiling } from "../shared/limits-store.js";
import { ESTOP_LATCHED_MSG } from "./tool-helpers.js";

// The arrival budget's slack over the head's own trapezoid time: for a slow
// link, a late first tick, the Pico's settle.
const ARRIVAL_MARGIN = 1.5;
const ARRIVAL_SLACK_MS = 3000;
const ARRIVAL_FLOOR_MS = 5000;

/**
 * How long a goto of `distDeg` per axis (device frame) may take to arrive.
 * The head ignores a goto's speed and moves each axis at the Pico's own
 * `vmax`, ramping at `amax` (docs/HEAD-API.md), so the budget comes from
 * those: per axis `d/vmax + vmax/amax` (a trapezoid's time, an upper bound
 * for the short triangular moves too), the slower axis, times a margin.
 * cfg.maxSpeedDps and cfg.trackFallbackAmaxDps2 stand in only until the
 * head's config has been read. Sizing it from cfg.maxSpeedDps alone (the
 * ESP32 model) timed out every goto over ~30 deg at the Pico's 5 deg/s.
 */
export function gotoArrivalBudgetMs(
  distDeg: Record<"pan" | "tilt", number>, axisCfg: AxisConfig | null, cfg: Config,
): number {
  const axisSec = (axis: "pan" | "tilt"): number => {
    const vmax = usableOr(axisCfg?.[axis].vmax, cfg.maxSpeedDps);
    const amax = usableOr(axisCfg?.[axis].amax, cfg.trackFallbackAmaxDps2);
    return distDeg[axis] / vmax + vmax / amax;
  };
  const sec = Math.max(axisSec("pan"), axisSec("tilt"));
  return Math.max(ARRIVAL_FLOOR_MS, sec * 1000 * ARRIVAL_MARGIN + ARRIVAL_SLACK_MS);
}

export interface MoveResult {
  arrived: boolean;
  pan_deg: number;
  tilt_deg: number;
}

// Move to a USER-frame pan/tilt. Validates soft limits + speed, applies device
// signs, commands the move, and waits for arrival. Throws Error(message) on any
// violation, device rejection, or timeout — callers turn that into an MCP error.
//
// `limits` defaults to the host ceiling (config ∩ the head's own limits, no
// taught edges), for callers that do not know about operator-taught travel
// limits (limits-store.ts). Callers that DO have a LimitsStore (tools.ts's
// goto_angle, geo-tools.ts's point_at/point_at_azel, track/session.ts's
// tracking acquire) must pass the resolved effective (taught-or-config)
// range instead — passing only the config ceiling here would silently
// re-open the same "enforced in some paths, not others" gap Part 1 closes
// for rate jog.
//
// `signal` abandons the arrival wait (see Device.waitForArrival): for a caller
// whose goto has been superseded on the head (gotos retarget), so the wait
// does not outlive the move it was waiting for.
export async function moveToUserAngle(
  device: Device, cfg: Config, panDeg: number, tiltDeg: number, speedDps?: number,
  limits: Pick<Limits, "panMin" | "panMax" | "tiltMin" | "tiltMax"> = hostCeiling(cfg, device.getAxisConfig()),
  signal?: AbortSignal,
): Promise<MoveResult> {
  // Every absolute move (goto_angle, point_at*, the IMU and vision sweeps,
  // the parks, a tracking acquire) comes through here: refuse while latched
  // rather than send a goto the head can only 423.
  if (device.getState().estop) throw new Error(ESTOP_LATCHED_MSG);
  const lim = checkPanTilt(panDeg, tiltDeg, limits);
  if (!lim.ok) throw new Error(lim.error!);
  const spd = checkSpeed(speedDps, cfg.maxSpeedDps);
  if (!spd.ok) throw new Error(spd.error!);

  const devPan = applySign(panDeg, cfg.panSign);
  const devTilt = applySign(tiltDeg, cfg.tiltSign);
  try {
    await device.gotoAngle(devPan, devTilt, speedDps);
  } catch (e) {
    // `cause` carries the DeviceHttpError through: the message stays the
    // operator-facing string callers already format, while a programmatic
    // caller (the tracking session) can still tell a routine 409 "still
    // decelerating" apart from a real fault without parsing this text.
    throw new Error(`device rejected goto: ${(e as Error).message}`, { cause: e });
  }

  const cur = device.getState();
  const timeoutMs = gotoArrivalBudgetMs(
    { pan: Math.abs(devPan - cur.panDeg), tilt: Math.abs(devTilt - cur.tiltDeg) },
    device.getAxisConfig(), cfg,
  );

  const final = await device.waitForArrival(devPan, devTilt, timeoutMs, signal);
  return {
    arrived: true,
    pan_deg: Number(applySign(final.panDeg, cfg.panSign).toFixed(3)),
    tilt_deg: Number(applySign(final.tiltDeg, cfg.tiltSign).toFixed(3)),
  };
}
