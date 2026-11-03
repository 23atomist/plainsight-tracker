import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { TrackingSession } from "../src/shared/track/session.js";
import { Mat3 } from "../src/shared/geo/vec3.js";

// Identity R: the mount frame IS the ENU frame, so pan == azimuth and
// tilt == elevation. Keeps the expectations hand-checkable.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((45 * Math.PI) / 180);

let mock: FakeHead; let device: Device; let session: TrackingSession;

afterEach(async () => {
  session?.stop();
  device?.close();
  await mock?.stop();
});

// The cheapest guard against the fake's TRACK model drifting from what the
// head does (docs/HEAD-API.md, POST /api/track: "The Pico extrapolates and
// servos ... stops the axis if updates stop"). The closed-loop pass below is
// only as honest as this model: a fake that teleported onto each setpoint
// would pass a host that sent the wrong rate.
describe("FakeHead TRACK model", () => {
  it("extrapolates the setpoint at the commanded rate and servos the axis onto it", () => {
    const h = new FakeHead();
    h.model.axes.pan = { ...h.model.axes.pan, pos: 0, tgt: 1, vel: 2, mode: "T" };
    for (let i = 0; i < 16; i++) h.advance(50);    // 0.8s, under the 1s track timeout
    const pan = h.model.axes.pan;
    expect(pan.tgt).toBeCloseTo(1 + 2 * 0.8, 9);   // setpoint moved at vel
    expect(Math.abs(pan.pos - pan.tgt)).toBeLessThan(0.05); // and the axis caught it
    expect(pan.mode).toBe("T");
  });

  it("does not teleport: one step covers at most the feed-forward plus the catch-up", () => {
    const h = new FakeHead();
    h.model.axes.pan = { ...h.model.axes.pan, pos: 0, tgt: 10, vel: 0, mode: "T" };
    h.advance(50);
    expect(h.model.axes.pan.pos).toBeGreaterThan(0);
    expect(h.model.axes.pan.pos).toBeLessThan(10 * 5 * 0.05 + 1e-9);
  });

  it("stops the axis when TRACK updates stop (the Pico's track timeout)", () => {
    const h = new FakeHead();
    h.model.axes.pan = { ...h.model.axes.pan, pos: 0, tgt: 0, vel: 3, mode: "T" };
    for (let i = 0; i < 21; i++) h.advance(50);    // 1.05s with no TRACK
    expect(h.model.axes.pan.mode).toBe("I");
    expect(h.model.axes.pan.vel).toBe(0);
  });
});

describe("closed-loop tracking simulation", () => {
  it("holds pointing error bounded while chasing a crossing target", async () => {
    mock = new FakeHead();
    await mock.start();   // ephemeral port
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: mock.url });
    device = new Device(cfg);
    device.start();

    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sim-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I, new Date(0).toISOString());
    await sleep(200);

    // An aircraft 8km north at 2km altitude, flying East at 120 m/s.
    // Over 4s it moves ~480m — a slow azimuth sweep the rig can hold.
    const northM = 8000, upM = 2000, speed = 120;
    const t0 = Date.now();
    const posAt = (tSec: number) => ({
      lat: RIG.lat + northM / M_PER_DEG_LAT,
      lon: RIG.lon + (speed * tSec) / M_PER_DEG_LON,
      height: upM,
    });

    session = new TrackingSession(device, cfg, store);
    expect(session.start(posAt(0), null, "sim")).toBeNull();

    // Feed fixes at 2Hz with a stated velocity (due East).
    const feeder = setInterval(() => {
      const tSec = (Date.now() - t0) / 1000;
      session.updateTarget(posAt(tSec), [speed, 0, 0]);
    }, 500);

    // Let it acquire, then sample the error while tracking.
    await sleep(2500);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      const st = session.status();
      if (st.state === "tracking" && st.pointingErrorDeg !== null) samples.push(st.pointingErrorDeg);
    }
    clearInterval(feeder);

    expect(session.status().state).toBe("tracking");
    expect(samples.length).toBeGreaterThan(4);
    const worst = Math.max(...samples);
    // The loop must actually follow -- not merely avoid diverging. The head
    // model servos onto the TRACK setpoint extrapolated at the TRACK rate, so
    // a wrong setpoint, a wrong or missing feed-forward, or a sign error all
    // show up here as following error. 0.5deg is the bound the jog-era servo
    // was held to on this same pass; it catches a wrong setpoint (a 1deg pos
    // error measured 1.0deg) but NOT a feed-forward fault, because the
    // setpoint is refreshed every tick. Measured worst error, 3 runs each:
    // correct 0.030deg, vel zeroed 0.22deg, vel sign flipped 0.41deg. So the
    // second bound sits 4x above the correct baseline and below both faults.
    expect(worst).toBeLessThan(0.5);
    expect(worst).toBeLessThan(0.12);
    // And it was the TRACK that did it: the session servoed through it.
    expect(mock.lastTrack?.pan).toBeDefined();
  }, 15000);

  it("stops commanding motion when target updates dry up", async () => {
    mock = new FakeHead();
    await mock.start();   // ephemeral port
    const cfg = loadConfig(undefined, {
      TB3_HEAD_URL: mock.url,
      TB3_TRACK_MAX_TARGET_AGE_MS: "400",
    });
    device = new Device(cfg);
    device.start();

    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-sim2-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I, new Date(0).toISOString());
    await sleep(200);

    session = new TrackingSession(device, cfg, store);
    session.start({ lat: RIG.lat + 8000 / M_PER_DEG_LAT, lon: RIG.lon, height: 2000 }, [0, 0, 0], "stale");

    // Never call updateTarget again: the fix goes stale and motion must cease.
    await sleep(1500);
    expect(session.status().state).toBe("waiting");
    expect(session.status().reason).toBe("target_stale");
    // The session stopped the head on the way into waiting...
    expect(mock.stopCount).toBeGreaterThan(0);
    expect(mock.model.axes.pan.mode).toBe("I");
    expect(mock.model.axes.tilt.mode).toBe("I");
    // ...and sends nothing more while it waits.
    const tracksBefore = mock.calls.filter((c) => c.path === "/api/track").length;
    await sleep(300);
    expect(mock.calls.filter((c) => c.path === "/api/track").length).toBe(tracksBefore);
  }, 15000);
});
