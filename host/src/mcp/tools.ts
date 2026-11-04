import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Device } from "../shared/device.js";
import { Config } from "../shared/config.js";
import { applySign } from "../shared/angles.js";
import { moveToUserAngle } from "./move.js";
import { TrackingSession } from "../shared/track/session.js";
import { SunSupervisor } from "../shared/track/supervisor.js";
import { CalibrationStore } from "../shared/calibration.js";
import { CaptureController } from "../shared/capture/controller.js";
import { PassJournal } from "../shared/capture/pass-journal.js";
import { LimitsStore, effectiveLimits, CeilingLimits } from "../shared/limits-store.js";
import { limitGuard, GuardHorizon, usableOr } from "../shared/track/control.js";
import { currentUserPanTilt } from "./geo-tools.js";
import { AgentStore } from "../shared/agent-store.js";
import { text, errText, SUN_LOCKED_MSG } from "./tool-helpers.js";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Exported so callers other than registerTool below (the dashboard's
// jog-hold.js release payload, and its test) can validate a candidate jog
// payload against the REAL schema instead of a hand-copied one that could
// silently drift from it.
//
// duration_ms allows 0 as an explicit "stop now": device.jog()'s tick count
// is Math.ceil(duration_ms / JOG_KEEPALIVE_MS), so duration_ms:0 is zero
// ticks -- the keep-alive loop body never runs, and clearJog() fires
// immediately after the single setJogVector() call with NO `await` between
// them (see device.ts's jog()). That means even a duration_ms:0 call with
// non-zero rates cannot leave a non-zero vector live for any real time --
// the one non-zero frame that reaches the device (proven harmless by
// test/device-jog.test.ts's "jog(duration=0)" case) is overwritten by the
// trailing zero before the event loop ever turns, so it is bounded, not an
// unbounded move. This is what lets the dashboard's press-and-hold jog
// (dashboard/public/jog-hold.js) post a genuine (0,0,0) stop vector on
// release instead of riding out the last pulse's duration_ms.
export const jogArgsShape = {
  pan_dps: z.number().describe("pan rate in degrees/second (capped per axis at maxJogDps, TB3_MAX_JOG_DPS)"),
  tilt_dps: z.number().describe("tilt rate in degrees/second (capped per axis at maxJogDps, TB3_MAX_JOG_DPS)"),
  duration_ms: z.number().int().nonnegative().max(30000)
    .describe("how long to jog, milliseconds; 0 stops immediately (zero-rate vector, cleared right away)"),
};

export function registerTools(
  server: McpServer, device: Device, cfg: Config, session: TrackingSession,
  supervisor: SunSupervisor, store: CalibrationStore, capture: CaptureController,
  limitsStore: LimitsStore, journal: PassJournal, agentStore: AgentStore,
): void {
  const cfgCeiling: CeilingLimits = {
    panMin: cfg.panMin, panMax: cfg.panMax, tiltMin: cfg.tiltMin, tiltMax: cfg.tiltMax,
  };
  // The effective (taught-or-config) range, re-read on every call: a
  // teach_limit/clear_taught_limits between two jog/goto_angle calls must
  // take effect on the very next one, not require a daemon restart.
  const effLimits = (): CeilingLimits => effectiveLimits(cfgCeiling, limitsStore.get());

  server.registerTool(
    "get_status",
    {
      description: "Read the head's current position (degrees, user frame), motion, E-STOP latch, pan reference, IMU, and link state.",
      inputSchema: {},
    },
    async () => {
      const s = device.getState();
      const lastUpdateAgeMs = s.lastUpdateMs === 0 ? null : Date.now() - s.lastUpdateMs;
      const stale = !s.connected || (s.lastUpdateMs !== 0 && Date.now() - s.lastUpdateMs > 2000);
      return text(JSON.stringify({
        connected: s.connected,
        pan_deg: Number(applySign(s.panDeg, cfg.panSign).toFixed(3)),
        tilt_deg: Number(applySign(s.tiltDeg, cfg.tiltSign).toFixed(3)),
        zoom_deg: Number(s.zoomDeg.toFixed(3)),
        focus_deg: Number(s.focusDeg.toFixed(3)),
        moving: s.moving,
        axes: s.axes ?? null, // per-axis {pos, vel, tgt, mode, homed, endstop, driver}; null before the first motion tick
        enabled: s.enabled,
        estop: s.estop,
        pan_ref: { source: s.ref.pan, persisted: s.ref.persisted, age_s: s.ref.ageS },
        tilt_disagree_deg: s.tiltDisagreeDeg,
        link: { pico: s.link.pico, imu: s.link.imu },
        imu: s.imu
          ? {
            ok: s.imu.ok, heading_deg: s.imu.heading, pitch_deg: s.imu.pitch, roll_deg: s.imu.roll,
            cal: s.imu.cal ? { ...s.imu.cal } : null, temp_c: s.imu.tempC,
          }
          : null,
        last_update_age_ms: lastUpdateAgeMs,
        stale,
      }, null, 2));
    },
  );

  server.registerTool(
    "goto_angle",
    {
      description: "Move to an absolute pan/tilt angle in degrees (user frame). Blocks until arrival.",
      inputSchema: {
        pan_deg: z.number().describe("absolute pan angle in degrees"),
        tilt_deg: z.number().describe("absolute tilt angle in degrees"),
        speed_dps: z.number().positive().optional().describe("slew speed in degrees/second; omit for device max"),
      },
    },
    async ({ pan_deg, tilt_deg, speed_dps }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      try {
        const result = await moveToUserAngle(device, cfg, pan_deg, tilt_deg, speed_dps, effLimits());
        return text(JSON.stringify(result));
      } catch (e) {
        return errText((e as Error).message);
      }
    },
  );

  server.registerTool(
    "jog",
    {
      description: "Nudge the rig at a rate (degrees/second, user frame, capped per axis at maxJogDps) for a fixed duration (manual framing). An axis that would run past a travel limit is held.",
      inputSchema: jogArgsShape,
    },
    async ({ pan_dps, tilt_dps, duration_ms }) => {
      if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
      if (session.isActive()) {
        return errText("tracking active; stop_tracking first");
      }
      // SAFETY: rate jog is the one motion path with no endstop and no other
      // gate between "commanded rate" and the hardware — goto_angle checks
      // limits before ever moving, and tracking has its own limitGuard
      // (track/control.ts), but a rate command here previously reached
      // device.jog() completely unchecked. Press-and-hold and the joystick
      // both post through this exact tool (see dashboard/public/jog-hold.js
      // and joystick-hold.js's module docs — both route through
      // /api/control/jog -> this "jog" tool), so guarding here covers both.
      //
      // Reuses the SAME predict-then-block pattern tracking already uses
      // (limitGuard): predict where this rate takes each axis over the
      // command's own duration PLUS the head's stopping time for that rate
      // (|rate| / amax: the axis does not stop dead when the jog ends), and
      // zero only the axis that would leave the effective range. limitGuard's math already allows motion AWAY from a
      // limit (the prediction lands back inside the range) — it never traps
      // the operator at a stop with no way back.
      //
      // maxJogDps is the manual-jog ceiling, applied per axis BEFORE the guard
      // so the guard predicts on the rate that is actually sent.
      const rig = currentUserPanTilt(device, cfg);
      const capped = {
        panDps: clamp(pan_dps, -cfg.maxJogDps, cfg.maxJogDps),
        tiltDps: clamp(tilt_dps, -cfg.maxJogDps, cfg.maxJogDps),
      };
      const axisCfg = device.getAxisConfig();
      const stopMs = (dps: number, amax: number | undefined): number =>
        (Math.abs(dps) / usableOr(amax, cfg.trackFallbackAmaxDps2)) * 1000;
      const horizon: GuardHorizon = {
        panMs: duration_ms + stopMs(capped.panDps, axisCfg?.pan.amax),
        tiltMs: duration_ms + stopMs(capped.tiltDps, axisCfg?.tilt.amax),
      };
      const guarded = limitGuard(capped, rig.panDeg, rig.tiltDeg, effLimits(), horizon);
      await device.jog(guarded.out.panDps * cfg.panSign, guarded.out.tiltDps * cfg.tiltSign, duration_ms);
      // Surfaced so "I stopped because I'm at the limit" is distinguishable
      // from "the control is broken" — silence here is what makes an operator
      // push harder into a stop instead of backing off.
      const held: string[] = [];
      if (guarded.panBlocked) held.push("pan");
      if (guarded.tiltBlocked) held.push("tilt");
      const limitNote = held.length > 0 ? ` — held at travel limit: ${held.join(", ")}` : "";
      const dps = (v: number): number => Number(v.toFixed(2)) + 0; // + 0 turns -0 into 0
      return text(`jogged for ${duration_ms}ms (pan ${dps(guarded.out.panDps)}°/s tilt ${dps(guarded.out.tiltDps)}°/s)${limitNote}`);
    },
  );

  server.registerTool(
    "stop",
    { description: "Immediately stop all motion.", inputSchema: {} },
    // clearJog first: a live manual jog vector would otherwise keep being
    // refreshed by the keep-alive and resume the axis right after the stop.
    async () => { session.stop(); device.clearJog(); await device.stop(); return text("stopped"); },
  );

  // Shared by every tool that moves the head or rewrites its frame. NOT used by
  // estop/clear_estop: an E-STOP must always be allowed.
  const motionRefusal = (): ReturnType<typeof errText> | null => {
    if (supervisor.isSunLocked()) return errText(SUN_LOCKED_MSG);
    if (session.isActive()) return errText("tracking active; stop_tracking first");
    return null;
  };

  server.registerTool(
    "home",
    {
      description:
        "Home the tilt axis against its endstop (the head runs the homing move itself; completion arrives as " +
        "a homed/home_failed event). Pan has no endstop: use reference_pan or set_position for pan. " +
        "Refused while tracking or sun-locked.",
      inputSchema: { axes: z.array(z.enum(["tilt"])).optional().describe("axes to home; default tilt") },
    },
    async ({ axes }) => {
      const refused = motionRefusal();
      if (refused) return refused;
      try {
        await device.home(axes);
        return text("homing tilt — watch get_status.axes.tilt.homed");
      } catch (e) { return errText(`device rejected home: ${(e as Error).message}`); }
    },
  );

  server.registerTool(
    "set_position",
    {
      description:
        "Declare the head's CURRENT pose to be pan_deg/tilt_deg (user frame) without moving. A pan value " +
        "re-references pan: the head emits a pan_reference event with the delta and the host shifts " +
        "calibration, taught limits and the azimuth sector by it automatically (nothing is cleared, unlike the " +
        "retired ESP32 home-zeroing tool). Refused while tracking or sun-locked.",
      inputSchema: {
        pan_deg: z.number().optional().describe("pan angle the current pose should read, degrees (user frame)"),
        tilt_deg: z.number().optional().describe("tilt angle the current pose should read, degrees (user frame)"),
      },
    },
    async ({ pan_deg, tilt_deg }) => {
      if (pan_deg === undefined && tilt_deg === undefined) return errText("give pan_deg and/or tilt_deg");
      const refused = motionRefusal();
      if (refused) return refused;
      // User frame -> device frame, exactly as goto_angle does. NO
      // invalidateCalibration()/limitsStore.clear() here: the head's
      // pan_reference event carries the delta and the host shifts them.
      const pos = {
        ...(pan_deg !== undefined ? { pan: applySign(pan_deg, cfg.panSign) } : {}),
        ...(tilt_deg !== undefined ? { tilt: applySign(tilt_deg, cfg.tiltSign) } : {}),
      };
      try {
        await device.setPos(pos);
        return text(
          "position declared — the head will emit a pan_reference event and the host shifts calibration, " +
          "taught limits and the azimuth sector by the delta automatically (nothing was cleared)",
        );
      } catch (e) { return errText(`device rejected set_position: ${(e as Error).message}`); }
    },
  );

  server.registerTool(
    "reference_pan",
    {
      description:
        "Re-run the head's IMU north reference for pan. It also moves tilt to the reference angle on the " +
        "head, so it is refused while tracking or sun-locked.",
      inputSchema: {},
    },
    async () => {
      const refused = motionRefusal();
      if (refused) return refused;
      try {
        await device.reference();
        return text("re-referencing pan from the IMU — result arrives as a pan_reference event (see get_status.pan_ref)");
      } catch (e) { return errText(`device rejected reference_pan: ${(e as Error).message}`); }
    },
  );

  server.registerTool(
    "estop",
    {
      description:
        "Emergency stop: disarm the autonomous agent, end tracking, and latch the head (every motion route is " +
        "refused until clear_estop).",
      inputSchema: {},
    },
    // Always allowed: not gated by the sun lock or an active session. Order:
    // disarm the agent, end the session so nothing re-issues motion, then latch. The
    // supervisor has no abort method; its idle-park polls idleParkAbortReason(),
    // which reads "estop" from device state, so the latch alone aborts it
    // within one poll.
    async () => {
      // Spec 6.4: disarm the agent BEFORE stopping motion, so its next tick
      // cannot pick a new target the instant the latch is cleared. Done first
      // and unconditionally: a failed head post below must still leave the
      // agent disarmed.
      try { agentStore.set(false); }
      catch (e) { console.error(`[estop] could not persist agent disarm: ${(e as Error).message}`); }
      session.stop();
      try {
        await device.estop();
        return text("E-STOP latched; clear_estop to release");
      } catch (e) { return errText(`E-STOP post failed: ${(e as Error).message} — press the physical stop if the rig is moving`); }
    },
  );

  server.registerTool(
    "clear_estop",
    {
      description:
        "Release the E-STOP latch. Motion stays idle until commanded; the agent stays disarmed until " +
        "set_agent_armed {armed:true}.",
      inputSchema: {},
    },
    async () => {
      try {
        await device.clearEstop();
        return text("E-STOP cleared");
      } catch (e) { return errText(`device rejected clear_estop: ${(e as Error).message}`); }
    },
  );

  // The autonomous agent's armed flag (spec 6.4): the agent process always
  // runs and does nothing while disarmed. Default and fallback: disarmed.
  server.registerTool(
    "get_agent_armed",
    { description: "Whether the autonomous agent is armed (it picks and tracks targets only while armed).", inputSchema: {} },
    async () => text(JSON.stringify(agentStore.get())),
  );

  server.registerTool(
    "set_agent_armed",
    {
      description:
        "Arm or disarm the autonomous agent. Disarming does not stop a pass in progress; use stop_tracking " +
        "or estop for that. Persisted across restarts.",
      inputSchema: { armed: z.boolean().describe("true to arm the agent, false to disarm it") },
    },
    async ({ armed }) => {
      try {
        agentStore.set(armed);
        return text(JSON.stringify(agentStore.get()));
      } catch (e) { return errText(`could not persist the agent armed flag: ${(e as Error).message}`); }
    },
  );

  server.registerTool(
    "get_head_config",
    {
      description: "Read the head's whole config (pan/tilt/zoom/focus/global/head sections) as the head reports it.",
      inputSchema: {},
    },
    async () => {
      try { return text(JSON.stringify(await device.getHeadConfig(), null, 2)); }
      catch (e) { return errText(`head config unavailable: ${(e as Error).message}`); }
    },
  );

  server.registerTool(
    "set_head_config",
    {
      description:
        "Set one numeric head config value. Guarded keys (the global scope, socket/host_baud) are refused " +
        "with 403 unless force=true. save=true also writes it to the Pico's flash, which PAUSES its step " +
        "core for the duration: never while the rig is moving, so this is refused while tracking.",
      inputSchema: {
        scope: z.enum(["pan", "tilt", "zoom", "focus", "global"]),
        key: z.string().regex(/^[A-Za-z0-9_]+$/),
        value: z.number().finite(),
        save: z.boolean().default(false),
        force: z.boolean().default(false),
      },
    },
    async ({ scope, key, value, save, force }) => {
      if (session.isActive()) return errText("tracking active; stop_tracking first");
      try {
        return text(JSON.stringify(await device.setHeadConfig(scope, key, value, { save, force })));
      } catch (e) { return errText((e as Error).message); }
    },
  );

  server.registerTool(
    "get_capture_status",
    {
      description:
        "Recording/snapshot state: whether auto capture is on, whether the recorder is open, " +
        "the current pass ICAO, and the last snapshot or error.",
      inputSchema: {},
    },
    async () => text(JSON.stringify(capture.status(), null, 2)),
  );

  server.registerTool(
    "set_capture_mode",
    {
      description: "Enable or disable automatic capture on track lock.",
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      capture.setAuto(enabled);
      return text(`auto capture ${enabled ? "enabled" : "disabled"}`);
    },
  );

  server.registerTool(
    "capture_snapshot",
    {
      description: "Take one snapshot now, independent of tracking state.",
      inputSchema: { icao: z.string().optional() },
    },
    async ({ icao }) => {
      const p = await capture.manualSnapshot(icao);
      return text(`snapshot written to ${p}`);
    },
  );

  server.registerTool(
    "start_recording",
    { description: "Manually open the recording valve.", inputSchema: {} },
    async () => { await capture.setRecording(true); return text("recording started"); },
  );

  server.registerTool(
    "stop_recording",
    { description: "Manually close the recording valve.", inputSchema: {} },
    async () => { await capture.setRecording(false); return text("recording stopped"); },
  );

  server.registerTool(
    "list_passes",
    {
      description:
        "List recorded tracking passes with identity, framing geometry and tracking quality. Newest first.",
      inputSchema: {
        limit: z.number().int().positive().max(2000).optional().describe("max rows (default 500)"),
      },
    },
    async ({ limit }) => {
      const all = journal.list();
      const rows = all.slice(-(limit ?? 500)).reverse();
      return text(JSON.stringify({ count: rows.length, total: all.length, passes: rows }, null, 2));
    },
  );
}
