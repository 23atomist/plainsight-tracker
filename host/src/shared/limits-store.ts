// Operator-taught travel limits: a tighter, per-edge override of the
// configured pan/tilt ceiling (config.ts's panMin/panMax/tiltMin/tiltMax),
// captured by jogging the rig to where a cable just begins to tension and
// recording that position (see limits-tools.ts's teach_limit). Persisted the
// same way CalibrationStore/SectorStore are: an atomic tmp+rename write,
// missing/corrupt file collapses to "nothing taught" rather than throwing.
//
// The config ceiling is the hardware-agnostic bound an operator picks from a
// spec sheet; the taught limit is what THIS rig's wiring actually tolerates,
// found by feel. A taught edge may only ever narrow the ceiling, never widen
// it — effectiveLimits() below is the one place that combines the two, and
// every caller that needs to know how far the rig may actually travel (rate
// jog, absolute moves, tracking, pointing) must go through it rather than
// reading config.ts's panMin/panMax/tiltMin/tiltMax directly. A limit
// enforced against only the config ceiling in some path and the effective
// value in another is exactly the gap this store exists to close.
import { z } from "zod";
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export type LimitEdge = "panMin" | "panMax" | "tiltMin" | "tiltMax";
export type PanEdge = "panMin" | "panMax";
const PAN_EDGES: readonly PanEdge[] = ["panMin", "panMax"];

const TaughtLimitsSchema = z.object({
  version: z.literal(1),
  panMin: z.number().optional(),
  panMax: z.number().optional(),
  tiltMin: z.number().optional(),
  tiltMax: z.number().optional(),
  // The taught pan edges still in a pan frame of unknown offset from the
  // current one (see markPanUnverified). Absent when every taught pan edge
  // is verified. Part of the automation gate (session.ts automationBlock).
  panLimitsUnverified: z.array(z.enum(["panMin", "panMax"])).min(1).optional(),
});
export type TaughtLimits = z.infer<typeof TaughtLimitsSchema>;

// The subset effectiveLimits()/LimitsStore actually need — deliberately NOT
// TaughtLimits (which also carries `version`), so a caller (TrackingSession's
// default limitsProvider, SunSupervisor's) can hand back a bare `{}` without
// having to fabricate a schema version for a value that is never persisted.
export interface TaughtEdges {
  panMin?: number;
  panMax?: number;
  tiltMin?: number;
  tiltMax?: number;
  // See TaughtLimitsSchema. Carried here so every limitsProvider (session,
  // supervisor) sees the gate in the same read as the edges.
  panLimitsUnverified?: readonly PanEdge[];
}

export interface CeilingLimits {
  panMin: number;
  panMax: number;
  tiltMin: number;
  tiltMax: number;
}

function empty(): TaughtLimits {
  return { version: 1 };
}

// The effective pan/tilt range enforced everywhere: a taught edge if present,
// else the config ceiling on that side. Re-clamped to the ceiling HERE (not
// just at teach time in limits-tools.ts) so a config edit after teaching can
// only ever tighten what is enforced, never let a stale taught value silently
// widen past a newly-lowered ceiling.
export function effectiveLimits(ceiling: CeilingLimits, taught: TaughtEdges): CeilingLimits {
  return {
    panMin: taught.panMin !== undefined ? Math.max(taught.panMin, ceiling.panMin) : ceiling.panMin,
    panMax: taught.panMax !== undefined ? Math.min(taught.panMax, ceiling.panMax) : ceiling.panMax,
    tiltMin: taught.tiltMin !== undefined ? Math.max(taught.tiltMin, ceiling.tiltMin) : ceiling.tiltMin,
    tiltMax: taught.tiltMax !== undefined ? Math.min(taught.tiltMax, ceiling.tiltMax) : ceiling.tiltMax,
  };
}

export class LimitsStore {
  private limits: TaughtLimits = empty();
  constructor(private readonly filePath: string) {}

  load(): void {
    try {
      if (!existsSync(this.filePath)) { this.limits = empty(); return; }
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.limits = TaughtLimitsSchema.parse(raw);
    } catch {
      // Missing/corrupt/invalid → nothing taught (falls back to the config
      // ceiling everywhere). Never throw.
      this.limits = empty();
    }
  }

  get(): TaughtLimits {
    const l = this.limits;
    return l.panLimitsUnverified ? { ...l, panLimitsUnverified: [...l.panLimitsUnverified] } : { ...l };
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.limits, null, 2));
    renameSync(tmp, this.filePath); // atomic on the same filesystem
  }

  // Teaching a pan edge re-captures it in the current frame, so it is no
  // longer unverified; the flag clears once every flagged edge is re-taught.
  setEdge(edge: LimitEdge, value: number): void {
    this.limits = withUnverified({ ...this.limits, [edge]: value }, this.panUnverifiedEdges().filter((e) => e !== edge));
    this.save();
  }

  /** The taught pan edges still in a frame of unknown offset (empty: verified). */
  panUnverifiedEdges(): PanEdge[] {
    return [...(this.limits.panLimitsUnverified ?? [])];
  }

  isPanUnverified(): boolean {
    return this.panUnverifiedEdges().length > 0;
  }

  // Pan was re-referenced with no known offset from the frame the taught pan
  // edges were captured in (reference-shift.ts, the same moment the
  // calibration is flagged): they may now be off by that unknown offset, so
  // they cannot be trusted to keep the axis off the cable or an obstruction.
  // Flags every taught pan edge; returns those flagged (none taught: nothing
  // to flag, no gate). Tilt is referenced by its endstop and is untouched.
  markPanUnverified(): PanEdge[] {
    const taught = PAN_EDGES.filter((e) => this.limits[e] !== undefined);
    if (taught.length === 0) return [];
    this.limits = withUnverified(this.limits, taught);
    this.save();
    return taught;
  }

  // The operator vouches that the taught pan edges still mark the same
  // physical poses (the head was not moved while pan lost its frame).
  // Idempotent: returns whether anything was unverified.
  confirmPan(): boolean {
    if (!this.isPanUnverified()) return false;
    this.limits = withUnverified(this.limits, []);
    this.save();
    return true;
  }

  // The head renamed pan (spec 6.8 rule 1; see mcp/reference-shift.ts): the
  // pose a taught pan edge was captured at now reads `old + deltaDeg`. The
  // edges are positions on the Pico's CONTINUOUS pan counter -- a cable
  // limits this axis -- so they move by the counter's own (unwrapped) shift
  // and are never folded into (-180, 180]: folding would flip an edge near
  // +180 to the far side of the travel and invert the range. An edge pushed
  // past the config ceiling is harmless: effectiveLimits() clamps to the
  // ceiling, which is where the head's own limit stops the axis anyway.
  // Tilt is referenced by its endstop, not by pan's zero, and is untouched.
  shiftPan(deltaDeg: number): void {
    if (deltaDeg === 0) return;
    // A known shift does not verify an edge that was already unverified: the
    // unknown offset it carries is still in it, so the flag rides along.
    const { panMin, panMax } = this.limits;
    this.limits = {
      ...this.limits,
      ...(panMin !== undefined ? { panMin: panMin + deltaDeg } : {}),
      ...(panMax !== undefined ? { panMax: panMax + deltaDeg } : {}),
    };
    this.save();
  }

  // A re-zero of the step origin leaves every taught edge captured against
  // the OLD zero, meaningless (possibly dangerously so — a "tighter" limit
  // under the old origin could sit anywhere under the new one), so it must be
  // invalidated exactly the way CalibrationStore's orientation is.
  clear(): void {
    this.limits = empty();
    this.save();
  }
}

function withUnverified(l: TaughtLimits, edges: readonly PanEdge[]): TaughtLimits {
  const { panLimitsUnverified: _drop, ...rest } = l;
  return edges.length > 0 ? { ...rest, panLimitsUnverified: [...edges] } : rest;
}
