// Spec 6.8 rule 1: the head renamed pan (setpos, IMU reference, boot/reconnect
// restore) and reported the same physical position in the old frame
// (`previous`) and the new one (`pan`). Everything the host keeps against
// pan's zero must follow that rename EXACTLY, or every exclusion cone and
// every taught edge points at the wrong sky / the wrong cable position.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { LimitsStore, effectiveLimits } from "../src/shared/limits-store.js";
import { boresightEnu } from "../src/shared/track/control.js";
import { Mat3, Vec3, matMul, rotX, rotZ, deg2rad, matVec, normalize } from "../src/shared/geo/vec3.js";
import { applyPanReferenceChange, wireReferenceShift } from "../src/mcp/reference-shift.js";

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "tb3-refshift-")), name);
}

// A deliberately non-trivial solved orientation: heading, lean and roll all
// non-zero, so a shift applied about the WRONG axis (ENU up instead of the
// mount's pan axis) or with the wrong sign cannot pass by accident.
const R0: Mat3 = matMul(rotZ(deg2rad(-73.2)), matMul(rotX(deg2rad(2.1)), [[Math.cos(0.03), 0, Math.sin(0.03)], [0, 1, 0], [-Math.sin(0.03), 0, Math.cos(0.03)]]));
const CHEAD: Vec3 = normalize([0.021, 0.999, -0.013]);

function expectVecClose(a: Vec3, b: Vec3, tol: number): void {
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
}

describe("CalibrationStore.shiftPanZero", () => {
  for (const gp of [1, -1]) {
    for (const d of [10, -37.5, 170, -345, 0.25]) {
      it(`keeps the boresight fixed in ENU for the same physical pose (geoPanSign ${gp}, d ${d})`, () => {
        const s = new CalibrationStore(tmpFile("cal.json"), gp);
        s.setRigLocation(33.4, -112.1, 341);
        s.setGravityCalibration(R0, CHEAD, new Date(0).toISOString());
        s.shiftPanZero(d);
        const R1 = s.getOrientation()!;
        expect(s.getCHead()).toEqual(CHEAD);   // head frame: a pan rename cannot touch it
        for (const p of [-170, -90, -12.3, 0, 45, 133.7, 179]) {
          for (const t of [0, 10, 37, 80]) {
            expectVecClose(boresightEnu(R1, p + d, t, CHEAD, gp), boresightEnu(R0, p, t, CHEAD, gp), 1e-9);
          }
        }
      });
    }
  }

  it("persists the shift and keeps a provisional orientation provisional", () => {
    const f = tmpFile("cal.json");
    const s = new CalibrationStore(f, -1);
    s.setRigLocation(33.4, -112.1, 341);
    s.setProvisionalOrientation(R0, new Date(0).toISOString());
    s.shiftPanZero(25);
    const back = new CalibrationStore(f, -1);
    back.load();
    expect(back.isProvisional()).toBe(true);
    const R1 = back.getOrientation()!;
    expectVecClose(boresightEnu(R1, 25 + 5, 12, [0, 1, 0], -1), boresightEnu(R0, 5, 12, [0, 1, 0], -1), 1e-9);
  });

  it("is a no-op on a profile with no orientation and no sightings", () => {
    const s = new CalibrationStore(tmpFile("cal.json"), 1);
    s.setRigLocation(33.4, -112.1, 341);
    const before = s.get();
    s.shiftPanZero(42);
    expect(s.get()).toEqual(before);
  });
});

describe("shiftPanZero: sightings move with the zero and the fit is unchanged", () => {
  const rig = { lat: 33.4342, lon: -112.0116, height: 341 };
  // A leaning base (the field value): a gravity anchor that is not straight
  // down is exactly what makes "rotate the anchor too" load-bearing.
  const baseDown: Vec3 = [0.021361137701469406, -0.0010018516612047034, -0.9997713228980655];
  const sightings = [
    { lat: 33.53965130978854, lon: -112.06303832626297, height: 2590.97, panDeg: 23.922, tiltDeg: 10.222 },
    { lat: 33.461205238086146, lon: -111.99559060188349, height: 1322.23, panDeg: -22.581, tiltDeg: 18.475 },
    { lat: 33.30, lon: -112.30, height: 6000, panDeg: 61.3, tiltDeg: 14.9 },
    { lat: 33.52, lon: -111.95, height: 9000, panDeg: -71.8, tiltDeg: 21.7 },
    { lat: 33.20, lon: -112.05, height: 4000, panDeg: 158.4, tiltDeg: 9.1 },
  ];

  // anchor "baseDown": solve_calibration has verified one (it wins over the
  // IMU's). anchor "imu": only characterize_imu's dBase exists, so a wrong
  // rotation of imuMounting.dBase alone would show up as a changed fit.
  for (const anchor of ["baseDown", "imu"] as const)
  for (const gp of [1, -1]) {
    for (const d of [15, -120.5, 345]) {
      it(`anchor ${anchor}, geoPanSign ${gp}, d ${d}: sighting pans shift by +d, residuals unchanged, re-solve agrees`, () => {
        const s = new CalibrationStore(tmpFile("cal.json"), gp);
        s.setRigLocation(rig.lat, rig.lon, rig.height);
        s.setImuMounting([[1, 0, 0], [0, 1, 0], [0, 0, 1]], baseDown, 0.4);
        if (anchor === "baseDown") s.setBaseDown(baseDown);
        for (const x of sightings) s.addSighting({ ...x });
        const before = s.previewFit()!;
        expect(before).not.toBeNull();
        const pansBefore = s.get().sightings.map((x) => x.panDeg);
        const ids = s.get().sightings.map((x) => x.id);

        s.shiftPanZero(d);

        const after = s.get();
        expect(after.sightings.map((x) => x.id)).toEqual(ids);
        after.sightings.forEach((x, i) => expect(x.panDeg).toBeCloseTo(pansBefore[i] + d, 9));
        // The gravity anchors are mount-frame vectors: rotated, not dropped.
        if (anchor === "baseDown") expect(after.baseDown).toBeDefined();
        else expect(after.baseDown).toBeUndefined();
        expect(after.imuMounting?.dBase).toBeDefined();

        const refit = s.previewFit()!;
        expect(refit.stage).toBe(before.stage);
        expect(refit.usedCount).toBe(before.usedCount);
        expect(Math.abs(refit.rmsDeg - before.rmsDeg)).toBeLessThan(1e-6);
        refit.residualsDeg.forEach((r, i) => expect(Math.abs(r - before.residualsDeg[i])).toBeLessThan(1e-6));

        // The stored (shifted) orientation is the one a re-solve would produce.
        const R1 = s.getOrientation()!;
        for (const x of after.sightings) {
          expectVecClose(boresightEnu(R1, x.panDeg, x.tiltDeg, refit.cHead, gp),
            boresightEnu(refit.R, x.panDeg, x.tiltDeg, refit.cHead, gp), 1e-6);
        }
        // The cached fit follows too (get_calibration reports it).
        const cached = s.getLastFit()!;
        expectVecClose(matVec(cached.R, [0, 1, 0]), matVec(R1, [0, 1, 0]), 1e-12);
      });
    }
  }
});

describe("LimitsStore.shiftPan", () => {
  it("adds the delta to both pan edges, leaves tilt alone, and persists", () => {
    const f = tmpFile("limits.json");
    const s = new LimitsStore(f);
    s.setEdge("panMin", -100);
    s.setEdge("panMax", 120);
    s.setEdge("tiltMin", 5);
    s.shiftPan(10);
    expect(s.get()).toEqual({ version: 1, panMin: -90, panMax: 130, tiltMin: 5 });
    const back = new LimitsStore(f);
    back.load();
    expect(back.get()).toEqual({ version: 1, panMin: -90, panMax: 130, tiltMin: 5 });
  });

  it("an absent edge stays absent", () => {
    const s = new LimitsStore(tmpFile("limits.json"));
    s.setEdge("panMax", 50);
    s.shiftPan(-20);
    expect(s.get()).toEqual({ version: 1, panMax: 30 });
  });

  // The edges are positions on the Pico's CONTINUOUS pan counter (a cable
  // limits the axis), so they move by the counter's own shift and are never
  // folded into (-180, 180]. Folding would put an edge near +180 on the
  // opposite side of the travel: panMax 175 shifted by +10 is counter 185 --
  // past the head's own 180 limit, so the effective edge is the ceiling --
  // NOT -175, which would invert the range and claim the cable edge is
  // behind the rig.
  it("does not fold an edge into (-180, 180]: an edge near +180 stays on its side", () => {
    const s = new LimitsStore(tmpFile("limits.json"));
    s.setEdge("panMin", -170);
    s.setEdge("panMax", 175);
    s.shiftPan(10);
    expect(s.get()).toMatchObject({ panMin: -160, panMax: 185 });
    const eff = effectiveLimits({ panMin: -180, panMax: 180, tiltMin: 0, tiltMax: 90 }, s.get());
    expect(eff.panMin).toBe(-160);
    expect(eff.panMax).toBe(180);
  });

  // An IMU reference whose heading crossed the +-180 seam: previous 170,
  // pan -175 -- the counter really moved by -345, and the cable edge that
  // was at counter 175 is now at -170.
  it("follows a seam-crossing rename by the counter's real (unwrapped) shift", () => {
    const s = new LimitsStore(tmpFile("limits.json"));
    s.setEdge("panMin", -100);
    s.setEdge("panMax", 175);
    s.shiftPan(-175 - 170);
    expect(s.get()).toMatchObject({ panMin: -445, panMax: -170 });
    const eff = effectiveLimits({ panMin: -180, panMax: 180, tiltMin: 0, tiltMax: 90 }, s.get());
    expect(eff).toMatchObject({ panMin: -180, panMax: -170 });
  });
});

// A frame memory as HeadRefWatch keeps it, in memory.
function memFrames(known: string | null) {
  const m = { known, accepted: [] as string[] };
  return {
    m,
    frames: {
      knownFrameId: () => m.known,
      acceptFrame: (id: string) => { m.known = id; m.accepted.push(id); },
    },
  };
}

const A = "00000000000000aa", B = "00000000000000bb";

describe("applyPanReferenceChange", () => {
  function setup(panSign: 1 | -1, known: string | null = A) {
    const cal = new CalibrationStore(tmpFile("cal.json"), 1);
    cal.setRigLocation(33.4, -112.1, 341);
    cal.setGravityCalibration(R0, CHEAD, new Date(0).toISOString());
    const limits = new LimitsStore(tmpFile("limits.json"));
    limits.setEdge("panMin", -100);
    limits.setEdge("panMax", 100);
    const logs: string[] = [];
    const { m, frames } = memFrames(known);
    const deps = { panSign, stores: { calibration: cal, limits }, frames, log: (x: string) => { logs.push(x); } };
    return { cal, limits, logs, m, deps };
  }

  for (const panSign of [1, -1] as const) {
    it(`maps the device-frame delta into the user frame (panSign ${panSign})`, () => {
      const { cal, limits, logs, deps } = setup(panSign);
      const applied = applyPanReferenceChange({ source: "host", pan: 30, previous: 20, frameId: B }, deps);
      const dUser = 10 * panSign;
      expect(applied).toBe(dUser);
      expect(limits.get()).toMatchObject({ panMin: -100 + dUser, panMax: 100 + dUser });
      // The device pose that was previous=20 (user 20*panSign) is now 30 (user 30*panSign).
      expectVecClose(boresightEnu(cal.getOrientation()!, 30 * panSign, 15, CHEAD, 1),
        boresightEnu(R0, 20 * panSign, 15, CHEAD, 1), 1e-9);
      expect(logs.join("\n")).toMatch(/pan re-referenced/);
    });
  }

  it("shifts nothing (and logs) when the reference was dropped or there was no old frame", () => {
    const { cal, limits, logs, deps } = setup(1);
    const orientBefore = cal.getOrientation(); const limBefore = limits.get();
    expect(applyPanReferenceChange({ source: "none", pan: null, previous: null, frameId: null }, deps)).toBeNull();
    expect(applyPanReferenceChange({ source: "host", pan: 12, previous: null, frameId: B }, deps)).toBeNull();
    expect(cal.getOrientation()).toEqual(orientBefore);
    expect(limits.get()).toEqual(limBefore);
    expect(logs).toHaveLength(2);
  });

  it("every rename's frameId is accepted as the calibration's frame; a drop names none", () => {
    const { m, deps } = setup(1);
    applyPanReferenceChange({ source: "none", pan: null, previous: null, reason: "pan unhomed", frameId: null }, deps);
    expect(m.accepted).toEqual([]);
    applyPanReferenceChange({ source: "host", pan: 30, previous: 20, frameId: B }, deps);
    expect(m.known).toBe(B);
  });

  // E1: a reference with no old frame may have put pan's zero anywhere
  // relative to the frame the calibration was solved in.
  it("a reference with no previous frame flags the calibration unverified", () => {
    const { cal, deps } = setup(1);
    for (const source of ["imu", "host"] as const) {
      cal.confirmFrame();
      applyPanReferenceChange({ source, pan: 12, previous: null, frameId: B }, deps);
      expect(cal.isFrameUnverified()).toBe(true);
      expect(cal.frameUnverifiedReason()).toMatch(new RegExp(source));
    }
  });

  it("a restore of the calibration's own frame (reason restored, same frameId) does not flag it", () => {
    const { cal, deps } = setup(1, A);
    applyPanReferenceChange({ source: "imu", pan: 12, previous: null, reason: "restored", frameId: A }, deps);
    expect(cal.isFrameUnverified()).toBe(false);
  });

  // The reviewer's case: renamed to B while the host was away, dropped, then
  // B restored. "restored" alone would wave through a frame the calibration
  // was never in.
  it("a restore of a DIFFERENT frame than the calibration's is flagged", () => {
    const { cal, deps } = setup(1, A);
    applyPanReferenceChange({ source: "imu", pan: 12, previous: null, reason: "restored", frameId: B }, deps);
    expect(cal.isFrameUnverified()).toBe(true);
    expect(cal.frameUnverifiedReason()).toMatch(/not the calibration's frame/);
  });

  // N2: no frame on record (this host's first run against a frame-id head)
  // -- a restore is adopted, as the tick watch adopts its first id.
  it("a restore with no frame on record is adopt-only", () => {
    const { cal, m, deps } = setup(1, null);
    applyPanReferenceChange({ source: "imu", pan: 12, previous: null, reason: "restored", frameId: B }, deps);
    expect(cal.isFrameUnverified()).toBe(false);
    expect(m.known).toBe(B);
  });

  // N4: if flagging fails to persist, the frame must NOT be adopted -- the
  // tick watch then still sees an unexplained frame and flags it.
  it("does not accept the new frame when persisting the flag throws", () => {
    const { cal, m, deps } = setup(1, A);
    cal.markFrameUnverified = () => { throw new Error("disk full"); };
    expect(() => applyPanReferenceChange({ source: "host", pan: 12, previous: null, frameId: B }, deps)).toThrow(/disk full/);
    expect(m.known).toBe(A);
  });

  it("a drop (source none) does not flag it -- the unreferenced gate owns that state", () => {
    const { cal, deps } = setup(1);
    applyPanReferenceChange({ source: "none", pan: null, previous: null, reason: "pan unhomed", frameId: null }, deps);
    expect(cal.isFrameUnverified()).toBe(false);
  });

  it("a rename with a known delta does not flag it", () => {
    const { cal, deps } = setup(1);
    applyPanReferenceChange({ source: "host", pan: 30, previous: 20, frameId: B }, deps);
    expect(cal.isFrameUnverified()).toBe(false);
  });

  it("a zero delta writes nothing", () => {
    const { cal, deps } = setup(1);
    const calBefore = cal.get();
    expect(applyPanReferenceChange({ source: "imu", pan: 42, previous: 42, frameId: B }, deps)).toBe(0);
    expect(cal.get()).toEqual(calBefore);
  });
});

describe("wireReferenceShift against the head's pan_reference event", () => {
  let head: FakeHead | null = null;
  let device: Device | null = null;
  afterEach(async () => { device?.close(); device = null; if (head) { await head.stop(); head = null; } });

  async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    if (!pred()) throw new Error("waitFor timed out");
  }

  for (const sign of ["1", "-1"] as const) {
    it(`a rename event shifts the calibration and the limits (TB3_PAN_SIGN ${sign})`, async () => {
      head = new FakeHead();
      await head.start({ tickMs: 0 });
      const cfg = loadConfig(undefined, { TB3_HEAD_URL: head.url, TB3_PAN_SIGN: sign });
      device = new Device(cfg);
      device.start();
      await waitFor(() => device!.getState().connected && device!.getState().lastUpdateMs > 0);

      const cal = new CalibrationStore(tmpFile("cal.json"), cfg.geoPanSign);
      cal.setRigLocation(33.4, -112.1, 341);
      cal.setGravityCalibration(R0, CHEAD, new Date(0).toISOString());
      const limits = new LimitsStore(tmpFile("limits.json"));
      limits.setEdge("panMax", 100);
      const { m, frames } = memFrames(A);
      let renamed = 0;
      wireReferenceShift(device, {
        panSign: cfg.panSign, stores: { calibration: cal, limits }, frames, log: () => {},
        onRenamed: () => { renamed += 1; },
      });

      head.emitEvent({ type: "event", t: 1, name: "pan_reference", axis: null, detail: { source: "none", reason: "pan unhomed" } });
      head.emitEvent({ type: "event", t: 2, name: "pan_reference", axis: null, detail: { source: "host", pan: 10, previous: 0, frameId: B } });
      const expected = 100 + 10 * cfg.panSign;
      await waitFor(() => limits.get().panMax === expected);
      expectVecClose(boresightEnu(cal.getOrientation()!, 10 * cfg.panSign, 20, CHEAD, cfg.geoPanSign),
        boresightEnu(R0, 0, 20, CHEAD, cfg.geoPanSign), 1e-9);
      // Every pan_reference resets the sun guard's rate history (minor fix):
      // the drop and the rename both moved what "pan" means.
      expect(renamed).toBe(2);
      expect(m.known).toBe(B);
      expect(cal.isFrameUnverified()).toBe(false);

      // The head's restore of the frame the calibration is in (B, after the
      // shift above) is exempt...
      head.emitEvent({ type: "event", t: 3, name: "pan_reference", axis: null,
        detail: { source: "imu", pan: 40, previous: null, frameId: B, reason: "restored" } });
      await waitFor(() => renamed === 3);
      expect(cal.isFrameUnverified()).toBe(false);
      // ...a new frame with no previous is not.
      const C = "00000000000000cc";
      head.emitEvent({ type: "event", t: 4, name: "pan_reference", axis: null, detail: { source: "imu", pan: 7, previous: null, frameId: C } });
      await waitFor(() => cal.isFrameUnverified());
      expect(m.known).toBe(C);
    });
  }
});
