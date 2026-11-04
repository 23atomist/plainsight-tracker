import { describe, it, expect } from "vitest";
import { moveToUserAngle } from "../src/mcp/move.js";
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
