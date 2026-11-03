import { describe, it, expect } from "vitest";
import { parseHeadState, parseServiceState } from "../src/dashboard/parse.js";

// The GET /api/state body: the tick object (docs/HEAD-API.md, Telemetry).
const TICK = {
  type: "tick", t: 1762150000123, seq: 41877,
  axes: {
    pan: { pos: 123.4, vel: 0.8, tgt: 123.9, mode: "T", homed: true, endstop: false, driver: true },
    tilt: { pos: 31.2, vel: 0.1, tgt: 31.3, mode: "T", homed: true, endstop: false, driver: true },
    zoom: { pos: 0, vel: 0, tgt: 0, mode: "I", homed: false, endstop: false, driver: true },
    focus: { pos: 0, vel: 0, tgt: 0, mode: "I", homed: false, endstop: false, driver: true },
  },
  enabled: true, moving: true, estop: false,
  imu: { ok: true, heading: 124.0, pitch: 31.5, roll: -0.4, cal: { sys: 3, gyr: 3, acc: 3, mag: 2 }, tempC: 28 },
  tiltDisagreeDeg: 0.3,
  ref: { pan: "imu", persisted: true, ageS: 812.4 },
  link: { pico: true, imu: true },
};

// The same tick with the Pico link down: no motion telemetry.
const { axes: _axes, enabled: _enabled, moving: _moving, ...NO_AXES_REST } = TICK;
const NO_AXES = { ...NO_AXES_REST, link: { pico: false, imu: true } };

describe("parseHeadState", () => {
  it("parses a full tick into degrees (device frame)", () => {
    const r = parseHeadState(TICK);
    expect(r).toEqual({
      connected: true, panDeg: 123.4, tiltDeg: 31.2, moving: true, estop: false,
      ref: { pan: "imu", persisted: true, ageS: 812.4 },
      imu: TICK.imu,
      tiltDisagreeDeg: 0.3,
      link: { pico: true, imu: true },
    });
  });

  it("carries the E-STOP latch", () => {
    expect(parseHeadState({ ...TICK, estop: true }).estop).toBe(true);
  });

  it("a tick without axes is connected, with null angles and motion", () => {
    const r = parseHeadState(NO_AXES);
    expect(r.connected).toBe(true);
    expect(r.panDeg).toBeNull();
    expect(r.tiltDeg).toBeNull();
    expect(r.moving).toBeNull();
    expect(r.imu?.ok).toBe(true);
    expect(r.link).toEqual({ pico: false, imu: true });
  });

  it("garbage, a non-tick, or a tick that breaks the schema → not connected, never throws", () => {
    for (const raw of [null, "nope", {}, { ...TICK, type: "event" }, { ...TICK, estop: "no" }, { ...TICK, extra: 1 }]) {
      const r = parseHeadState(raw);
      expect(r.connected).toBe(false);
      expect(r.panDeg).toBeNull();
      expect(r.ref).toBeNull();
      expect(r.imu).toBeNull();
      expect(r.link).toBeNull();
    }
  });

  it("an ESP32 /api/status body is not a head state", () => {
    expect(parseHeadState({ pos: { pan: 0, tilt: 0, aux: 0 }, moving: 0 }).connected).toBe(false);
  });

  it("returns copies, not references into the parsed body", () => {
    const raw = structuredClone(TICK);
    const r = parseHeadState(raw);
    raw.ref.pan = "none";
    raw.imu.cal.mag = 0;
    expect(r.ref?.pan).toBe("imu");
    expect(r.imu?.cal?.mag).toBe(2);
  });
});

describe("parseServiceState", () => {
  it("maps systemctl is-active output", () => {
    expect(parseServiceState("active\n")).toBe("active");
    expect(parseServiceState("inactive")).toBe("inactive");
    expect(parseServiceState("failed")).toBe("failed");
    expect(parseServiceState("activating")).toBe("inactive");
    expect(parseServiceState("")).toBe("unknown");
    expect(parseServiceState("weird")).toBe("unknown");
  });
});
