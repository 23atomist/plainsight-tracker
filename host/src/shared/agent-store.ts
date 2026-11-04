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

  set(armed: boolean): void {
    this.state = { armed };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }
}
