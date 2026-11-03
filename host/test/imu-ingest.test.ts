import { describe, it, expect, afterEach } from "vitest";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";

const PORT = 8803;
let mock: FakeHead | null = null;
let dev: Device | null = null;

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
}

afterEach(async () => { dev?.close(); dev = null; if (mock) { await mock.stop(); mock = null; } });

describe("DeviceState.imu ingestion", () => {
  it("populates imu from the WS tick", async () => {
    mock = new FakeHead();
    mock.model.imu = {
      ok: true, heading: 271.5, pitch: 1.5, roll: -2.0, cal: { sys: 3, gyr: 3, acc: 2, mag: 1 }, tempC: 25.4,
    };
    await mock.start({ port: PORT });
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: `http://127.0.0.1:${PORT}` });
    dev = new Device(cfg); dev.start();
    await waitFor(() => dev!.getState().imu !== undefined);
    expect(dev.getState().imu).toEqual({
      ok: true, heading: 271.5, pitch: 1.5, roll: -2.0, cal: { sys: 3, gyr: 3, acc: 2, mag: 1 }, tempC: 25.4,
    });
  });

  it("an IMU that is not ok reaches the state as ok:false with null readings", async () => {
    mock = new FakeHead();
    mock.model.imu = { ok: false, heading: null, pitch: null, roll: null, cal: null, tempC: null };
    await mock.start({ port: PORT });
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: `http://127.0.0.1:${PORT}` });
    dev = new Device(cfg); dev.start();
    await waitFor(() => dev!.getState().imu !== undefined);
    const imu = dev.getState().imu;
    expect(imu?.ok).toBe(false);
    expect(imu?.pitch).toBeNull();
  });
});
