import type { EstopOutcome } from "./head.js";
import { withTimeout } from "./util.js";

export interface ControlDeps {
  track(hex: string): Promise<void>;
  stopTracking(): Promise<void>;
  jog(panDps: number, tiltDps: number, durationMs: number): Promise<void>;
  // Drift-calibration aim-offset (see track/offset.ts + nudge_aim_offset):
  // applied to the TRACKING SETPOINT, never a raw jog — the dashboard's
  // direction buttons route here instead of jog() while tracking is active.
  nudgeAimOffset(deltaPanDeg: number, deltaTiltDeg: number): Promise<string>;
  setRigLocation(lat: number, lon: number, heightM: number): Promise<void>;
  sightLandmark(lat: number, lon: number, heightM: number, label?: string): Promise<void>;
  // Aircraft-based calibration sighting (see src/adsb/extrapolate.js +
  // src/geo-tools.js's sight_aircraft): returns the raw tool response text
  // (slot filled, extrapolation applied, any separation warning), same
  // convention as solveCalibration below -- the caller just relays it.
  sightAircraft(hex: string): Promise<string>;
  solveCalibration(): Promise<string>;
  clearCalibration(): Promise<void>;
  getTrackSector(): Promise<{ enabled: boolean; startDeg: number; endDeg: number }>;
  getTrackRange(): Promise<number>;
  getAimTrim(): Promise<{ panDeg: number; tiltDeg: number }>;
  setTrackSector(startDeg: number, endDeg: number, enabled: boolean): Promise<void>;
  getTrackFloor(): Promise<{ enabled: boolean; minElevationDeg: number }>;
  setTrackFloor(minElevationDeg: number, enabled: boolean): Promise<void>;
  // Operator trackability range (range-store.ts / set_track_range). Daemon-side
  // so the autonomous agent obeys the same bound the browser set.
  setTrackRange(maxRangeKm: number): Promise<string>;
  // Standing aim trim (aim-trim-store.ts). setAimTrim with both values
  // undefined adopts whatever aim-offset is live, which is the "nudge until
  // centred, then save" workflow.
  setAimTrim(panDeg?: number, tiltDeg?: number): Promise<string>;
  clearAimTrim(): Promise<string>;
  setSunGuard(enabled: boolean): Promise<void>;
  // The agent's armed flag (set_agent_armed, spec 6.4): the Auto toggle and
  // the E-STOP agent leg. An MCP call, so it fails while the daemon is down.
  setAgentArmed(armed: boolean): Promise<void>;
  // DIRECT to the head (head.ts's HeadDirectClient), never through the MCP
  // daemon: the dashboard E-STOP must latch the head with the daemon down.
  headEstop(): Promise<EstopOutcome>;
  headClearEstop(): Promise<void>;
  // Lens focus, also DIRECT to the head (the daemon never drives focus).
  // focusNudge resolves with the new target, output-shaft degrees.
  focusNudge(deltaDeg: number): Promise<number>;
  focusStop(): Promise<void>;
  // The daemon's own clear_estop, best-effort alongside headClearEstop.
  mcpClearEstop(): Promise<void>;
  // Head reference procedures (MCP tools home / set_position /
  // reference_pan); each relays the tool's message text.
  home(): Promise<string>;
  setPosition(panDeg?: number, tiltDeg?: number): Promise<string>;
  referencePan(): Promise<string>;
  // Camera arm/disarm — synchronous (they just flip the in-process
  // CameraStreamer's state); no rig motion, so no daemon round-trip.
  cameraStart(): void;
  cameraStop(): void;
  // The tools below (characterize_imu, set_north_zero, teach_limit,
  // clear_taught_limits, capture_snapshot, start_recording,
  // stop_recording) had no dashboard transport at all before this -- each
  // just relays the daemon's own response text, same convention as
  // sightAircraft/solveCalibration above.
  characterizeImu(): Promise<string>;
  setNorthZero(): Promise<string>;
  teachLimit(edge: string): Promise<string>;
  clearTaughtLimits(): Promise<string>;
  captureSnapshot(icao?: string): Promise<string>;
  startRecording(): Promise<string>;
  stopRecording(): Promise<string>;
  // set_capture_mode (src/tools.ts) -- the only thing that flips
  // captureAutoEnabled, which the dashboard could previously display but
  // never change (review fix, finding I-3). The chip no longer contradicts
  // the [Record] button either: capture-label.js now reads `recording`
  // ahead of `autoEnabled`, so an auto-off host that IS recording says so.
  setCaptureMode(enabled: boolean): Promise<string>;
  // The agent's target-eligibility ruleset (get_policy/set_policy,
  // src/adsb-tools.ts). Rejects (throws) a malformed ruleset rather than
  // persisting it -- PolicyStore.set's RulesetSchema.parse is what refuses;
  // runAction's own try/catch below is what turns that into {ok:false}.
  setPolicy(ruleset: unknown): Promise<string>;
}

export interface ActionResult { ok: boolean; message: string; }
// `head` is the leg that matters: `ok` (and the HTTP status: 502 otherwise)
// follows it alone. `pico_confirmed` false means the head latched but the
// Pico did not confirm the stop (`warning` says so). agent/tracking are
// best-effort MCP legs, reported but not fatal.
export interface EstopResult {
  ok: boolean;
  pico_confirmed: boolean;
  warning?: string;
  head: ActionResult; agent: ActionResult; tracking: ActionResult;
  allOk: boolean;
}

// Budget for each best-effort MCP leg of the E-STOP. They run AFTER the head
// latch, in parallel, so this only bounds how long the response waits for
// them; it never delays the latch.
export const ESTOP_MCP_LEG_TIMEOUT_MS = 1000;

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

async function attempt(fn: () => Promise<unknown>, okMsg: string): Promise<ActionResult> {
  try { await fn(); return { ok: true, message: okMsg }; }
  catch (e) { return { ok: false, message: msg(e) }; }
}

// Field lesson ("E-STOP is the reliable stop", 2026-07-22 roof bring-up): the
// operator's stop must not depend on the MCP daemon, whose session can wedge
// or cascade. So the head is latched FIRST, directly, before anything else is
// even attempted: a hung daemon must never delay the latch by even a second.
// The latch alone refuses every motion route on the head (423), so whatever
// the agent or the tracking session try next is refused there.
//
// Then, best-effort and in parallel, the daemon legs (spec 6.4's "E-STOP
// clears the armed flag"): disarm the agent so its next tick does not pick a
// new target once the latch is cleared, and end the tracking session so it
// stops issuing setpoints into a latched head. Each is bounded so a hung
// daemon delays only the response, never the stop.
export async function emergencyStop(
  d: ControlDeps, mcpLegTimeoutMs: number = ESTOP_MCP_LEG_TIMEOUT_MS,
): Promise<EstopResult> {
  let head: ActionResult;
  let picoConfirmed = false;
  let warning: string | undefined;
  try {
    const out = await d.headEstop();
    picoConfirmed = out.picoConfirmed;
    warning = out.warning;
    head = { ok: true, message: out.warning ?? "head E-STOP latched" };
  } catch (e) {
    head = { ok: false, message: msg(e) };
  }
  const [agent, tracking] = await Promise.all([
    attempt(() => withTimeout(d.setAgentArmed(false), mcpLegTimeoutMs, "setAgentArmed(false)"), "agent disarmed"),
    attempt(() => withTimeout(d.stopTracking(), mcpLegTimeoutMs, "stopTracking"), "tracking stopped"),
  ]);
  return {
    ok: head.ok, pico_confirmed: picoConfirmed, ...(warning ? { warning } : {}),
    head, agent, tracking,
    allOk: head.ok && picoConfirmed && agent.ok && tracking.ok,
  };
}

// Releasing the latch: the head clear is the one that must succeed; the
// daemon's own clear_estop is a best-effort second call to the same latch.
// Does NOT re-arm the agent -- arming is a separate, explicit operator act.
export async function clearEstop(d: ControlDeps): Promise<ActionResult> {
  try {
    await d.headClearEstop();
  } catch (e) {
    return { ok: false, message: `head did not clear E-STOP: ${msg(e)}` };
  }
  const mcp = await attempt(
    () => withTimeout(d.mcpClearEstop(), ESTOP_MCP_LEG_TIMEOUT_MS, "clearEstop"), "daemon cleared");
  return {
    ok: true,
    message: mcp.ok ? "E-STOP cleared" : `E-STOP cleared on the head (daemon leg failed: ${mcp.message})`,
  };
}

// One focus nudge is at most a full motor turn: a bad client value must not
// send the lens ring end to end.
export const FOCUS_MAX_NUDGE_DEG = 360;

function num(v: unknown, dflt = 0): number { return typeof v === "number" && Number.isFinite(v) ? v : dflt; }
function str(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }
// Distinct from num(): an omitted axis must stay omitted (set_position then
// leaves that axis alone), never collapse to a declared 0.
function finiteOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export async function runAction(d: ControlDeps, action: string, body: Record<string, unknown>): Promise<ActionResult> {
  try {
    switch (action) {
      case "track": {
        const hex = str(body.hex);
        if (!hex) return { ok: false, message: "hex required" };
        await d.track(hex); return { ok: true, message: `tracking ${hex}` };
      }
      case "stop": await d.stopTracking(); return { ok: true, message: "tracking stopped" };
      // The Auto toggle: the agent's armed flag (spec 6.4).
      case "agent":
        if (body.on === true) { await d.setAgentArmed(true); return { ok: true, message: "agent armed" }; }
        await d.setAgentArmed(false); return { ok: true, message: "agent disarmed" };
      case "clear_estop": return await clearEstop(d);
      case "head/home": return { ok: true, message: await d.home() };
      case "head/set-position": {
        const pan = finiteOrUndefined(body.pan_deg);
        const tilt = finiteOrUndefined(body.tilt_deg);
        if (pan === undefined && tilt === undefined) return { ok: false, message: "pan_deg and/or tilt_deg required" };
        return { ok: true, message: await d.setPosition(pan, tilt) };
      }
      case "head/reference-pan": return { ok: true, message: await d.referencePan() };
      case "focus/nudge": {
        const delta = finiteOrUndefined(body.delta_deg);
        if (delta === undefined || delta === 0 || Math.abs(delta) > FOCUS_MAX_NUDGE_DEG) {
          return { ok: false, message: `delta_deg must be a non-zero number within +/-${FOCUS_MAX_NUDGE_DEG}` };
        }
        const target = await d.focusNudge(delta);
        return { ok: true, message: `focus -> ${target.toFixed(1)} deg` };
      }
      case "focus/stop": await d.focusStop(); return { ok: true, message: "focus stopped" };
      case "jog":
        await d.jog(num(body.pan_dps), num(body.tilt_dps), num(body.duration_ms, 300));
        return { ok: true, message: "jogged" };
      case "nudge-aim-offset":
        // Pass the tool's JSON straight through -- it carries `clamped`, and
        // a swallowed clamp is a control that silently stops working.
        return { ok: true, message: await d.nudgeAimOffset(num(body.delta_pan_deg), num(body.delta_tilt_deg)) };
      case "calibrate/set-location":
        await d.setRigLocation(num(body.lat), num(body.lon), num(body.height_m));
        return { ok: true, message: "rig location set" };
      case "calibrate/sight":
        await d.sightLandmark(num(body.lat), num(body.lon), num(body.height_m), str(body.label));
        return { ok: true, message: "landmark sighted" };
      case "calibrate/sight-aircraft": {
        const hex = str(body.hex);
        if (!hex) return { ok: false, message: "hex required" };
        return { ok: true, message: await d.sightAircraft(hex) };
      }
      case "calibrate/solve": return { ok: true, message: await d.solveCalibration() };
      case "calibrate/clear": await d.clearCalibration(); return { ok: true, message: "calibration cleared" };
      case "calibrate/characterize-imu": return { ok: true, message: await d.characterizeImu() };
      case "calibrate/set-north-zero": return { ok: true, message: await d.setNorthZero() };
      case "limits/teach": {
        const edge = str(body.edge);
        if (!edge) return { ok: false, message: "edge required" };
        return { ok: true, message: await d.teachLimit(edge) };
      }
      case "limits/clear-taught": return { ok: true, message: await d.clearTaughtLimits() };
      case "capture/snapshot": return { ok: true, message: await d.captureSnapshot(str(body.icao)) };
      case "capture/start-recording": return { ok: true, message: await d.startRecording() };
      case "capture/stop-recording": return { ok: true, message: await d.stopRecording() };
      case "capture/set-mode": return { ok: true, message: await d.setCaptureMode(body.enabled === true) };
      case "sector/set":
        await d.setTrackSector(num(body.start_deg), num(body.end_deg), body.enabled === true);
        return { ok: true, message: "tracking sector set" };
      case "floor/set":
        await d.setTrackFloor(num(body.min_elevation_deg), body.enabled === true);
        return { ok: true, message: body.enabled === true
          ? `tracking floor set to ${num(body.min_elevation_deg)} deg elevation`
          : "tracking elevation floor disabled" };
      case "range/set":
        return { ok: true, message: await d.setTrackRange(num(body.max_range_km, 25)) };
      case "trim/set":
        // Both undefined -> the daemon adopts the live aim-offset. Deliberately
        // NOT defaulted to 0 by num(): "save what I dialled in" and "save zero"
        // are different intents and must not collapse into one.
        return { ok: true, message: await d.setAimTrim(
          typeof body.pan_deg === "number" ? body.pan_deg : undefined,
          typeof body.tilt_deg === "number" ? body.tilt_deg : undefined,
        ) };
      case "trim/clear":
        return { ok: true, message: await d.clearAimTrim() };
      case "sun-guard/set":
        await d.setSunGuard(body.enabled === true);
        return { ok: true, message: `sun guard ${body.enabled === true ? "enabled" : "disabled"}` };
      case "camera/start": d.cameraStart(); return { ok: true, message: "camera on" };
      case "camera/stop": d.cameraStop(); return { ok: true, message: "camera off" };
      case "policy/set":
        return { ok: true, message: await d.setPolicy(body.ruleset) };
      default: return { ok: false, message: `unknown action: ${action}` };
    }
  } catch (e) { return { ok: false, message: msg(e) }; }
}
