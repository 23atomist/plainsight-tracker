import { describe, it, expect } from "vitest";
import { moveToUserAngle, picoTarget } from "../src/mcp/move.js";
import { loadConfig } from "../src/shared/config.js";
import { Device } from "../src/shared/device.js";

describe("moveToUserAngle", () => {
  it("prefixes device rejections with 'device rejected goto:'", async () => {
    const cfg = loadConfig(undefined, {});
    const fakeDevice = {
      getState: () => ({ estop: false }),
      getAxisConfig: () => null,
      gotoAngle: async () => {
        throw new Error("busy - program engaged");
      },
    } as unknown as Device;
    await expect(moveToUserAngle(fakeDevice, cfg, 0, 0)).rejects.toThrow(
      /device rejected goto:/,
    );
  });
});

// Mirrors the firmware's pickTarget (plainsight firmware motion.cpp): for an
// axis with a `period` the Pico moves to the equivalent angle (+period*k)
// nearest its current position that lies inside its soft limits, and the
// step loop clamps any target to those limits.
describe("picoTarget (where the Pico actually takes a goto)", () => {
  const pan = { min: -270, max: 270, vmax: 5, amax: 10, period: 360 };

  it("is the request itself when the head's config is unknown or the axis has no period", () => {
    expect(picoTarget(177, -177, undefined)).toBe(177);
    expect(picoTarget(177, -177, { ...pan, period: 0 })).toBe(177);
    expect(picoTarget(45, 10, { ...pan, period: undefined })).toBe(45);
  });

  it("takes the equivalent nearest the current position: +177 from -177 lands at -183", () => {
    expect(picoTarget(177, -177, pan)).toBe(-183);
    expect(picoTarget(-177, 177, pan)).toBe(183);
  });

  it("skips an equivalent outside the Pico's soft limits: 0 from -183 is 0, not -360", () => {
    expect(picoTarget(0, -183, pan)).toBe(0);
  });

  it("prefers an in-limit equivalent a turn away when it is nearer: 100 from -183 is -260", () => {
    expect(picoTarget(100, -183, pan)).toBe(-260);
  });

  it("clamps to the soft limits when no equivalent lies inside them", () => {
    expect(picoTarget(150, 0, { ...pan, min: -100, max: 100 })).toBe(100);
    expect(picoTarget(95, 0, { ...pan, min: -2, max: 90, period: 0 })).toBe(90);
  });
});
