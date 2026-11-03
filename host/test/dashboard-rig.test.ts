import { describe, it, expect } from "vitest";
import { RigDirectClient } from "../src/dashboard/rig.js";

// GET /api/state of the head: the tick object (docs/HEAD-API.md).
const BODY = {
  type: "tick", t: 1, seq: 1,
  axes: {
    pan: { pos: 10, vel: 0, tgt: 10, mode: "I", homed: true, endstop: false, driver: true },
    tilt: { pos: 0, vel: 0, tgt: 0, mode: "I", homed: true, endstop: false, driver: true },
    zoom: { pos: 0, vel: 0, tgt: 0, mode: "I", homed: false, endstop: false, driver: true },
    focus: { pos: 0, vel: 0, tgt: 0, mode: "I", homed: false, endstop: false, driver: true },
  },
  enabled: true, moving: false, estop: false,
  imu: { ok: true, heading: 0, pitch: 1, roll: 2, cal: { sys: 3, gyr: 3, acc: 3, mag: 3 }, tempC: 25 },
  tiltDisagreeDeg: null,
  ref: { pan: "imu", persisted: true, ageS: 0 },
  link: { pico: true, imu: true },
};

describe("RigDirectClient", () => {
  it("status reads the head's /api/state", async () => {
    const urls: string[] = [];
    const fetchOk = (async (url: string) => { urls.push(url); return { ok: true, json: async () => BODY }; }) as unknown as typeof fetch;
    const r = await new RigDirectClient(["1.2.3.4:8780"], fetchOk).status();
    expect(urls).toEqual(["http://1.2.3.4:8780/api/state"]);
    expect(r.connected).toBe(true);
    expect(r.panDeg).toBe(10);
    expect(r.imu?.ok).toBe(true);
  });
  it("status on fetch failure → not connected (never throws)", async () => {
    const bad = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    const r = await new RigDirectClient(["1.2.3.4"], bad).status();
    expect(r.connected).toBe(false);
  });
  it("stop POSTs and throws on non-ok (so the e-stop reports failure)", async () => {
    const bad = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(new RigDirectClient(["1.2.3.4"], bad).stop()).rejects.toThrow();
  });
});
