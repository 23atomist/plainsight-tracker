import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const AgentSchema = z.object({ armed: z.boolean() });

export interface AgentArmed { armed: boolean }

const DISARMED: AgentArmed = { armed: false };

/**
 * Persistence for the autonomous agent's armed flag (spec 6.4). The agent
 * container always runs; each tick it reads this flag and does nothing while
 * disarmed. It replaces `systemd start/stop` of the agent unit, so the
 * dashboard's Auto toggle and the E-STOP agent leg need no host privileges.
 *
 * Same JSON-file shape and failure behaviour as FloorStore, except the
 * fallback direction is the safe one here: a missing or corrupt file reads
 * as DISARMED, so a damaged state file can never start autonomous motion.
 */
export class AgentStore {
  private state: AgentArmed = { ...DISARMED };
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.state = { ...DISARMED }; return; }
      this.state = AgentSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      this.state = { ...DISARMED };   // missing/corrupt -> disarmed; never throw
    }
  }

  get(): AgentArmed { return { ...this.state }; }

  // A failed write throws, and must never leave the agent armed in memory:
  //  - arming writes the disk FIRST and only then flips memory, so an arm that
  //    could not be persisted never takes effect;
  //  - disarming flips memory FIRST, so the disarm takes effect in this
  //    process even when the disk write then fails (the caller still sees
  //    the error; the next restart reads whatever the file says, and the
  //    file can only say armed if an earlier arm WAS persisted).
  set(armed: boolean): void {
    const next: AgentArmed = { armed };
    if (!armed) this.state = next;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
    this.state = next;
  }
}
