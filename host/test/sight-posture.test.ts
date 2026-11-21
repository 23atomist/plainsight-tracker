import { describe, it, expect } from "vitest";
import { sightPosture, SIGHT_MOVING_MAX_AGE_MS, SIGHT_LATENCY_SIGMA_SEC } from "../src/mcp/sight-posture.js";
import type { DeviceState } from "../src/shared/types.js";

const axis = (pos: number, vel: number) => ({ pos, vel, tgt: pos, mode: "V", homed: true, endstop: false, driver: true });
function state(over: Partial<DeviceState>, vPan = 0, vTilt = 0): DeviceState {
  return {
    connected: true, panDeg: 50, tiltDeg: 10, zoomDeg: 0, focusDeg: 0,
    axes: { pan: axis(50, vPan), tilt: axis(10, vTilt), zoom: axis(0, 0), focus: axis(0, 0) },
    moving: false, enabled: true, estop: false, lastUpdateMs: 10_000,
    ...over,
  } as DeviceState;
}
const SIGNS = { panSign: 1, tiltSign: 1 };

describe("sightPosture", () => {
  it("a still rig is taken as read", () => {
    expect(sightPosture(state({}), SIGNS, 300, 99_999)).toEqual(
      { panDeg: 50, tiltDeg: 10, moving: false, rateDps: 0, timingSigmaDeg: 0 });
  });

  it("a slowly moving rig is carried to the video instant", () => {
    // read at t=10.0 s, now 10.4 s, video latency 0.3 s -> seen at 10.1 s, 0.1 s after the read
    const p = sightPosture(state({ moving: true }, 0.8, -0.6), SIGNS, 300, 10_400);
    if ("error" in p) throw new Error(p.error);
    expect(p.panDeg).toBeCloseTo(50.08, 6);
    expect(p.tiltDeg).toBeCloseTo(9.94, 6);
    expect(p.rateDps).toBeCloseTo(1, 6);
    expect(p.timingSigmaDeg).toBeCloseTo(SIGHT_LATENCY_SIGMA_SEC, 6);
  });

  it("applies the user-frame signs to position and velocity", () => {
    // 0.2 s after the read, no video latency: pan -50 moving at -1 deg/s in the user frame
    const p = sightPosture(state({ moving: true }, 1, 0), { panSign: -1, tiltSign: 1 }, 0, 10_200);
    if ("error" in p) throw new Error(p.error);
    expect(p.panDeg).toBeCloseTo(-50.2, 6);
  });

  it("refuses a moving read that is not fresh", () => {
    const p = sightPosture(state({ moving: true }, 0.5), SIGNS, 300, 10_000 + SIGHT_MOVING_MAX_AGE_MS + 1);
    expect("error" in p && p.error).toMatch(/old/);
  });

  it("refuses a fast slew", () => {
    const p = sightPosture(state({ moving: true }, 3, 2), SIGNS, 300, 10_100);
    expect("error" in p && p.error).toMatch(/turning/);
  });

  it("refuses a moving rig with no axis telemetry", () => {
    const p = sightPosture(state({ moving: true, axes: undefined }), SIGNS, 300, 10_100);
    expect("error" in p).toBe(true);
  });
});
