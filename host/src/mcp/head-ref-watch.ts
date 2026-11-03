// The host's memory of WHICH pan frame its calibration lives in (task-7 fix
// rounds, E2). The head names every frame: a new `frameId` is minted for
// every new zero (setpos, IMU north) and carried unchanged through restores
// of its persisted position and through keeping a still-homed Pico's
// position (docs/HEAD-API.md, `ref.frameId`). So "same id, same frame".
//
// The id the calibration is known to be in is persisted in head-ref.json.
// Two inputs move it:
//   - a `pan_reference` event (reference-shift.ts): the rename is EXPLAINED --
//     shifted by its delta, or flagged by the E1 rule -- and its frameId is
//     accepted here;
//   - a tick whose `ref.frameId` differs from the known id with no event
//     having explained it (checked on the first tick of every connection and
//     on every tick where the id changes): a rename the host never saw (link
//     down, host not running, or a head restart that minted a new frame), so
//     the calibration's frame is unknown -> onMismatch ->
//     CalibrationStore.markFrameUnverified. The new id is then accepted, so it
//     flags once.
//
// A tick with `ref.pan === "none"` (frameId null) is skipped: the unreferenced
// gate covers that state, and the known id survives the drop so a restore of
// the same frame compares equal.
//
// The head emits `pan_reference` before any tick carrying the new id (it sets
// the ref and publishes the event with no await between), and Device
// delivers messages in order, so a live rename is always explained first.
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { HeadRef } from "../shared/head-types.js";
import type { PanFrameMemory } from "./reference-shift.js";

const FileSchema = z.object({ frameId: z.string().min(1) }).strict();

export class HeadRefWatch implements PanFrameMemory {
  private known: string | null = null;
  private lastTickFrameId: string | null = null;

  constructor(private readonly filePath: string, private readonly onMismatch: (why: string) => void) {}

  load(): void {
    try {
      this.known = existsSync(this.filePath) ? FileSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8"))).frameId : null;
    } catch {
      this.known = null;   // missing/corrupt -> no history; never throw
    }
  }

  knownFrameId(): string | null { return this.known; }

  acceptFrame(frameId: string): void {
    if (frameId === this.known) return;
    this.known = frameId;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ frameId }));
    renameSync(tmp, this.filePath);   // atomic on the same filesystem
  }

  observe(ref: HeadRef, firstSinceConnect: boolean): void {
    const id = ref.pan === "none" ? null : ref.frameId;
    const changed = firstSinceConnect || id !== this.lastTickFrameId;
    this.lastTickFrameId = id;
    if (id === null || !changed) return;
    // No history at all (first run): nothing to compare against.
    if (this.known === null) { this.acceptFrame(id); return; }
    if (id === this.known) return;
    this.onMismatch(
      `the head's pan frame changed from ${this.known} to ${id} with no pan_reference event the host saw ` +
      `(the telemetry link was down, the host was not running, or the head minted a new frame)`,
    );
    this.acceptFrame(id);
  }
}
