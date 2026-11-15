import { describe, it, expect } from "vitest";
import { mergeState, type SourceInputs, type ServicesState } from "../src/dashboard/state.js";

const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (error: string) => ({ ok: false as const, error });
const SVC: ServicesState = { mcp: "up", agentArmed: false, mediamtx: "up", adsb: "up", head: "up" };

const DEVICE_STATUS = {
  connected: true, pan_deg: 10, tilt_deg: 20, moving: false, estop: false, pan_ref: { source: "imu" as const },
  tilt_disagree_deg: 0.2, link: { pico: true, imu: true }, stale: false, last_update_age_ms: 100,
};
const HEAD_DIRECT = {
  connected: true, panDeg: 10, tiltDeg: 20, moving: false, estop: false,
  ref: { pan: "host" as const, persisted: false, ageS: 5, frameId: "00000000000000a1" },
  imu: { ok: true, heading: 90, pitch: 1, roll: 2, cal: { sys: 3, gyr: 3, acc: 3, mag: 3 }, tempC: 25 },
  tiltDisagreeDeg: 0.4, link: { pico: true, imu: false },
};

function inputs(over: Partial<SourceInputs> = {}): SourceInputs {
  return {
    deviceStatus: ok(DEVICE_STATUS),
    rigDirect: ok(HEAD_DIRECT),
    tracking: ok({ state: "stopped", label: null, target_azimuth_deg: null, target_elevation_deg: null,
      target_range_m: null, pointing_error_deg: null, pan_limited: false, tilt_limited: false,
      offset_pan_deg: 0, offset_tilt_deg: 0 }),
    tracked: ok({ hex: null }),
    calibration: ok({ calibrated: true, rig: { lat: 33, lon: -112, height: 0 }, sightings: [], solved_at: "2026-07-19T00:00:00Z", provisional: false }),
    sun: ok({ state: "monitoring", locked: false, separationDeg: 80, enabled: true }),
    services: SVC,
    adsb: ok({ rawCount: 12, aircraft: [], trackable: [] }),
    capture: ok({ autoEnabled: true, recording: false, passIcao: null, lastSnapshot: null, lastError: null, lastSkipReason: null }),
    camera: { enabled: false, streaming: false, viewers: 0 },
    ...over,
  };
}

describe("mergeState mode derivation", () => {
  it("idle when agent off and not tracking", () => {
    expect(mergeState(inputs(), 1000).mode).toBe("idle");
  });
  it("manual when agent off but tracking active", () => {
    const s = mergeState(inputs({ tracking: ok({ state: "tracking", label: "UAL1", target_azimuth_deg: 90,
      target_elevation_deg: 30, target_range_m: 40000, pointing_error_deg: 1.2, pan_limited: false, tilt_limited: false,
      offset_pan_deg: 0, offset_tilt_deg: 0 }),
      tracked: ok({ hex: "abc123" }) }), 1000);
    expect(s.mode).toBe("manual");
    expect(s.tracking.hex).toBe("abc123");
    expect(s.tracking.callsign).toBe("UAL1");
    expect(s.tracking.targetAzDeg).toBe(90);
  });
  it("autonomous when the agent is armed", () => {
    const s = mergeState(inputs({ services: { ...SVC, agentArmed: true },
      tracking: ok({ state: "tracking", label: "x", target_azimuth_deg: 1, target_elevation_deg: 1,
        target_range_m: 1, pointing_error_deg: 1, pan_limited: false, tilt_limited: false,
        offset_pan_deg: 0, offset_tilt_deg: 0 }) }), 1000);
    expect(s.mode).toBe("autonomous");
  });
  // Spec 6.4: armed is the operator's intent. An unknown flag (MCP down) is
  // not "armed", and neither is disarmed -- both fall through to the
  // tracking state.
  it("not autonomous when the armed flag is false or unknown (MCP down)", () => {
    expect(mergeState(inputs({ services: { ...SVC, agentArmed: false } }), 1000).mode).toBe("idle");
    expect(mergeState(inputs({ services: { ...SVC, mcp: "down", agentArmed: null } }), 1000).mode).toBe("idle");
  });
});

describe("mergeState tracking automation gates", () => {
  it("carries calibration_verified as calibrationVerified; null when absent or not polled", () => {
    const trk = { state: "waiting", label: null, target_azimuth_deg: null, target_elevation_deg: null,
      target_range_m: null, pointing_error_deg: null, pan_limited: false, tilt_limited: false,
      offset_pan_deg: 0, offset_tilt_deg: 0 };
    expect(mergeState(inputs({ tracking: ok({ ...trk, calibration_verified: false }) }), 1)
      .tracking.calibrationVerified).toBe(false);
    expect(mergeState(inputs({ tracking: ok({ ...trk, calibration_verified: true }) }), 1)
      .tracking.calibrationVerified).toBe(true);
    expect(mergeState(inputs({ tracking: ok(trk) }), 1).tracking.calibrationVerified).toBeNull();
    expect(mergeState(inputs({ tracking: err("down") }), 1).tracking.calibrationVerified).toBeNull();
  });

  it("carries pan_limits_verified as panLimitsVerified; null when absent or not polled", () => {
    const trk = { state: "waiting", label: null, target_azimuth_deg: null, target_elevation_deg: null,
      target_range_m: null, pointing_error_deg: null, pan_limited: false, tilt_limited: false,
      offset_pan_deg: 0, offset_tilt_deg: 0 };
    expect(mergeState(inputs({ tracking: ok({ ...trk, pan_limits_verified: false }) }), 1)
      .tracking.panLimitsVerified).toBe(false);
    expect(mergeState(inputs({ tracking: ok(trk) }), 1).tracking.panLimitsVerified).toBeNull();
    expect(mergeState(inputs({ tracking: err("down") }), 1).tracking.panLimitsVerified).toBeNull();
  });
});

describe("mergeState rig: the head's state", () => {
  it("prefers the daemon's get_status and carries estop/panRef/tiltDisagreeDeg/link; no battery", () => {
    const s = mergeState(inputs(), 1000);
    expect(s.rig).toEqual({
      connected: true, panDeg: 10, tiltDeg: 20, moving: false, telemetryAgeMs: 100,
      estop: false, panRef: "imu", tiltDisagreeDeg: 0.2, link: { pico: true, imu: true },
      imu: HEAD_DIRECT.imu,
    });
  });
  it("falls back to the direct read when the daemon is down", () => {
    const s = mergeState(inputs({ deviceStatus: err("daemon down") }), 1000);
    expect(s.rig.panRef).toBe("host");
    expect(s.rig.tiltDisagreeDeg).toBe(0.4);
    expect(s.rig.link).toEqual({ pico: true, imu: false });
  });
  it("reports E-STOP when either source sees the latch", () => {
    expect(mergeState(inputs({ rigDirect: ok({ ...HEAD_DIRECT, estop: true }) }), 1000).rig.estop).toBe(true);
    expect(mergeState(inputs({ deviceStatus: ok({ ...DEVICE_STATUS, estop: true }) }), 1000).rig.estop).toBe(true);
  });
  it("all-null when neither source is up", () => {
    const s = mergeState(inputs({ deviceStatus: err("x"), rigDirect: err("y") }), 1000);
    expect(s.rig).toMatchObject({ estop: false, panRef: null, tiltDisagreeDeg: null, link: null, imu: null });
  });
});

describe("mergeState degradation", () => {
  it("a failed source marks its field + records an error, others intact", () => {
    const s = mergeState(inputs({ deviceStatus: err("ECONNREFUSED"), rigDirect: err("timeout") }), 1000);
    expect(s.rig.connected).toBe(false);          // neither source up
    expect(s.rig.panDeg).toBeNull();
    expect(s.errors.some((e) => e.includes("ECONNREFUSED"))).toBe(true);
    expect(s.services.adsb).toBe("up");            // unaffected
    expect(s.calibration.calibrated).toBe(true);
  });
  it("rig connected via direct even when the daemon get_status fails", () => {
    const s = mergeState(inputs({ deviceStatus: err("daemon down") }), 1000);
    expect(s.rig.connected).toBe(true);            // rigDirect still up
    expect(s.rig.imu?.ok).toBe(true);
  });
  it("stamps ts and never throws on all-failed", () => {
    const allErr = err("x");
    const s = mergeState({ deviceStatus: allErr, rigDirect: allErr, tracking: allErr, tracked: allErr,
      calibration: allErr, sun: allErr, services: { mcp: "down", agentArmed: null, mediamtx: "down", adsb: "down", head: "down" },
      adsb: allErr, capture: allErr, camera: { enabled: false, streaming: false, viewers: 0 } }, 4242);
    expect(s.ts).toBe(4242);
    expect(s.mode).toBe("idle");
    expect(s.rig.connected).toBe(false);
    expect(s.adsb.aircraft).toEqual([]);
    expect(s.adsb.trackable).toEqual([]);
    expect(s.capture).toBeNull();
  });

  it("carries the camera streamer status through unchanged", () => {
    const s = mergeState(inputs({ camera: { enabled: true, streaming: true, viewers: 2 } }), 1000);
    expect(s.camera).toEqual({ enabled: true, streaming: true, viewers: 2 });
  });

  it("carries the jog ramp config through unchanged when present", () => {
    const s = mergeState(inputs({ jog: { maxJogDps: 12 } }), 1000);
    expect(s.jog).toEqual({ maxJogDps: 12 });
  });

  it("defaults the jog ramp config (mirroring config.ts) when a fixture omits it", () => {
    const s = mergeState(inputs(), 1000);
    expect(s.jog).toEqual({ maxJogDps: 19 });
  });

  // --- Fix round: a startup camera CONFIG error (item 1, final review) must
  // surface in `errors` every tick, independent of every polled Result leg. ---
  it("surfaces a persistent cameraError in `errors`, alongside a healthy poll", () => {
    const s = mergeState(inputs({ cameraError: "cameraFfmpegBin=\"/nope\" cannot be executed (ENOENT)" }), 1000);
    expect(s.errors.some((e) => e.includes("ENOENT"))).toBe(true);
    // Nothing else degrades -- this is a static startup fact, not a poll failure.
    expect(s.rig.connected).toBe(true);
    expect(s.calibration.calibrated).toBe(true);
  });

  it("omits any camera error when cameraError is absent/null", () => {
    const s = mergeState(inputs({ cameraError: null }), 1000);
    expect(s.errors).toEqual([]);
  });
});

describe("mergeState carries the drift-calibration offset + provisional flag", () => {
  it("passes the tracking aim-offset through", () => {
    const s = mergeState(inputs({ tracking: ok({ state: "tracking", label: "UAL1", target_azimuth_deg: 90,
      target_elevation_deg: 30, target_range_m: 40000, pointing_error_deg: 1.2, pan_limited: false, tilt_limited: false,
      offset_pan_deg: 2.3, offset_tilt_deg: -0.5 }) }), 1000);
    expect(s.tracking.offsetPanDeg).toBe(2.3);
    expect(s.tracking.offsetTiltDeg).toBe(-0.5);
  });
  it("defaults the offset to 0 when the tracking source is degraded", () => {
    const s = mergeState(inputs({ tracking: err("get_tracking_status failed") }), 1000);
    expect(s.tracking.offsetPanDeg).toBe(0);
    expect(s.tracking.offsetTiltDeg).toBe(0);
  });
  it("passes a provisional calibration through distinctly from a solved one", () => {
    const s = mergeState(inputs({ calibration: ok({
      calibrated: false, rig: { lat: 33, lon: -112, height: 0 }, sightings: [],
      solved_at: "2026-07-27T00:00:00Z", provisional: true,
    }) }), 1000);
    expect(s.calibration.provisional).toBe(true);
    expect(s.calibration.calibrated).toBe(false);
  });
  it("defaults provisional to false when the calibration source is degraded", () => {
    const s = mergeState(inputs({ calibration: err("get_calibration failed") }), 1000);
    expect(s.calibration.provisional).toBe(false);
  });
});

describe("mergeState carries the effective travel limits (rigview.js's envelope)", () => {
  it("passes the effective range through when the poll succeeds", () => {
    const s = mergeState(inputs({
      limits: ok({ panMinDeg: -60, panMaxDeg: 45, tiltMinDeg: -20, tiltMaxDeg: 30 }),
    }), 1000);
    expect(s.limits).toEqual({ panMinDeg: -60, panMaxDeg: 45, tiltMinDeg: -20, tiltMaxDeg: 30 });
  });

  it("collapses to null when the limits poll leg fails", () => {
    const s = mergeState(inputs({ limits: err("get_taught_limits failed") }), 1000);
    expect(s.limits).toBeNull();
    expect(s.errors.some((e) => e.includes("get_taught_limits failed"))).toBe(true);
  });

  it("collapses to null when a fixture/test omits it (pre-feature convention)", () => {
    const s = mergeState(inputs(), 1000);
    expect(s.limits).toBeNull();
  });
});

// Review fix, UI-9 fix round, finding I-2: the dashboard used to surface
// ONLY the resolved effective range, never whether an edge had actually
// been taught -- an operator working through the Travel limits procedure
// had no way to tell an untaught edge (still the config ceiling) from a
// real capture, since both rendered as the same kind of number. taughtLimits
// is deliberately a SEPARATE field (not nested inside `limits`) so the
// existing `limits`-only tests/fixtures above needed no changes at all.
describe("mergeState carries the per-edge taught status (procedures.js's Travel limits progress)", () => {
  it("passes taught-vs-untaught per edge through when the poll succeeds", () => {
    const s = mergeState(inputs({
      taughtLimits: ok({ panMinDeg: null, panMaxDeg: 12.5, tiltMinDeg: null, tiltMaxDeg: null }),
    }), 1000);
    expect(s.taughtLimits).toEqual({ panMinDeg: null, panMaxDeg: 12.5, tiltMinDeg: null, tiltMaxDeg: null });
  });

  it("collapses to null when the taught-limits poll leg fails", () => {
    const s = mergeState(inputs({ taughtLimits: err("get_taught_limits failed") }), 1000);
    expect(s.taughtLimits).toBeNull();
    expect(s.errors.some((e) => e.includes("get_taught_limits failed"))).toBe(true);
  });

  it("collapses to null when a fixture/test omits it (pre-feature convention)", () => {
    const s = mergeState(inputs(), 1000);
    expect(s.taughtLimits).toBeNull();
  });

  it("is independent of `limits` -- a failed taughtLimits leg does not disturb a successful limits leg, and vice versa", () => {
    const s = mergeState(inputs({
      limits: ok({ panMinDeg: -60, panMaxDeg: 45, tiltMinDeg: -20, tiltMaxDeg: 30 }),
      taughtLimits: err("get_taught_limits failed"),
    }), 1000);
    expect(s.limits).toEqual({ panMinDeg: -60, panMaxDeg: 45, tiltMinDeg: -20, tiltMaxDeg: 30 });
    expect(s.taughtLimits).toBeNull();
  });
});

describe("mergeState carries the sun-guard enabled flag", () => {
  it("passes enabled:true through from the sun source", () => {
    const s = mergeState(inputs({ sun: ok({ state: "monitoring", locked: false, separationDeg: 80, enabled: true }) }), 1000);
    expect(s.sunGuard.enabled).toBe(true);
  });
  it("passes enabled:false through from the sun source", () => {
    const s = mergeState(inputs({ sun: ok({ state: "disabled", locked: false, separationDeg: null, enabled: false }) }), 1000);
    expect(s.sunGuard.enabled).toBe(false);
  });
  it("defaults enabled to false when the sun source is degraded", () => {
    const s = mergeState(inputs({ sun: err("get_sun failed") }), 1000);
    expect(s.sunGuard.enabled).toBe(false);
  });
});

describe("mergeState pointing (get_pointing leg)", () => {
  it("surfaces az/el when the leg reports a pointing", () => {
    const s = mergeState(inputs({ pointing: ok({ azDeg: 123.4, elDeg: 12.5, source: "calibration" as const }) }), 1000);
    expect(s.pointing).toEqual({ azDeg: 123.4, elDeg: 12.5, source: "calibration" });
  });
  it("collapses a null pointing (uncalibrated) and a failed leg to null, never to a fabricated boresight", () => {
    expect(mergeState(inputs({ pointing: ok({ azDeg: null, elDeg: null, source: null }) }), 1000).pointing).toBeNull();
    expect(mergeState(inputs({ pointing: err("down") }), 1000).pointing).toBeNull();
    expect(mergeState(inputs(), 1000).pointing).toBeNull();
  });
});
