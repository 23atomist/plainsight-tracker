// What a `POST /api/estop` answer means (docs/HEAD-API.md "POST /api/estop"),
// shared by the two clients that send one: the MCP Device and the
// dashboard's own HeadDirectClient. They must agree, or one of them reports
// a latched head as a failure.

// The head answers estop only after the Pico replies, and gives the Pico
// 5 s for it ("Common error statuses"). A shorter budget would report a
// failure for an E-STOP the head is still confirming.
export const ESTOP_TIMEOUT_MS = 6000;

// The latch is set BEFORE the Pico round trip and stays set if the send
// fails, so these statuses, when they are the head's own (JSON) answer, mean
// latched but not confirmed by the Pico -- not a failure.
export const LATCHED_UNCONFIRMED: ReadonlySet<number> = new Set([400, 502, 503, 504]);

export interface EstopOutcome {
  // false: the head's latch IS set (every motion route refuses), but the
  // Pico did not confirm the stop -- check the head.
  picoConfirmed: boolean;
  warning?: string;
}

export function latchedUnconfirmed(status: number, headError: string | null): EstopOutcome {
  const err = headError ? ` ${headError}` : "";
  return {
    picoConfirmed: false,
    warning: `head E-STOP latched, but the Pico did not confirm the stop (HTTP ${status}${err}) -- check the head`,
  };
}
