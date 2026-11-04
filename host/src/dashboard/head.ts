import { HeadDirect, parseHeadState } from "./parse.js";

// The state poll runs every dashboard tick, so it gets a short budget.
const STATE_TIMEOUT_MS = 2000;
// The head answers stop/estop only after the Pico replies, and gives the Pico
// 5 s for those (docs/HEAD-API.md, "Common error statuses"). A shorter budget
// here would report a failure for an E-STOP the head is still confirming.
const COMMAND_TIMEOUT_MS = 6000;

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
   * Latch the head's E-STOP. Throws when the head did not confirm, so the
   * dashboard's E-STOP reports the head leg as failed. Any answer from the
   * head at all means the latch is set (it latches before talking to the
   * Pico); a non-2xx answer means the Pico has not confirmed the stop.
   */
  async estop(): Promise<void> {
    await this.post("/api/estop", "the head latched E-STOP but the Pico did not confirm the stop");
  }

  /** Release the latch. Safe when not latched. */
  async clearEstop(): Promise<void> {
    await this.post("/api/estop/clear", "the head did not clear E-STOP");
  }

  /** Stop all axes. Not guarded by the latch on the head side. */
  async stop(): Promise<void> {
    await this.post("/api/stop", "the head did not confirm the stop");
  }

  private async post(path: string, failure: string): Promise<void> {
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}${path}`, { method: "POST", signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) });
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
