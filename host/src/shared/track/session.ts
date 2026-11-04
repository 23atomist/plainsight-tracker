import { Vec3, angleBetweenDeg } from "../geo/vec3.js";
import { Geodetic } from "../geo/wgs84.js";
import { AxisConfig, Device } from "../device.js";
import { Config } from "../config.js";
import { CalibrationStore } from "../calibration.js";
import { applySign } from "../angles.js";
import { DeviceState } from "../types.js";
import { HeadTrackCmd } from "../head-types.js";
import { moveToUserAngle } from "../../mcp/move.js";
import { reachablePanTilt } from "../../mcp/geo-tools.js";
import { EstimatorState, emptyEstimator, withFix, lastFixMs } from "./estimator.js";
import {
  TargetAim, targetAimAt, limitGuard, boresightEnu, limitHorizonMs, usableOr, GuardLimits,
} from "./control.js";
import { TrackSector, DISABLED_SECTOR, inArc } from "./sector.js";
import { TrackFloor, DISABLED_FLOOR, aboveFloor, enuElevationDeg } from "./floor.js";
import { AimOffset, NudgeResult, ZERO_OFFSET, applyOffset, nudgeOffset as nudgeOffsetValue } from "./offset.js";
import { TaughtEdges, effectiveLimits } from "../limits-store.js";
import { ESTOP_LATCHED_MSG } from "../../mcp/tool-helpers.js";

export type TrackState = "stopped" | "acquiring" | "tracking" | "waiting";
export type WaitReason =
  | "below_tilt_limit" | "pan_limit" | "target_stale"
  | "telemetry_stale" | "estop" | "not_calibrated"
  | "goto_failed" | "outside_sector"
  // Distinct from below_tilt_limit on purpose: that one means the rig
  // physically cannot reach the target, this one means the operator has
  // forbidden tracking that low (see track/floor.ts). Collapsing them would
  // make "why is it holding?" unanswerable at exactly the moment it matters.
  | "below_min_elevation"
  // The head lost pan's origin (ref.pan "none": Pico reboot, ENABLE 0) --
  // spec 6.8 rule 2. Every pan the session would compute is against a zero
  // that no longer exists, so it holds without moving until a reference is
  // back (set_position / reference_pan, or the head's own restore).
  | "pan_unreferenced"
  // Pan IS referenced, but by a reference with no known offset from the
  // frame the calibration was solved in (CalibrationStore.frameUnverified):
  // every aim could be off by the whole rename. Held like pan_unreferenced
  // until a re-solve with a fresh sighting or confirm_pan_frame.
  | "calibration_unverified";

/** True when the head reports pan's origin as unknown (ref.pan "none"). */
export function isPanUnreferenced(s: DeviceState): boolean {
  return s.ref.pan === "none";
}

/** The rig-state gates on ALL automated motion (spec 6.8 rule 2 + the frame check). */
export type AutomationBlock = "pan_unreferenced" | "calibration_unverified";

export function automationBlock(s: DeviceState, store: { isFrameUnverified(): boolean }): AutomationBlock | null {
  if (isPanUnreferenced(s)) return "pan_unreferenced";
  if (store.isFrameUnverified()) return "calibration_unverified";
  return null;
}

export interface TrackStatus {
  state: TrackState;
  reason: WaitReason | null;
  label: string | null;
  targetAzimuthDeg: number | null;
  targetElevationDeg: number | null;
  targetRangeM: number | null;
  targetPanDeg: number | null;
  targetTiltDeg: number | null;
  rigPanDeg: number | null;
  rigTiltDeg: number | null;
  pointingErrorDeg: number | null;
  commandedPanDps: number | null;
  commandedTiltDps: number | null;
  panLimited: boolean;
  tiltLimited: boolean;
  targetAgeMs: number | null;
  telemetryAgeMs: number | null;
  // True once the newest ACCEPTED fix is older than COAST_ENTER_MS -- i.e. the
  // aim is now riding the predictor (estimator.ts) rather than fresh reports.
  // Normal at 1Hz feeds with lossy decoders; it only means "watch this" when
  // it stays true for many seconds.
  coasting: boolean;
  // The operator aim-offset applied to the setpoint (see track/offset.ts).
  // This IS the measurement the drift-calibration pass is taking -- shown
  // separately from targetPanDeg/targetTiltDeg (which stay the raw,
  // unshifted geometric target) so the operator watches it converge.
  offsetPanDeg: number;
  offsetTiltDeg: number;
}

export interface Scheduler {
  every(ms: number, fn: () => void): { cancel(): void };
}

export const realScheduler: Scheduler = {
  every(ms, fn) {
    const t = setInterval(fn, ms);
    return { cancel() { clearInterval(t); } };
  },
};

/**
 * Why an acquire goto failed. Above all NOT a telemetry fault unless it is
 * one: the ESP32 era reported a routine refused goto as "telemetry_stale",
 * blaming a healthy subsystem on the most common catch-up path there was.
 */
function acquireFailureReason(e: unknown): WaitReason {
  // Defence in depth: beginAcquire() pre-checks reachability, so moveToUserAngle's
  // own limit check should never be the thing that throws here. If it ever is,
  // say which limit rather than inventing a fault.
  const msg = e instanceof Error ? e.message : "";
  if (/outside the (allowed|reachable)/.test(msg)) {
    return /tilt/.test(msg) ? "below_tilt_limit" : "pan_limit";
  }
  // Arrival timeout, transport error, or any other device rejection (423
  // E-STOP and 503 link down also reach the next tick's gates via telemetry).
  return "goto_failed";
}

type TrackAxis = "pan" | "tilt";
// What a STOP covers: the named axes, or every axis on the head.
type StopScope = readonly TrackAxis[] | "all";

// Compass azimuth (0-360, clockwise from north) of an ENU unit vector. Shared
// by the sector gate in tick() and recordAim()'s status reporting so the two
// derivations can never drift apart.
function enuAzimuthDeg(enuUnit: Vec3): number {
  let az = (Math.atan2(enuUnit[0], enuUnit[1]) * 180) / Math.PI;
  if (az < 0) az += 360;
  return az;
}

// Fix age past which status() reports `coasting`. Sized as ~two missed
// position reports at the default 1Hz poll: shorter would flap on ordinary
// report jitter, longer would hide a genuinely dry feed from the operator.
export const COAST_ENTER_MS = 2500;

export class TrackingSession {
  private state: TrackState = "stopped";
  private reason: WaitReason | null = null;
  private est: EstimatorState = emptyEstimator();
  private label: string | null = null;
  // The ICAO 24-bit hex, set alongside `label` by start(). Kept separate
  // because it is the stable dedup identity for capture: unlike `label`
  // (callsign-or-hex, see AdsbFollower.onSnapshot), it cannot change
  // mid-pass or differ between two passes of the same physical airframe
  // just because a callsign arrived late.
  private hex: string | null = null;
  private timer: { cancel(): void } | null = null;
  private lastActivityMs = 0;
  private acquireGen = 0;
  private gotoInFlight = false;
  // Ends the in-flight acquire's arrival wait when that goto is abandoned, so
  // the wait does not poll on (up to its whole timeout) for a move that no
  // longer exists.
  private acquireAbort: AbortController | null = null;
  // True from the moment the session commands motion (an acquire goto, a
  // TRACK) until it stops the head. This is what makes stopMotion()
  // edge-triggered: a session sitting in "waiting" re-enters wait() every tick,
  // and must not spray a STOP at the head every tick while it does.
  private motionLive = false;
  // Axes the limit guard is holding (stopped on the head and left out of the
  // TRACK). Only the transition into a hold sends a STOP.
  private held: Readonly<Record<TrackAxis, boolean>> = { pan: false, tilt: false };
  // One console line per failure streak per command: a head refusing every
  // TRACK at 10 Hz must be visible without flooding the log.
  private failing: Record<"track" | "stop", boolean> = { track: false, stop: false };
  private lastStatus: Partial<TrackStatus> = {};
  private stateListeners: ((s: TrackState, icao: string | null) => void)[] = [];
  // The standing aim-offset (see track/offset.ts). Reset on every start() so
  // each pass measures fresh -- an old correction left over from a previous
  // aircraft would corrupt the next pass's measurement. It resets to the
  // persisted TRIM (aim-trim-store.ts) rather than to zero: the trim is the
  // fixed camera-boresight error the calibration fit cannot yet solve, so it
  // is the correct zero-point for a fresh measurement, and only the part
  // nudged on top of it is this pass's own finding.
  private offset: AimOffset = ZERO_OFFSET;

  constructor(
    private readonly device: Device,
    private readonly cfg: Config,
    private readonly store: CalibrationStore,
    private readonly now: () => number = Date.now,
    private readonly scheduler: Scheduler = realScheduler,
    private readonly sectorProvider: () => TrackSector = () => DISABLED_SECTOR,
    // Operator-taught travel limits (limits-store.ts), read fresh on every
    // tick — a teach_limit/clear_taught_limits call must take effect on the
    // very next tick, not require a session restart. Defaults to "nothing
    // taught" so every existing caller/test that predates this feature keeps
    // its exact prior (config-ceiling-only) behavior.
    private readonly limitsProvider: () => TaughtEdges = () => ({}),
    // Persisted standing aim trim (aim-trim-store.ts), read fresh at the
    // start of every pass so set_aim_trim takes effect on the next pass
    // rather than requiring a restart -- same contract as sectorProvider and
    // limitsProvider above. Defaults to no trim so every existing
    // caller/test keeps its exact prior (start-at-zero) behavior.
    private readonly trimProvider: () => AimOffset = () => ZERO_OFFSET,
    // Operator-set minimum tracking elevation (floor-store.ts), read fresh on
    // every tick for the same reason as sectorProvider/limitsProvider above.
    // Defaults to disabled so every existing caller/test keeps its exact prior
    // behavior.
    private readonly floorProvider: () => TrackFloor = () => DISABLED_FLOOR,
    // The head's per-axis limits and rates (Device.getAxisConfig(), from GET
    // /api/config), read fresh on every tick: amax sizes the limit guard's
    // stopping horizon and vmax caps the TRACK feed-forward. Null until the
    // head's config has been read; cfg.trackFallbackAmaxDps2 and
    // cfg.maxJogDps stand in until then.
    private readonly axisConfigProvider: () => AxisConfig | null = () => null,
  ) {}

  // The pass baseline: the persisted trim, clamped nowhere here (the store
  // owns that ceiling) and copied so a provider handing back a live object
  // cannot be mutated through this.offset.
  private trimBaseline(): AimOffset {
    const t = this.trimProvider();
    return { panDeg: t.panDeg, tiltDeg: t.tiltDeg };
  }

  isActive(): boolean { return this.state !== "stopped"; }

  // Registers a listener that fires on every state transition (see
  // setState()). Used to wire tracking-state changes into capture, without
  // TrackingSession knowing anything about capture itself.
  onStateChange(cb: (s: TrackState, icao: string | null) => void): void {
    this.stateListeners.push(cb);
  }

  // `hex` is optional and defaults to null so every existing caller (manual
  // start_tracking, tests) that has no ICAO concept keeps working unchanged;
  // only the ADS-B follower supplies it.
  start(g: Geodetic, statedVel: Vec3 | null, label: string | null, hex: string | null = null, fixAgeSec = 0): string | null {
    const rig = this.rigLocation();
    if (!rig) return "not calibrated — set_rig_location, sight two landmarks, then solve_calibration first";
    if (!this.store.getOrientation()) return "not calibrated — run solve_calibration first";
    // An E-STOP is terminal for automation: a session created during the
    // latch would start slewing the moment it is cleared.
    if (this.estopLatched()) return ESTOP_LATCHED_MSG;

    // No stop: the acquire goto below retargets the head (an accepted goto
    // replaces whatever the axis was doing), so a STOP would only add a halt.
    this.supersede();
    this.est = withFix(emptyEstimator(), rig, g, this.fixTimeMs(fixAgeSec), statedVel);
    this.label = label;
    this.hex = hex;
    this.offset = this.trimBaseline(); // fresh pass, measured from the standing trim
    this.lastActivityMs = this.now();
    this.setState("acquiring");
    this.reason = null;
    this.timer?.cancel();
    this.timer = this.scheduler.every(Math.round(1000 / this.cfg.trackTickHz), () => this.safeTick());
    this.beginAcquire();
    return null;
  }

  // fixAgeSec: how old the POSITION REPORT already was when it arrived (ADS-B
  // seen_pos). Defaults to 0 for callers who genuinely have a live fix
  // (start_tracking/update_target driven by an external client).
  //
  // Stamping every fix with now() was the 2026-07-30 field bug: the rig
  // pointed where the aircraft HAD been, the miss grew with speed and report
  // age, and it looked like a fixed calibration bias until a target turned
  // and the whole thing fell apart. Measured on this rig's feed the same day:
  // median seen_pos 2.8s, p90 37.8s -- 7.4km of lag at 255kt on the worst.
  //
  // Feeding the fix's TRUE time also makes the EXISTING staleness guard
  // honest: lastFixMs now reflects when the aircraft was actually there, so
  // trackMaxTargetAgeMs finally measures what it always claimed to.
  updateTarget(g: Geodetic, statedVel: Vec3 | null, fixAgeSec = 0): string | null {
    if (this.state === "stopped") return "not tracking — call start_tracking first";
    const rig = this.rigLocation();
    if (!rig) return "not calibrated";
    this.est = withFix(this.est, rig, g, this.fixTimeMs(fixAgeSec), statedVel);
    this.lastActivityMs = this.now();
    return null;
  }

  // Clamped at now(): a report claiming to be from the future is a clock
  // problem, and leading BACKWARD from it would point the rig behind the
  // target rather than merely failing to lead it far enough.
  private fixTimeMs(fixAgeSec: number): number {
    const age = Number.isFinite(fixAgeSec) && fixAgeSec > 0 ? fixAgeSec : 0;
    return this.now() - age * 1000;
  }

  // `reason` says why the session ended when that is not an operator's
  // stop_tracking: "estop" (the head's latch ended it -- see tick()).
  stop(reason: WaitReason | null = null): void {
    this.setState("stopped");
    this.reason = reason;
    this.timer?.cancel();
    this.timer = null;
    this.stopMotion();
  }

  // -- operator aim-offset (see track/offset.ts) ---------------------------
  // Mechanical on purpose: apply a delta, return the resulting (clamped)
  // offset. This is the exact interface a future automatic (vision-based)
  // corrector will drive instead of a human nudging buttons.

  getOffset(): AimOffset { return this.offset; }

  nudgeOffset(deltaPanDeg: number, deltaTiltDeg: number): NudgeResult {
    const r = nudgeOffsetValue(this.offset, deltaPanDeg, deltaTiltDeg, this.cfg.maxAimOffsetDeg);
    this.offset = { panDeg: r.panDeg, tiltDeg: r.tiltDeg };
    return r;
  }

  // Back to the pass baseline (the standing trim), not to a bare zero: zero
  // is not a neutral aim on a rig with an unsolved boresight, it is a known
  // ~1.7deg error, and "clear" must not hand the operator that.
  clearOffset(): void { this.offset = this.trimBaseline(); }

  /** False while the head reports pan's origin unknown (spec 6.8 rule 2). */
  panReferenced(): boolean {
    return !isPanUnreferenced(this.device.getState());
  }

  /** True while the head's E-STOP latch is set (from any source). */
  estopLatched(): boolean {
    return this.device.getState().estop;
  }

  /** False while the calibration's pan frame is unverified (CalibrationStore.frameUnverified). */
  calibrationVerified(): boolean {
    return !this.store.isFrameUnverified();
  }

  /** Why automated motion is refused right now, or null (tools, status). */
  automationBlock(): AutomationBlock | null {
    return automationBlock(this.device.getState(), this.store);
  }

  status(): TrackStatus {
    const dev = this.device.getState();
    const fixMs = lastFixMs(this.est);
    return {
      state: this.state,
      reason: this.reason,
      label: this.label,
      targetAzimuthDeg: this.lastStatus.targetAzimuthDeg ?? null,
      targetElevationDeg: this.lastStatus.targetElevationDeg ?? null,
      targetRangeM: this.lastStatus.targetRangeM ?? null,
      targetPanDeg: this.lastStatus.targetPanDeg ?? null,
      targetTiltDeg: this.lastStatus.targetTiltDeg ?? null,
      rigPanDeg: this.state === "stopped" ? null : this.rigPanTilt().panDeg,
      rigTiltDeg: this.state === "stopped" ? null : this.rigPanTilt().tiltDeg,
      pointingErrorDeg: this.lastStatus.pointingErrorDeg ?? null,
      commandedPanDps: this.lastStatus.commandedPanDps ?? null,
      commandedTiltDps: this.lastStatus.commandedTiltDps ?? null,
      panLimited: this.lastStatus.panLimited ?? false,
      tiltLimited: this.lastStatus.tiltLimited ?? false,
      targetAgeMs: fixMs === null ? null : this.now() - fixMs,
      telemetryAgeMs: dev.lastUpdateMs === 0 ? null : this.now() - dev.lastUpdateMs,
      coasting: fixMs !== null && this.now() - fixMs > COAST_ENTER_MS,
      offsetPanDeg: this.offset.panDeg,
      offsetTiltDeg: this.offset.tiltDeg,
    };
  }

  private rigLocation(): Geodetic | null {
    const p = this.store.get();
    return p.rig ? { lat: p.rig.lat, lon: p.rig.lon, height: p.rig.height } : null;
  }

  // Camera-offset model, sourced the same way as point_at/point_at_azel: no
  // gravity calibration yet -> forward-only cHead, which is the no-op default
  // that reduces every offset-aware call below to its legacy mapping.
  private cHead(): Vec3 {
    return this.store.getCHead() ?? [0, 1, 0];
  }

  // The effective (taught-or-config) range — every reachability/guard check
  // in tick()/beginAcquire() below must use this, not cfg.panMin/panMax/
  // tiltMin/tiltMax directly, or a taught limit would stop rate jog earlier
  // than tracking/acquire, reopening the exact "enforced in some paths, not
  // others" gap Part 1 exists to close.
  private limits(): GuardLimits {
    return effectiveLimits(
      { panMin: this.cfg.panMin, panMax: this.cfg.panMax, tiltMin: this.cfg.tiltMin, tiltMax: this.cfg.tiltMax },
      this.limitsProvider(),
    );
  }

  private rigPanTilt(): { panDeg: number; tiltDeg: number } {
    const d = this.device.getState();
    return {
      panDeg: applySign(d.panDeg, this.cfg.panSign),
      tiltDeg: applySign(d.tiltDeg, this.cfg.tiltSign),
    };
  }

  // Abandon any outstanding acquire: bump the generation so the orphaned
  // promise's late resolution cannot flip state on a session that has moved
  // on, and end its arrival wait. Sends nothing itself: whoever supersedes the
  // goto either retargets the head (a fresh acquire) or stops it (stopMotion).
  private abandonGoto(): void {
    if (!this.gotoInFlight) return;
    this.gotoInFlight = false;
    this.acquireGen++;
    this.acquireAbort?.abort();
    this.acquireAbort = null;
  }

  // Drop the current pass's motion bookkeeping without commanding anything:
  // for a fresh acquire, which retargets the head with its own goto.
  private supersede(): void {
    this.abandonGoto();
    this.held = { pan: false, tilt: false };
    this.lastStatus = {
      ...this.lastStatus,
      commandedPanDps: null, commandedTiltDps: null,
      panLimited: false, tiltLimited: false,
    };
  }

  // Stop the head, edge-triggered: one STOP when the session stops commanding
  // motion (entering waiting, stop(), a throwing tick), none while it already
  // has. A STOP the head refuses re-arms the edge so the next waiting tick
  // tries again; if the session is stopped outright there is no next tick, and
  // the Pico's own track timeout (it stops an axis whose TRACKs stop) is the
  // backstop.
  private stopMotion(): void {
    const live = this.motionLive || this.gotoInFlight;
    this.supersede();
    if (!live) return;
    this.motionLive = false;
    this.postStop("all", () => { this.motionLive = true; });
  }

  // Ordering against the TRACKs and gotos around it is the Device's job: its
  // motion FIFO sends every motion command in call order, so a STOP can never
  // be overtaken by an earlier TRACK, nor overtake a later park goto.
  private postStop(scope: StopScope, onFailure: () => void): void {
    this.send("stop", this.device.stop(scope === "all" ? undefined : scope), onFailure);
  }

  private sendTrack(cmd: HeadTrackCmd): void {
    this.motionLive = true;
    // A refused TRACK (423 E-STOP, 503 link down) needs no handling here: the
    // same cause reaches the next tick's gates through telemetry, and the
    // Pico stops an axis whose TRACK updates stop.
    this.send("track", this.device.track(cmd), () => {});
  }

  // Watches one head command until it is answered, and logs the first failure
  // of a streak (see `failing`).
  private send(kind: "track" | "stop", cmd: Promise<void>, onFailure: () => void): void {
    void cmd.then(
      () => { this.failing = { ...this.failing, [kind]: false }; },
      (e: unknown) => {
        onFailure();
        if (this.failing[kind]) return;
        this.failing = { ...this.failing, [kind]: true };
        console.error(`[tracking] head refused ${kind.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }

  private wait(reason: WaitReason): void {
    this.setState("waiting");
    this.reason = reason;
    this.stopMotion();
  }

  // The dedup identity for capture: the ICAO 24-bit hex, or null if the
  // current/last target has none (non-ADS-B tracking). Deliberately NOT
  // `label` — a callsign that arrives late or changes between two passes of
  // the same airframe must not look like two different identities. Public
  // so a caller correlating a snapshot request against the currently
  // tracked target (see server.ts's CaptureDeps.snapshot) can ask without
  // duplicating tracking state.
  currentIcao(): string | null {
    return this.hex;
  }

  // Call INSTEAD of assigning this.state directly, so every transition is
  // observable. Emits only on an actual change to avoid a per-tick storm.
  private setState(next: TrackState): void {
    if (this.state === next) return;
    this.state = next;
    const icao = this.currentIcao();
    for (const cb of this.stateListeners) {
      try { cb(next, icao); } catch { /* a listener must never break tracking */ }
    }
  }

  // Any throw inside a tick must not leave the head tracking. The Pico's
  // track timeout is the real backstop (it survives an event-loop stall, which
  // this cannot).
  private safeTick(): void {
    try { this.tick(); }
    catch { this.stopMotion(); }
  }

  private tick(): void {
    if (this.state === "stopped") return;
    const t = this.now();

    if (t - this.lastActivityMs > this.cfg.trackDeadmanMs) { this.stop(); return; }

    const dev = this.device.getState();
    // Terminal, not a wait: a waiting session re-acquires on its own once the
    // gate lifts, and for an E-STOP that would mean clearing the latch
    // restarts autonomous slewing. The operator clears E-STOP to regain
    // manual control; a new pass needs a new start.
    if (dev.estop) { this.stop("estop"); return; }
    const R = this.store.getOrientation();
    if (!R) { this.wait("not_calibrated"); return; }
    if (dev.lastUpdateMs === 0 || t - dev.lastUpdateMs > this.cfg.trackStaleTelemetryMs) {
      this.wait("telemetry_stale"); return;
    }
    // A rig-state gate, not a policy predicate (policy is per-aircraft): with
    // pan's zero unknown -- or of unknown offset from the calibration's frame
    // -- no aim is meaningful. After telemetry_stale on purpose: a stale
    // snapshot's ref is as untrustworthy as its pan.
    const block = automationBlock(dev, this.store);
    if (block) { this.wait(block); return; }
    const fixMs = lastFixMs(this.est);
    if (fixMs === null || t - fixMs > this.cfg.trackMaxTargetAgeMs) { this.wait("target_stale"); return; }

    const aim = targetAimAt(this.est, R, t + this.cfg.trackLeadMs, this.cHead(), this.cfg.geoPanSign, this.limits());
    if (!aim) { this.wait("target_stale"); return; }

    // Azimuth-sector filter: if the target's bearing has left the open arc,
    // stop chasing it and hold (do not park). Reuses wait()'s stop path.
    if (!inArc(enuAzimuthDeg(aim.enuUnit), this.sectorProvider())) {
      this.recordAim(aim);
      this.wait("outside_sector");
      return;
    }

    // Elevation floor: the sector's sibling gate. Checked against the TARGET
    // direction (not the offset-shifted setpoint) for the same reason the
    // sector is -- this answers "may we film something down there at all",
    // which is a property of the target, not of the trim currently dialled in.
    if (!aboveFloor(enuElevationDeg(aim.enuUnit), this.floorProvider())) {
      this.recordAim(aim);
      this.wait("below_min_elevation");
      return;
    }

    // Shift the setpoint by the standing operator aim-offset BEFORE the
    // reachability check, so an offset that would push the corrected target
    // outside the pan/tilt limits is caught by the exact same gate an
    // unshifted target goes through -- the offset must not bypass this.
    const limits = this.limits();
    const offsetAim = applyOffset(aim.panDeg, aim.tiltDeg, this.offset);
    const reach = reachablePanTilt(
      offsetAim.panDeg, offsetAim.tiltDeg,
      limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax,
    );
    if ("error" in reach) {
      this.recordAim(aim);
      this.wait(/tilt/.test(reach.error) ? "below_tilt_limit" : "pan_limit");
      return;
    }

    const rig = this.rigPanTilt();
    // Deliberately measured against the TRUE (unshifted) target direction,
    // not the offset-shifted one: this is the "have we lost the target"
    // check, and a converged offset is supposed to leave the boresight
    // exactly `offset` away from the true target -- see MAX_OFFSET_DEG's own
    // comment for why that stays comfortably under trackReacquireDeg.
    const errDeg = angleBetweenDeg(boresightEnu(R, rig.panDeg, rig.tiltDeg, this.cHead(), this.cfg.geoPanSign), aim.enuUnit);
    this.recordAim(aim, errDeg);

    if (this.state === "acquiring") return;   // a goto is in flight; let it finish

    if (this.state === "waiting" || errDeg > this.cfg.trackReacquireDeg) {
      // On the head an accepted goto retargets, even mid-move (docs/HEAD-API.md,
      // POST /api/goto). The ESP32 refused a goto while a jog was still
      // decelerating, which is what the old busy-wait for `moving` to clear
      // was for; that wait is gone. The reacquire goto goes out now, and
      // nothing is stopped first: the goto replaces the TRACK on the head.
      this.setState("acquiring");
      this.reason = null;
      this.supersede();
      this.beginAcquire();
      return;
    }

    this.servo(t, dev, aim, reach, rig, limits);
  }

  // state === tracking: one TRACK per tick; the Pico extrapolates and servos.
  // pos comes from `reach` (the offset-shifted, range-resolved setpoint) --
  // NOT `aim` -- so the head drives toward target+offset. vel is aim's own
  // feedforward: the offset is a constant correction, so it contributes zero
  // rate of its own.
  private servo(
    t: number, dev: DeviceState, aim: TargetAim, reach: { pan: number; tilt: number },
    rig: { panDeg: number; tiltDeg: number }, limits: GuardLimits,
  ): void {
    const axisCfg = this.axisConfigProvider();
    // Bounded by the staleness gate in tick() (telemetry older than
    // trackStaleTelemetryMs already sent us to `waiting`), so the horizon
    // cannot be inflated by an arbitrarily old reading.
    const tickPeriodMs = 1000 / this.cfg.trackTickHz;
    const telemetryAgeMs = t - dev.lastUpdateMs;
    const fallbackAmax = this.cfg.trackFallbackAmaxDps2;
    const guarded = limitGuard({ panDps: aim.ratePanDps, tiltDps: aim.rateTiltDps }, rig.panDeg, rig.tiltDeg, limits, {
      panMs: limitHorizonMs(aim.ratePanDps, telemetryAgeMs, tickPeriodMs, usableOr(axisCfg?.pan.amax, fallbackAmax)),
      tiltMs: limitHorizonMs(aim.rateTiltDps, telemetryAgeMs, tickPeriodMs, usableOr(axisCfg?.tilt.amax, fallbackAmax)),
    });

    // A blocked axis is STOPPED on the head, not sent a clamped TRACK: the
    // Pico extrapolates a TRACK, so any TRACK would keep it moving. The guard
    // trip is a stop, not a ramp -- its stopping reserve (limitHorizonMs)
    // assumes the axis starts decelerating at once. One STOP per hold, on the
    // tick the hold begins; the held axis is then simply left out of the
    // TRACK until the guard releases it.
    const blocked: Record<TrackAxis, boolean> = { pan: guarded.panBlocked, tilt: guarded.tiltBlocked };
    const newlyHeld = (["pan", "tilt"] as const).filter((a) => blocked[a] && !this.held[a]);
    this.held = blocked;
    if (newlyHeld.length > 0) {
      // A refused STOP drops the hold, so the next tick sees a fresh edge and
      // stops again.
      this.postStop(newlyHeld, () => {
        this.held = { pan: this.held.pan && !newlyHeld.includes("pan"), tilt: this.held.tilt && !newlyHeld.includes("tilt") };
      });
    }

    const panVel = this.feedForward(aim.ratePanDps, axisCfg?.pan.vmax);
    const tiltVel = this.feedForward(aim.rateTiltDps, axisCfg?.tilt.vmax);
    const cmd: HeadTrackCmd = {
      ...(guarded.panBlocked ? {} : {
        pan: { pos: applySign(reach.pan, this.cfg.panSign), vel: applySign(panVel, this.cfg.panSign) },
      }),
      ...(guarded.tiltBlocked ? {} : {
        tilt: { pos: applySign(reach.tilt, this.cfg.tiltSign), vel: applySign(tiltVel, this.cfg.tiltSign) },
      }),
    };
    if (cmd.pan || cmd.tilt) this.sendTrack(cmd);

    this.lastStatus = {
      ...this.lastStatus,
      commandedPanDps: guarded.panBlocked ? 0 : panVel,
      commandedTiltDps: guarded.tiltBlocked ? 0 : tiltVel,
      // Surfaced so a guard-held axis (stopped, state still "tracking", no
      // wait reason) is diagnosable instead of looking identical to "the
      // servo is happy". See the README's Safety section.
      panLimited: guarded.panBlocked,
      tiltLimited: guarded.tiltBlocked,
    };
  }

  // The TRACK feed-forward, capped at the head's vmax for the axis (or
  // maxJogDps while the head's config is unknown): a rate the axis cannot
  // reach only winds the Pico's extrapolated setpoint away from it.
  private feedForward(rateDps: number, vmax: number | undefined): number {
    const cap = usableOr(vmax, this.cfg.maxJogDps);
    return Math.max(-cap, Math.min(cap, rateDps));
  }

  private recordAim(aim: TargetAim, errDeg?: number): void {
    let azimuth = enuAzimuthDeg(aim.enuUnit);
    if (azimuth >= 360 - 1e-6) azimuth = 0;
    this.lastStatus = {
      ...this.lastStatus,
      targetAzimuthDeg: azimuth,
      targetElevationDeg: (Math.asin(Math.max(-1, Math.min(1, aim.enuUnit[2]))) * 180) / Math.PI,
      targetRangeM: aim.rangeM,
      targetPanDeg: aim.panDeg,
      targetTiltDeg: aim.tiltDeg,
      pointingErrorDeg: errDeg ?? this.lastStatus.pointingErrorDeg ?? null,
    };
  }

  private beginAcquire(): void {
    const R = this.store.getOrientation();
    if (!R) { this.wait("not_calibrated"); return; }
    // start() -> beginAcquire() slews before tick()'s gate ever runs (same
    // reasoning as the sector/floor checks below), so the unreferenced gate
    // must be here too or the first acquire would fly blind.
    const block = this.automationBlock();
    if (block) { this.wait(block); return; }
    const aim = targetAimAt(this.est, R, this.now() + this.cfg.trackLeadMs, this.cHead(), this.cfg.geoPanSign, this.limits());
    if (!aim) { this.wait("target_stale"); return; }
    // Azimuth-sector filter: refuse to dispatch the initial goto toward an
    // out-of-sector target. Without this, start() -> beginAcquire() fires the
    // slew synchronously, before tick()'s own gate ever runs -- the tick
    // check alone only protects an already-tracking target from drifting
    // out, it does nothing for the very first acquire. (The tick reacquire
    // branch also calls beginAcquire(), but only after tick() has already
    // gated the same `aim` this call recomputes -- redundant there, but
    // load-bearing for the start() path.)
    if (!inArc(enuAzimuthDeg(aim.enuUnit), this.sectorProvider())) {
      this.wait("outside_sector");
      return;
    }
    // Same reasoning as the sector check immediately above: tick()'s gate
    // alone protects an already-tracking target from drifting down, but does
    // nothing for the very first acquire -- and the first acquire is exactly
    // the slew that would swing the camera down across a row of windows.
    if (!aboveFloor(enuElevationDeg(aim.enuUnit), this.floorProvider())) {
      this.wait("below_min_elevation");
      return;
    }
    // Same offset shift as tick(), applied before the SAME reachability gate
    // -- the initial/reacquire goto slews to target+offset too, so the
    // correction never disappears (and reappears) across an acquire cycle.
    const limits = this.limits();
    const offsetAim = applyOffset(aim.panDeg, aim.tiltDeg, this.offset);
    const reach = reachablePanTilt(
      offsetAim.panDeg, offsetAim.tiltDeg,
      limits.panMin, limits.panMax, limits.tiltMin, limits.tiltMax,
    );
    if ("error" in reach) {
      this.wait(/tilt/.test(reach.error) ? "below_tilt_limit" : "pan_limit");
      return;
    }
    // Fire-and-forget, deliberately not awaited (start()/the reacquire branch
    // return immediately; tracking is a background loop). A goto in flight
    // can be superseded before it settles -- e.g. an interruption sends the
    // session to "waiting" and a later tick starts a fresh acquire while the
    // old moveToUserAngle promise is still pending. The generation stamp lets
    // a superseded attempt's resolution recognize it is stale and do nothing,
    // instead of overwriting whatever the session has moved on to.
    //
    // Ordering against an earlier TRACK or STOP still unanswered is the
    // Device's motion FIFO: neither can overtake this goto and replace or
    // cancel it.
    const gen = ++this.acquireGen;
    const abort = new AbortController();
    this.acquireAbort = abort;
    this.gotoInFlight = true;
    this.motionLive = true;
    void moveToUserAngle(this.device, this.cfg, reach.pan, reach.tilt, undefined, limits, abort.signal)
      .then(() => {
        if (gen !== this.acquireGen) return;
        this.gotoInFlight = false;
        this.acquireAbort = null;
        if (this.state === "acquiring") this.setState("tracking");
      })
      .catch((e: unknown) => {
        if (gen !== this.acquireGen) return;
        this.gotoInFlight = false;
        this.acquireAbort = null;
        if (this.state === "acquiring") this.wait(acquireFailureReason(e));
      });
  }

  /** Test seam: force a state without waiting for a real goto to complete. */
  forceStateForTest(s: TrackState): void { this.setState(s); }
}
