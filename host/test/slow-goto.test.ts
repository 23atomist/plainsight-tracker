// I2: the head moves a goto at the Pico's vmax (5 deg/s by default), not at
// cfg.maxSpeedDps, so the arrival budget must come from the head's config.
// The FakeHead here slews at its configured vmax, and both it and the Device
// run on a virtual clock stepped 50x faster than real time, so a 36 s slew
// takes well under a second of test time.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig, type Config } from "../src/shared/config.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { TrackingSession, realScheduler } from "../src/shared/track/session.js";
import { gotoArrivalBudgetMs, moveToUserAngle } from "../src/mcp/move.js";
import { Mat3 } from "../src/shared/geo/vec3.js";

const STEP_MS = 100;   // virtual ms per step
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let head: FakeHead;
let device: Device;
let stepper: NodeJS.Timeout | null = null;
let session: TrackingSession | undefined;
let virtualMs = 1_000_000;

afterEach(async () => {
  if (stepper) clearInterval(stepper);
  stepper = null;
  session?.stop();
  session = undefined;
  device?.close();
  await head?.stop();
});

// A head at the Pico's real speed (pan vmax 5 deg/s, amax 10) on a virtual clock.
async function slowHead(
  onStep: () => void = () => {}, panPatch: Record<string, number> = {},
): Promise<Config> {
  head = new FakeHead();
  head.gotoAtVmax = true;
  head.config.pan = { ...head.config.pan, ...panPatch };
  await head.start({ tickMs: 0 });
  const cfg = loadConfig(undefined, { TB3_HEAD_URL: head.url, TB3_MAX_SPEED_DPS: "30" });
  device = new Device(cfg, () => virtualMs);
  device.start();
  stepper = setInterval(() => {
    virtualMs += STEP_MS;
    head.advance(STEP_MS);
    head.tick();
    onStep();
  }, 2);
  head.setConfig("pan", { vmax: 5, amax: 10 });
  const t0 = Date.now();
  while (device.getAxisConfig()?.pan.vmax !== 5) {
    if (Date.now() - t0 > 3000) throw new Error("the head's config never arrived");
    await sleep(10);
  }
  return cfg;
}

describe("gotoArrivalBudgetMs", () => {
  const cfg = loadConfig(undefined, { TB3_MAX_SPEED_DPS: "30", TB3_TRACK_FALLBACK_AMAX_DPS2: "10" });
  const axis = (vmax: number, amax: number) => ({ min: -180, max: 180, vmax, amax });

  it("sizes from the slower axis's vmax/amax, x1.5 + 3 s", () => {
    const b = gotoArrivalBudgetMs({ pan: 180, tilt: 10 }, { pan: axis(5, 10), tilt: axis(20, 10) }, cfg);
    expect(b).toBeCloseTo((180 / 5 + 5 / 10) * 1500 + 3000, 6);
  });

  it("falls back to maxSpeedDps and the fallback amax only while the head's config is unknown", () => {
    const b = gotoArrivalBudgetMs({ pan: 180, tilt: 0 }, null, cfg);
    expect(b).toBeCloseTo((180 / 30 + 30 / 10) * 1500 + 3000, 6);
  });

  it("never drops below 5 s", () => {
    expect(gotoArrivalBudgetMs({ pan: 0.1, tilt: 0 }, { pan: axis(90, 1000), tilt: axis(90, 1000) }, cfg)).toBe(5000);
  });
});

describe("a long goto on a slow head (vmax 5 deg/s)", () => {
  it("goto of 180 deg arrives instead of timing out", async () => {
    const cfg = await slowHead();
    const t0 = virtualMs;
    const moved = await moveToUserAngle(device, cfg, 180, 0);
    expect(moved).toMatchObject({ arrived: true, pan_deg: 180 });
    // It really was slow: ~36 s of head time, past the ESP32-era budget of
    // 180/30*3 + 3 = 21 s.
    expect(virtualMs - t0).toBeGreaterThan(35_000);
  }, 15000);

  it("a tracking acquire across 170 deg reaches tracking with no goto_failed", async () => {
    const reasons = new Set<string>();
    // A target 10 km out at bearing 170 deg, 1 km up (pan 170 under identity
    // R), drifting east at 10 m/s: a fix that repeats the last position does
    // not count as fresh, so a parked target would go stale mid-slew.
    const brg = (170 * Math.PI) / 180;
    const SPEED_E = 10;
    const startMs = virtualMs;
    const targetAt = (ms: number) => ({
      lat: RIG.lat + (10_000 * Math.cos(brg)) / 111_320,
      lon: RIG.lon + (10_000 * Math.sin(brg) + SPEED_E * (ms - startMs) / 1000) /
        (111_320 * Math.cos((RIG.lat * Math.PI) / 180)),
      height: 1000,
    });
    let steps = 0;
    const cfg = await slowHead(() => {
      if (!session) return;
      if (++steps % 10 === 0) session.updateTarget(targetAt(virtualMs), [SPEED_E, 0, 0]);
      const r = session.status().reason;
      if (r) reasons.add(r);
    });
    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-slow-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I, new Date(0).toISOString());
    session = new TrackingSession(
      device, cfg, store, () => virtualMs, realScheduler,
      undefined, undefined, undefined, undefined, () => device.getAxisConfig(),
    );
    const t0 = virtualMs;
    expect(session.start(targetAt(virtualMs), [SPEED_E, 0, 0], "far")).toBeNull();
    const r0 = Date.now();
    while (session.status().state !== "tracking") {
      if (Date.now() - r0 > 10_000) throw new Error(`never reached tracking (reasons seen: ${[...reasons].join(", ")})`);
      await sleep(10);
    }
    expect(virtualMs - t0).toBeGreaterThan(30_000);
    expect([...reasons]).not.toContain("goto_failed");
  }, 15000);
});

// Field 2026-11-04: the IMU sweep's leg from (-177, 45) to (+177, 45) never
// "arrived". The Pico's pan is periodic (CFG period 360, limits ±270): it
// moved 6° to -183, the equivalent of +177 nearest its position, while the
// host waited ~110 s for the counter to read +177 and then timed out.
describe("a goto across the ±180 seam on a periodic pan", () => {
  it("arrives at the Pico's own pick (-183) in seconds instead of timing out", async () => {
    const cfg = await slowHead(() => {}, { min: -270, max: 270, period: 360 });
    // From -150 (33° short of the seam, so the budget outlasts the wait
    // loop's first real-time sleep on this 50x virtual clock): +177 is a
    // 33° move to -183, where the old code would have waited ~100 s for the
    // counter to read +177.
    head.model.axes.pan = { ...head.model.axes.pan, pos: -150, tgt: -150 };
    head.tick();
    await sleep(20);
    const t0 = virtualMs;
    const moved = await moveToUserAngle(device, cfg, 177, 0);
    expect(moved).toMatchObject({ arrived: true, pan_deg: -183 });
    expect(head.lastGoto).toMatchObject({ pan: 177 }); // the request is still the user's angle
    expect(virtualMs - t0).toBeLessThan(20_000);       // 33° at 5°/s, not 327°
  }, 15000);
});
