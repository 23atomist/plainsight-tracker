// I4 / spec 6.1: the host's limits are clamped to the Pico's own (GET
// /api/config). Before this the host planned straight into a range the
// operator had narrowed on the Pico: the target read as reachable, the Pico
// clamped the TRACK, and the session churned instead of saying pan_limit.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig, type Config } from "../src/shared/config.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { LimitsStore, hostCeiling, ceilingWiderThanPico, effectiveLimits } from "../src/shared/limits-store.js";
import { TrackingSession, realScheduler } from "../src/shared/track/session.js";
import { moveToUserAngle } from "../src/mcp/move.js";
import { applyTeachLimit } from "../src/mcp/limits-tools.js";
import { Mat3 } from "../src/shared/geo/vec3.js";

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const axis = (min: number, max: number) => ({ min, max, vmax: 5, amax: 10 });

describe("hostCeiling / ceilingWiderThanPico", () => {
  const cfg = { panMin: -180, panMax: 180, tiltMin: 0, tiltMax: 90, panSign: 1, tiltSign: 1 };

  it("is the config ceiling until the head's config is known", () => {
    expect(hostCeiling(cfg, null)).toEqual({ panMin: -180, panMax: 180, tiltMin: 0, tiltMax: 90 });
    expect(ceilingWiderThanPico(cfg, null)).toEqual([]);
  });

  it("intersects with the Pico's limits, per edge", () => {
    const pico = { pan: axis(-90, 200), tilt: axis(5, 85) };
    expect(hostCeiling(cfg, pico)).toEqual({ panMin: -90, panMax: 180, tiltMin: 5, tiltMax: 85 });
    expect(ceilingWiderThanPico(cfg, pico)).toEqual([
      "panMin -180 < Pico -90", "tiltMin 0 < Pico 5", "tiltMax 90 > Pico 85",
    ]);
  });

  it("mirrors the Pico's device-frame range into the user frame for a negative sign", () => {
    const pico = { pan: axis(-30, 120), tilt: axis(0, 90) };
    expect(hostCeiling({ ...cfg, panSign: -1 }, pico)).toMatchObject({ panMin: -120, panMax: 30 });
  });

  it("taught edges are clamped to it too", () => {
    const c = hostCeiling(cfg, { pan: axis(-90, 90), tilt: axis(0, 90) });
    expect(effectiveLimits(c, { panMax: 150 })).toMatchObject({ panMax: 90 });
  });
});

describe("a Pico narrowed to pan [-90, 90] (FakeHead)", () => {
  let head: FakeHead | null = null;
  let device: Device | null = null;
  let session: TrackingSession | null = null;
  afterEach(async () => {
    session?.stop();
    device?.close();
    if (head) await head.stop();
    head = null; device = null; session = null;
  });

  async function narrowed(): Promise<Config> {
    head = new FakeHead();
    await head.start();
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: head.url });
    device = new Device(cfg);
    device.start();
    head.setConfig("pan", { min: -90, max: 90 });
    const t0 = Date.now();
    while (device.getAxisConfig()?.pan.max !== 90) {
      if (Date.now() - t0 > 3000) throw new Error("the head's config never arrived");
      await sleep(20);
    }
    return cfg;
  }

  it("a target at pan 120 is pan_limit-unreachable and nothing moves", async () => {
    const cfg = await narrowed();
    expect(cfg.panMax).toBe(180);   // the config ceiling alone would allow it
    const store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-pico-")), "cal.json"));
    store.load();
    store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
    store.setOrientation(I, new Date(0).toISOString());
    session = new TrackingSession(
      device!, cfg, store, Date.now, realScheduler,
      undefined, undefined, undefined, undefined, () => device!.getAxisConfig(),
    );
    // 10 km at bearing 120, 1 km up: pan 120 under identity R.
    const brg = (120 * Math.PI) / 180;
    const target = {
      lat: RIG.lat + (10_000 * Math.cos(brg)) / 111_320,
      lon: RIG.lon + (10_000 * Math.sin(brg)) / (111_320 * Math.cos((RIG.lat * Math.PI) / 180)),
      height: 1000,
    };
    expect(session.start(target, [0, 0, 0], "east")).toBeNull();
    expect(session.status()).toMatchObject({ state: "waiting", reason: "pan_limit" });
    await sleep(300);
    expect(session.status().reason).toBe("pan_limit");
    expect(head!.gotoCount).toBe(0);
    expect(head!.lastTrack).toBeNull();
  }, 10000);

  it("an absolute move to pan 120 is refused before anything is sent", async () => {
    const cfg = await narrowed();
    await expect(moveToUserAngle(device!, cfg, 120, 10)).rejects.toThrow(/outside/);
    expect(head!.gotoCount).toBe(0);
  }, 10000);

  it("teach_limit clamps a capture past the Pico's limit to it", async () => {
    const cfg = await narrowed();
    const store = new LimitsStore(join(mkdtempSync(join(tmpdir(), "tb3-pico-")), "limits.json"));
    store.load();
    expect(applyTeachLimit(store, cfg, "panMax", 120, device!.getAxisConfig())).toEqual({ value: 90, clamped: true });
  }, 10000);
});
