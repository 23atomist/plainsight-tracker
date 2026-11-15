import { describe, it, expect } from "vitest";
import { gaugeAngle, compassTransform, tiltTransform, GAUGE_SWEEP_DEG, fmtDeg } from "../dashboard/public/rig-gauges.js";

describe("rig gauges -- pure angle mapping", () => {
  it("maps the gauge range linearly onto the sweep, centred on zero", () => {
    expect(gaugeAngle(0, -20, 20)).toBe(0);
    expect(gaugeAngle(20, -20, 20)).toBe(GAUGE_SWEEP_DEG / 2);
    expect(gaugeAngle(-20, -20, 20)).toBe(-GAUGE_SWEEP_DEG / 2);
    expect(gaugeAngle(10, -20, 20)).toBeCloseTo(GAUGE_SWEEP_DEG / 4, 9);
  });
  it("clamps out-of-range values to the sweep ends rather than spinning the needle round", () => {
    expect(gaugeAngle(500, -20, 20)).toBe(GAUGE_SWEEP_DEG / 2);
    expect(gaugeAngle(-500, -20, 20)).toBe(-GAUGE_SWEEP_DEG / 2);
  });
  it("parks the needle at the low end for a missing value", () => {
    expect(gaugeAngle(null, -20, 20)).toBe(-GAUGE_SWEEP_DEG / 2);
    expect(gaugeAngle(undefined, -20, 20)).toBe(-GAUGE_SWEEP_DEG / 2);
    expect(gaugeAngle(NaN, -20, 20)).toBe(-GAUGE_SWEEP_DEG / 2);
  });
  it("compass: pan degrees rotate the needle clockwise about the dial centre", () => {
    expect(compassTransform(0)).toBe("rotate(0 50 50)");
    expect(compassTransform(73.451)).toBe("rotate(73.5 50 50)");
    expect(compassTransform(-10)).toBe("rotate(350 50 50)");
    expect(compassTransform(null)).toBe("rotate(0 50 50)");
  });
  it("tilt: 0 is the horizon (needle along +x), 90 is straight up; clamped to the quadrant", () => {
    expect(tiltTransform(0)).toBe("rotate(0 20 80)");
    expect(tiltTransform(45)).toBe("rotate(-45 20 80)");
    expect(tiltTransform(90)).toBe("rotate(-90 20 80)");
    expect(tiltTransform(120)).toBe("rotate(-90 20 80)");
    expect(tiltTransform(-5)).toBe("rotate(0 20 80)");
  });
  it("fmtDeg renders one decimal with a degree sign and a dash for unavailable", () => {
    expect(fmtDeg(4.86)).toBe("4.9°");
    expect(fmtDeg(null)).toBe("—");
  });
});
