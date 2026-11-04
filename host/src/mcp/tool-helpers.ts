// Shared MCP tool-response helpers. Extracted from tools.ts/geo-tools.ts/
// track-tools.ts/sun-tools.ts, which each defined text()/errText() (and,
// tools.ts + geo-tools.ts, an identical SUN_LOCKED_MSG) independently.

export function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export function errText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

// The standing sun-lockout refusal message. Byte-identical to the copies it
// replaces (tools.ts, geo-tools.ts) — existing tests assert this string.
export const SUN_LOCKED_MSG = "sun guard active; blocked to protect the camera — clear it with set_sun_guard";
// Spec 6.8 rule 2: the head reports pan's origin unknown (Pico reboot,
// ENABLE 0), so automated motion is refused. Manual jog/goto stay available;
// these two tools are how the operator gives pan a zero again.
export const PAN_UNREFERENCED_MSG = "pan unreferenced — run reference_pan or set_position";
// The head's E-STOP latch is set (from any source: the MCP estop tool, the
// dashboard, the head API directly). An E-STOP is terminal for host
// automation: nothing that starts motion is accepted while it is latched, so
// nothing can be queued up to move the head the moment it is cleared.
export const ESTOP_LATCHED_MSG = "estop_latched — the head's E-STOP is latched; clear_estop first (nothing resumes on its own)";
// The pan reference changed with no known offset from the calibration's frame
// (see CalibrationStore.frameUnverified).
export const CALIBRATION_UNVERIFIED_MSG =
  "calibration frame unverified — pan was re-referenced with no known offset from the frame the calibration was solved in; " +
  "re-sight and solve_calibration (the safe path), or confirm_pan_frame only if you are sure pan was not renamed";

// The same unknown-offset re-reference left the taught pan limits in the old
// frame (LimitsStore.panLimitsUnverified).
export const PAN_LIMITS_UNVERIFIED_MSG =
  "taught pan limits unverified — pan was re-referenced with no known offset from the frame they were taught in, " +
  "so they may no longer keep pan off the cable; re-teach them (teach_limit pan_min/pan_max), or " +
  "confirm_taught_limits only if you are sure the head was not moved";

/** The tool-facing refusal for a session automation block (session.ts AutomationBlock). */
export function automationBlockMsg(block: "pan_unreferenced" | "calibration_unverified" | "pan_limits_unverified"): string {
  if (block === "pan_unreferenced") return PAN_UNREFERENCED_MSG;
  return block === "calibration_unverified" ? CALIBRATION_UNVERIFIED_MSG : PAN_LIMITS_UNVERIFIED_MSG;
}

/**
 * What a frame-verifying solve or confirm_pan_frame may say about automation
 * afterwards: it is allowed again only if the taught pan limits are not still
 * flagged from the same re-reference.
 */
export function automationAfterFrameVerified(panLimitsUnverified: boolean): string {
  return panLimitsUnverified
    ? `Automated motion is STILL BLOCKED: ${PAN_LIMITS_UNVERIFIED_MSG}.`
    : "Automated motion is allowed again.";
}
