import { describe, it, expect } from "vitest";
import {
  fitContain, angularOffset, projectOffset, clampToRect, boresightFromState, hfovFromState, overlayTargets,
} from "../dashboard/public/overlay-geometry.js";

describe("overlay geometry -- object-fit:contain picture box", () => {
  it("letterboxes a 16:9 picture in a squarer frame", () => {
    expect(fitContain(1000, 1000, 1280, 720)).toEqual({ x: 0, y: 218.75, w: 1000, h: 562.5 });
  });
  it("pillarboxes a 16:9 picture in a wider frame", () => {
    expect(fitContain(2000, 500, 1280, 720)).toEqual({ x: 555.5555555555555, y: 0, w: 888.8888888888889, h: 500 });
  });
  it("falls back to the whole frame when the source size is unknown", () => {
    expect(fitContain(800, 600, 0, 0)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});

describe("overlay geometry -- angles to pixels", () => {
  const rect = { x: 100, y: 50, w: 1200, h: 675 };
  it("wraps the azimuth difference into -180..180", () => {
    expect(angularOffset(350, 0, 10, 0).dAz).toBe(20);
    expect(angularOffset(10, 0, 350, 0).dAz).toBe(-20);
    expect(angularOffset(0, 10, 0, 25).dEl).toBe(15);
  });
  it("puts the boresight itself at the picture centre", () => {
    const p = projectOffset(0, 0, 60, rect);
    expect(p.x).toBeCloseTo(700, 6);
    expect(p.y).toBeCloseTo(387.5, 6);
    expect(p.inView).toBe(true);
  });
  it("puts half the horizontal FOV exactly on the picture's right edge", () => {
    const p = projectOffset(30, 0, 60, rect);
    expect(p.x).toBeCloseTo(1300, 6);
    expect(p.inView).toBe(true);
  });
  it("y grows downward for a target below the boresight", () => {
    const up = projectOffset(0, 5, 60, rect);
    const down = projectOffset(0, -5, 60, rect);
    expect(up.y).toBeLessThan(387.5);
    expect(down.y).toBeGreaterThan(387.5);
  });
  it("flags anything outside the frame or behind the camera as out of view", () => {
    expect(projectOffset(45, 0, 60, rect).inView).toBe(false);
    expect(projectOffset(120, 0, 60, rect).inView).toBe(false);
    expect(projectOffset(0, 40, 60, rect).inView).toBe(false);
  });
  it("clamps an out-of-view point onto the picture boundary along the ray from the centre", () => {
    const c = clampToRect(2000, 387.5, rect, 0);
    expect(c.x).toBeCloseTo(1300, 6);
    expect(c.y).toBeCloseTo(387.5, 6);
    const d = clampToRect(700, -1000, rect, 10);
    expect(d.x).toBeCloseTo(700, 6);
    expect(d.y).toBeCloseTo(60, 6);
  });
});

describe("overlay geometry -- state plumbing", () => {
  it("prefers the daemon's calibrated pointing, then the IMU, then nothing", () => {
    expect(boresightFromState({ pointing: { azDeg: 10, elDeg: 5, source: "calibration" }, rig: { imu: { ok: true, heading: 300, pitch: 1 } } }))
      .toEqual({ azDeg: 10, elDeg: 5, source: "calibration" });
    expect(boresightFromState({ pointing: null, rig: { imu: { ok: true, heading: 300, pitch: 1.5 } } }))
      .toEqual({ azDeg: 300, elDeg: 1.5, source: "imu" });
    expect(boresightFromState({ pointing: null, rig: { imu: { ok: false } } })).toBeNull();
    expect(boresightFromState({})).toBeNull();
  });
  it("derives the HFOV from a calibrated focal length, else the operator's setting", () => {
    // f = (w/2) / tan(hfov/2): 1280 px wide at f = 1108.5 px is a 60 deg field.
    expect(hfovFromState({ vision: { focalPx: 1108.5, frameSizePx: { widthPx: 1280, heightPx: 720 } } }, 45)).toBeCloseTo(60, 1);
    expect(hfovFromState({ vision: { focalPx: null, frameSizePx: { widthPx: 1280, heightPx: 720 } } }, 45)).toBe(45);
    expect(hfovFromState({}, 45)).toBe(45);
  });
  it("lists one target per aircraft with its screen point, in-view flag and label", () => {
    const rect = { x: 0, y: 0, w: 1200, h: 675 };
    const state = {
      pointing: { azDeg: 90, elDeg: 10, source: "calibration" },
      adsb: { aircraft: [
        { hex: "a1", callsign: "DAL1", azimuth_deg: 90, elevation_deg: 10, range_km: 5 },
        { hex: "b2", callsign: null, azimuth_deg: 270, elevation_deg: 10, range_km: 50 },
      ] },
    };
    const t = overlayTargets(state, { hfovDeg: 60, rect });
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ hex: "a1", label: "DAL1", inView: true });
    expect(t[0].x).toBeCloseTo(600, 6);
    expect(t[0].y).toBeCloseTo(337.5, 6);
    expect(t[1]).toMatchObject({ hex: "b2", label: "b2", inView: false });
    // behind the camera: still a finite point on the boundary, never NaN
    expect(Number.isFinite(t[1].x) && Number.isFinite(t[1].y)).toBe(true);
  });
  it("returns no targets without a boresight", () => {
    expect(overlayTargets({ adsb: { aircraft: [{ hex: "a1", azimuth_deg: 1, elevation_deg: 1 }] } }, { hfovDeg: 60, rect: { x: 0, y: 0, w: 10, h: 10 } })).toEqual([]);
  });
});
