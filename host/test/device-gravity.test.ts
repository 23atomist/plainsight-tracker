import { afterEach, describe, it, expect, vi } from "vitest";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";

function expectMeanGravityDirection(g: readonly [number, number, number]): void {
  expect(Math.hypot(g[0], g[1], g[2])).toBeCloseTo(1, 9);
  const n = Math.hypot(0.11, 0.61, 0.91);
  expect(g[0]).toBeCloseTo(0.11 / n, 6);
  expect(g[2]).toBeCloseTo(0.91 / n, 6);
}

describe("Device.getGravity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The head's GET /api/imu burst (docs/head-api/schemas/imu-burst.json):
  // getGravity averages the BNO055's fused `gravity` vectors and normalizes,
  // so the result is a unit direction -- characterize_imu, set_north_zero and
  // solve_calibration consume it unchanged.
  it("fetches /api/imu and returns the normalized mean of the gravity vectors", async () => {
    const sample = (gravity: number[]) => ({
      t: 1, heading: 0, roll: 0, pitch: 0, quat: [1, 0, 0, 0], gravity,
      linacc: [0, 0, 0], cal: { sys: 3, gyr: 3, acc: 3, mag: 3 }, tempC: 25,
    });
    const body = JSON.stringify({ n: 2, samples: [sample([0.10, 0.60, 0.90]), sample([0.12, 0.62, 0.92])] });
    const fetchMock = vi.fn(async (): Promise<Response> => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: "http://127.0.0.1:1" });
    const device = new Device(cfg);

    const g = await device.getGravity(2);

    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://127.0.0.1:1/api/imu?n=2");
    expectMeanGravityDirection(g);
  });
});
