import { afterEach, describe, it, expect, vi } from "vitest";
import { gravityFromBurst } from "../src/shared/geo/gravity.js";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";
import type { ImuBurst } from "../src/shared/imu-stats.js";

// Shared across the direction-check tests below: two accel samples averaging
// to [0.11, 0.61, 0.91], so the expected unit direction is fixed once here.
const RAW_IMU_JSON =
  '{"info":{"present":true,"mpu_who":"0x68","mag_who":"0x00","bmp_id":"0x00","accel_fs_g":4,"gyro_fs_dps":500},' +
  '"n":2,"span_us":1000,"read_errors":0,' +
  '"samples":[[0,0.10,0.60,0.90,0,0,0,null,null,null,nan,nan],' +
  '[1000,0.12,0.62,0.92,0,0,0,null,null,null,nan,nan]]}';

function expectMeanGravityDirection(g: readonly [number, number, number]): void {
  expect(Math.hypot(g[0], g[1], g[2])).toBeCloseTo(1, 9);
  const n = Math.hypot(0.11, 0.61, 0.91);
  expect(g[0]).toBeCloseTo(0.11 / n, 6);
  expect(g[2]).toBeCloseTo(0.91 / n, 6);
}

describe("gravityFromBurst", () => {
  it("returns the normalized mean accel direction", () => {
    const burst: ImuBurst = {
      info: { present: true, mpu_who: "0x68", mag_who: "0x00", bmp_id: "0x00", accel_fs_g: 4, gyro_fs_dps: 500 },
      n: 2, span_us: 200000, read_errors: 0,
      samples: [
        [0, 0.10, 0.60, 0.90, 0, 0, 0, null, null, null, null, null],
        [1000, 0.12, 0.62, 0.92, 0, 0, 0, null, null, null, null, null],
      ],
    };
    const g = gravityFromBurst(burst);
    expectMeanGravityDirection(g);
  });
});

describe("Device.getGravity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The head's GET /api/imu burst (docs/head-api/schemas/imu-burst.json):
  // getGravity averages the BNO055's fused `gravity` vectors and normalizes,
  // so the result is the same unit direction gravityFromBurst gives for the
  // old raw-accel burst -- characterize_imu, set_north_zero and
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
