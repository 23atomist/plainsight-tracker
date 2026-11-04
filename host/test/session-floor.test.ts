import { describe, it, expect, beforeEach } from "vitest";
import { Mat3 } from "../src/shared/geo/vec3.js";
import { TrackingSession, type Scheduler } from "../src/shared/track/session.js";
import type { DeviceState } from "../src/shared/types.js";
import type { HeadTrackCmd } from "../src/shared/head-types.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { loadConfig, type Config } from "../src/shared/config.js";
import { DISABLED_SECTOR, TrackSector } from "../src/shared/track/sector.js";
import { TrackFloor, DISABLED_FLOOR } from "../src/shared/track/floor.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same harness as test/session-sector.test.ts -- the floor is that gate's
// sibling, so it is observed the same way rather than through a new rig.
const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const RIG = { lat: 45, lon: 10, height: 0 };

// A target due south at distM, at the height that puts it near elDeg above the
// horizon. Flat-earth plus a curvature nudge; the tests below only ever place
// targets far from the floor (tens of degrees), so the approximation cannot
// flip which side of the gate a target lands on.
function elevationTarget(elDeg: number, distM = 10000): typeof RIG {
  const drop = (distM * distM) / (2 * 6_371_000);
  const height = distM * Math.tan((elDeg * Math.PI) / 180) + drop;
  const dLat = -distM / 111320;   // due south
  return { lat: RIG.lat + dLat, lon: RIG.lon, height };
}

function manualScheduler(): Scheduler & { fire(): void } {
  let fn: (() => void) | null = null;
  return {
    every(_ms, f) { fn = f; return { cancel() { fn = null; } }; },
    fire() { fn?.(); },
  };
}

class FakeDevice {
  panDeg = 0; tiltDeg = 0; moving = false; estop = false;
  lastUpdateMs = 1_000_000;
  // Every track() call, in order (the head's TRACK; Task 5 servos through it).
  tracks: HeadTrackCmd[] = [];
  gotos: { pan: number; tilt: number }[] = [];
  stopCalls = 0;
  getState(): DeviceState {
    return {
      connected: true, panDeg: this.panDeg, tiltDeg: this.tiltDeg, zoomDeg: 0, focusDeg: 0,
      moving: this.moving, enabled: true, estop: this.estop, tiltDisagreeDeg: null,
      ref: { pan: "imu", persisted: true, ageS: 0, frameId: "00000000000000a1" }, link: { pico: true, imu: true },
      lastUpdateMs: this.lastUpdateMs,
    };
  }
  async track(cmd: HeadTrackCmd) { this.tracks.push(cmd); }
  async gotoAngle(pan: number, tilt: number) {
    this.gotos.push({ pan, tilt });
    return new Promise<void>(() => {});   // never settles; goto resolution is out of scope
  }
  async waitForArrival() { return this.getState(); }
  // moveToUserAngle reads the head's axis config before the goto (picoTarget).
  getAxisConfig() { return null; }
  async stop() { this.stopCalls++; }
}

let clockMs = 1_000_000;
let store: CalibrationStore;
let cfg: Config;
let dev: FakeDevice;
let sched: ReturnType<typeof manualScheduler>;

const session = (floor: TrackFloor, sector: TrackSector = DISABLED_SECTOR): TrackingSession =>
  new TrackingSession(
    dev as never, cfg, store, () => clockMs, sched,
    () => sector, () => ({}), () => ({ panDeg: 0, tiltDeg: 0 }), () => floor,
  );

beforeEach(() => {
  clockMs = 1_000_000;
  cfg = loadConfig(undefined, {});
  store = new CalibrationStore(join(mkdtempSync(join(tmpdir(), "tb3-floor-")), "cal.json"));
  store.load();
  store.setRigLocation(RIG.lat, RIG.lon, RIG.height);
  store.setOrientation(I, new Date(0).toISOString());
  dev = new FakeDevice();
  dev.lastUpdateMs = clockMs;
  sched = manualScheduler();
});

describe("initial-acquire elevation floor", () => {
  // The whole point: beginAcquire() dispatches the first goto synchronously
  // inside start(). If only tick() gated elevation, start_tracking on a
  // low target would command one slew straight down into a neighbour's
  // window before the tick gate caught up. It must never leave.
  it("refuses to dispatch the initial goto toward a below-floor target", () => {
    const s = session({ enabled: true, minElevationDeg: 15 });

    expect(s.start(elevationTarget(3), [0, 0, 0], null)).toBeNull();

    expect(dev.gotos.length).toBe(0);
    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("below_min_elevation");
    expect(dev.tracks).toHaveLength(0);
    expect(dev.stopCalls).toBe(0);   // nothing was ever commanded, so nothing to stop
  });

  it("dispatches normally for a target above the floor", () => {
    const s = session({ enabled: true, minElevationDeg: 15 });

    expect(s.start(elevationTarget(40), [0, 0, 0], null)).toBeNull();

    expect(dev.gotos.length).toBe(1);
    expect(s.status().reason).not.toBe("below_min_elevation");
  });

  // A disabled floor must behave exactly as before the feature existed --
  // including for a target below the horizon, which is what the taught tilt
  // limit (not this gate) is there to catch.
  it("admits a below-horizon target when the floor is disabled", () => {
    const s = session(DISABLED_FLOOR);

    expect(s.start(elevationTarget(-5), [0, 0, 0], null)).toBeNull();

    expect(s.status().reason).not.toBe("below_min_elevation");
  });
});

describe("in-track elevation floor", () => {
  it("holds with reason 'below_min_elevation' when a tracked target descends below the floor", () => {
    const s = session({ enabled: true, minElevationDeg: 15 });

    expect(s.start(elevationTarget(40), [0, 0, 0], null)).toBeNull();
    s.forceStateForTest("tracking");

    s.updateTarget(elevationTarget(3), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();

    expect(s.status().state).toBe("waiting");
    expect(s.status().reason).toBe("below_min_elevation");
    expect(dev.tracks).toHaveLength(0);
    expect(dev.stopCalls).toBe(1);   // the head is stopped once on entering the hold
  });

  it("releases the hold when the target climbs back above the floor", () => {
    const s = session({ enabled: true, minElevationDeg: 15 });

    expect(s.start(elevationTarget(40), [0, 0, 0], null)).toBeNull();
    s.forceStateForTest("tracking");

    s.updateTarget(elevationTarget(3), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().reason).toBe("below_min_elevation");

    s.updateTarget(elevationTarget(40), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();
    expect(s.status().reason).not.toBe("below_min_elevation");
  });

  // Read fresh every tick, like sectorProvider and limitsProvider: raising the
  // floor mid-pass must take effect on the next tick, not need a restart.
  it("picks up a floor change mid-pass without a restart", () => {
    let floor: TrackFloor = DISABLED_FLOOR;
    const s = new TrackingSession(
      dev as never, cfg, store, () => clockMs, sched,
      () => DISABLED_SECTOR, () => ({}), () => ({ panDeg: 0, tiltDeg: 0 }), () => floor,
    );

    expect(s.start(elevationTarget(10), [0, 0, 0], null)).toBeNull();
    s.forceStateForTest("tracking");
    sched.fire();
    expect(s.status().reason).not.toBe("below_min_elevation");

    floor = { enabled: true, minElevationDeg: 25 };
    s.updateTarget(elevationTarget(10), [0, 0, 0]);
    dev.lastUpdateMs = clockMs;
    sched.fire();

    expect(s.status().reason).toBe("below_min_elevation");
  });
});
