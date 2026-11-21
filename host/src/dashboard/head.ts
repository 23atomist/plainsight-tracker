import { HeadDirect, parseHeadState } from "./parse.js";
import { ESTOP_TIMEOUT_MS, LATCHED_UNCONFIRMED, latchedUnconfirmed, type EstopOutcome } from "../shared/head-estop.js";

// The state poll runs every dashboard tick, so it gets a short budget.
const STATE_TIMEOUT_MS = 2000;
// The head answers stop/estop only after the Pico replies (head-estop.ts).
const COMMAND_TIMEOUT_MS = ESTOP_TIMEOUT_MS;

export type { EstopOutcome };

/**
 * The dashboard's own line to the head controller, independent of the MCP
 * daemon. This is what makes the dashboard E-STOP work with the MCP server
 * down: the latch goes straight to `POST /api/estop`. No auth: the head has
 * none (it sits on the rig's LAN segment).
 */
export class HeadDirectClient {
  private readonly base: string;

  constructor(url: string, private readonly fetchFn: typeof fetch = fetch) {
    this.base = url.replace(/\/+$/, "");
  }

  /** Never throws: an unreachable head or a body that is not a tick reads as "not connected". */
  async state(): Promise<HeadDirect> {
    try {
      const r = await this.fetchFn(`${this.base}/api/state`, { signal: AbortSignal.timeout(STATE_TIMEOUT_MS) });
      if (!r.ok) return parseHeadState(null);
      return parseHeadState(await r.json());
    } catch {
      return parseHeadState(null);
    }
  }

  /**
   * Latch the head's E-STOP. A JSON answer from the head means the latch is
   * set: 2xx is confirmed by the Pico; 400/502/503/504 is latched but NOT
   * confirmed (resolves with a warning -- the stop did happen on the head
   * side, and calling it a failure would send the operator hunting for a
   * fault in the wrong place). Throws only when the head was not reached,
   * did not answer JSON, or answered something else: then nothing says the
   * latch is set.
   */
  async estop(): Promise<EstopOutcome> {
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}/api/estop`, { method: "POST", signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) });
    } catch (e) {
      throw new Error(`head unreachable at ${this.base}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let body: { error?: unknown };
    try {
      body = await r.json() as { error?: unknown };
    } catch {
      throw new Error(`E-STOP not confirmed: HTTP ${r.status} from ${this.base} was not a head answer (not JSON)`);
    }
    if (r.ok) return { picoConfirmed: true };
    const headError = typeof body?.error === "string" ? body.error : null;
    if (LATCHED_UNCONFIRMED.has(r.status)) return latchedUnconfirmed(r.status, headError);
    throw new Error(`E-STOP not confirmed: HTTP ${r.status}${headError ? ` ${headError}` : ""}`);
  }

  /** Release the latch. Safe when not latched. */
  async clearEstop(): Promise<void> {
    await this.post("/api/estop/clear", "the head did not clear E-STOP");
  }

  /** Stop all axes. Not guarded by the latch on the head side. */
  async stop(): Promise<void> {
    await this.post("/api/stop", "the head did not confirm the stop");
  }

  /**
   * Move focus by `deltaDeg` output-shaft degrees from where it is heading
   * (its target, not its position), and return the new target. Direct to the
   * head like the E-STOP: the MCP daemon never drives focus, so there is
   * nothing to coordinate with, and the head's own latch (423) refuses it
   * during an E-STOP.
   */
  async focusNudge(deltaDeg: number): Promise<number> {
    const st = await this.state();
    if (!st.connected || st.focusTgtDeg === null) throw new Error(`no focus telemetry from the head at ${this.base}`);
    const target = st.focusTgtDeg + deltaDeg;
    await this.post("/api/goto", "the head refused the focus move", { focus: target });
    return target;
  }

  /** Stop the focus axis only. */
  async focusStop(): Promise<void> {
    await this.post("/api/stop", "the head did not confirm the focus stop", { axes: ["focus"] });
  }

  private async post(path: string, failure: string, body?: Record<string, unknown>): Promise<void> {
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new Error(`head unreachable at ${this.base}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (r.ok) return;
    throw new Error(`${failure}: HTTP ${r.status}${await errorText(r)}`);
  }
}

async function errorText(r: Response): Promise<string> {
  try {
    const body = await r.json() as { error?: unknown };
    return typeof body?.error === "string" ? ` ${body.error}` : "";
  } catch {
    return "";
  }
}
