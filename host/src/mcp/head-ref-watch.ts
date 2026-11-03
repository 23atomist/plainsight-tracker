// Missed-rename detection (task-7 fix round, E2). A pan_reference event sent
// while the host's WebSocket was down -- or while the host itself was not
// running -- is simply gone, and with it the delta the calibration needed.
// The tick's `ref` still describes the CURRENT reference: its source, and
// (via ageS) when it was set. So the host remembers that identity in
// head-ref.json, and on the first tick of every (re)connection compares: a
// different source, or a set time more than REF_IDENTITY_TOLERANCE_MS away,
// means the reference changed behind our back and the calibration's frame
// can no longer be trusted (onMismatch -> CalibrationStore.markFrameUnverified).
//
// `ref.pan === "none"` is not an identity: nothing is compared or written, so
// the last referenced identity survives a drop -- and a restore of the
// head's persisted position after it compares equal instead of flagging. The
// unreferenced gate covers the "none" state itself.
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { HeadRef } from "../shared/head-types.js";

// ageS has one decimal and the host stamps it with its own clock at receipt,
// so the derived set time jitters by a tick or two; a real re-reference moves
// it by the whole time the link was down.
export const REF_IDENTITY_TOLERANCE_MS = 5000;

const IdentitySchema = z.object({ source: z.enum(["imu", "host"]), setAtMs: z.number() }).strict();
type Identity = z.infer<typeof IdentitySchema>;

export class HeadRefWatch {
  private last: Identity | null = null;

  constructor(private readonly filePath: string, private readonly onMismatch: (why: string) => void) {}

  load(): void {
    try {
      this.last = existsSync(this.filePath) ? IdentitySchema.parse(JSON.parse(readFileSync(this.filePath, "utf8"))) : null;
    } catch {
      this.last = null;   // missing/corrupt -> no history; never throw
    }
  }

  observe(ref: HeadRef, firstSinceConnect: boolean, nowMs: number): void {
    if (ref.pan === "none" || ref.ageS === null) return;
    const cur: Identity = { source: ref.pan, setAtMs: nowMs - ref.ageS * 1000 };
    const last = this.last;
    const differs = last === null || last.source !== cur.source
      || Math.abs(last.setAtMs - cur.setAtMs) > REF_IDENTITY_TOLERANCE_MS;
    if (firstSinceConnect && last !== null && differs) {
      this.onMismatch(
        `the pan reference changed while the telemetry link was down (or the host was not running): ` +
        `was ${last.source} set at ${new Date(last.setAtMs).toISOString()}, ` +
        `on reconnect ${cur.source} set at ${new Date(cur.setAtMs).toISOString()}`,
      );
    }
    if (differs) this.write(cur);
  }

  private write(cur: Identity): void {
    this.last = cur;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(cur));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }
}
