// Types and zod mirrors of the plainsight head API (docs/HEAD-API.md and the
// JSON Schemas in docs/head-api/schemas/). The schemas close every object
// (`additionalProperties: false`), so every object mirror here is `.strict()`:
// a field the head starts sending that this file does not know about makes the
// message fail to parse, and test/head-contract.test.ts catches the drift
// against the documented examples before it reaches the rig.
import { z } from "zod";

export const HEAD_AXES = ["pan", "tilt", "zoom", "focus"] as const;
export type HeadAxisName = (typeof HEAD_AXES)[number];

export interface HeadCal { sys: number; gyr: number; acc: number; mag: number }

export interface HeadAxis {
  pos: number;
  vel: number;
  tgt: number;
  mode: "I" | "P" | "T" | "V" | "H";
  homed: boolean;
  endstop: boolean;
  driver: boolean;
}

export interface HeadImu {
  ok: boolean;
  heading: number | null;
  pitch: number | null;
  roll: number | null;
  cal: HeadCal | null;
  tempC: number | null;
}

export interface HeadRef {
  pan: "none" | "imu" | "host";
  persisted: boolean;
  ageS: number | null;
  /** Names pan's frame: new on every new zero, kept through restores; null while pan is "none". */
  frameId: string | null;
}

export interface HeadLink { pico: boolean; imu: boolean }

export interface HeadTick {
  type: "tick";
  t: number;
  seq: number;
  /** Omitted while the Pico link is down: no motion telemetry in this tick. */
  axes?: Record<HeadAxisName, HeadAxis>;
  enabled?: boolean;
  moving?: boolean;
  estop: boolean;
  imu: HeadImu;
  tiltDisagreeDeg: number | null;
  ref: HeadRef;
  link: HeadLink;
}

export interface HeadEvent {
  type: "event";
  t: number;
  name: string;
  axis: string | null;
  detail: unknown;
}

/** The subset of a Pico axis config scope (`GET /api/config`) the host uses. */
export interface HeadAxisConfig { min: number; max: number; vmax: number; amax: number }

export interface HeadImuSample {
  t: number;
  heading: number;
  roll: number;
  pitch: number;
  quat: [number, number, number, number];
  gravity: [number, number, number];
  linacc: [number, number, number];
  cal: HeadCal;
  tempC: number;
}

export interface HeadImuBurst { n: number; samples: HeadImuSample[] }

export interface HeadTrackCmd {
  pan?: { pos: number; vel: number };
  tilt?: { pos: number; vel: number };
}

// --- zod mirrors -------------------------------------------------------------

const calLevel = z.number().int().min(0).max(3);
const CalZ = z.object({ sys: calLevel, gyr: calLevel, acc: calLevel, mag: calLevel }).strict();

const AxisZ = z.object({
  pos: z.number(),
  vel: z.number(),
  tgt: z.number(),
  mode: z.enum(["I", "P", "T", "V", "H"]),
  homed: z.boolean(),
  endstop: z.boolean(),
  driver: z.boolean(),
}).strict();

const ImuZ = z.object({
  ok: z.boolean(),
  heading: z.number().nullable(),
  pitch: z.number().nullable(),
  roll: z.number().nullable(),
  cal: CalZ.nullable(),
  tempC: z.number().nullable(),
}).strict();

const RefZ = z.object({
  pan: z.enum(["none", "imu", "host"]),
  persisted: z.boolean(),
  ageS: z.number().nullable(),
  frameId: z.string().nullable(),
}).strict();

/** tick.json: a WebSocket tick and the body of `GET /api/state`. */
export const HeadTickZ = z.object({
  type: z.literal("tick"),
  t: z.number().int(),
  seq: z.number().int(),
  axes: z.object({ pan: AxisZ, tilt: AxisZ, zoom: AxisZ, focus: AxisZ }).strict().optional(),
  enabled: z.boolean().optional(),
  moving: z.boolean().optional(),
  estop: z.boolean(),
  imu: ImuZ,
  tiltDisagreeDeg: z.number().nullable(),
  ref: RefZ,
  link: z.object({ pico: z.boolean(), imu: z.boolean() }).strict(),
}).strict();

function event<N extends z.ZodTypeAny, A extends z.ZodTypeAny, D extends z.ZodTypeAny>(
  name: N, axis: A, detail: D,
) {
  return z.object({ type: z.literal("event"), t: z.number().int(), name, axis, detail }).strict();
}

const PICO_EVENTS = [
  "homed", "home_failed", "endstop_hit", "track_timeout",
  "driver_online", "driver_offline", "driver_fault", "driver_config_failed",
] as const;

/** The `pan_reference` detail: renamed (rule 1) or dropped (rule 2). */
export const PanReferenceDetailZ = z.union([
  z.object({
    source: z.enum(["imu", "host"]),
    pan: z.number(),
    previous: z.number().nullable(),
    // Present only on a restore of the head's persisted position file: the
    // frame named by frameId coming back, not a new reference.
    reason: z.literal("restored").optional(),
    // The frame in force afterwards: new for a rename, the stored id for a restore.
    frameId: z.string(),
  }).strict(),
  z.object({
    source: z.literal("none"),
    reason: z.enum(["pan unhomed", "enable off"]),
  }).strict(),
]);

/** event.json: one `oneOf` branch per event name. */
export const HeadEventZ = z.union([
  // Pico `*E` lines: `detail` is the rest of the line, or null (always null for `homed`).
  event(z.enum(PICO_EVENTS), z.enum(HEAD_AXES), z.string().nullable()),
  event(z.literal("estop"), z.null(), z.null()),
  event(z.literal("estop_cleared"), z.null(), z.null()),
  event(z.literal("config"), z.null(),
    z.object({ scope: z.string(), key: z.string(), value: z.number() }).strict()),
  event(z.literal("pico_link"), z.null(), z.object({ up: z.boolean() }).strict()),
  event(z.literal("pan_reference"), z.null(), PanReferenceDetailZ),
  event(z.literal("pan_reference_failed"), z.null(),
    z.object({ reason: z.string(), source: z.enum(["none", "imu", "host"]) }).strict()),
]);

const axisScalars = {
  pan: z.number().optional(),
  tilt: z.number().optional(),
  zoom: z.number().optional(),
  focus: z.number().optional(),
};
const nonEmpty = (o: object) => Object.keys(o).length > 0;

/** goto.json / jog.json / setpos.json: any non-empty subset of the four axes. */
export const HeadGotoZ = z.object(axisScalars).strict().refine(nonEmpty, "at least one axis");
export const HeadJogZ = HeadGotoZ;
export const HeadSetposZ = HeadGotoZ;

const TrackAxisZ = z.object({ pos: z.number(), vel: z.number() }).strict();
/** track.json: pan and/or tilt, each a {pos, vel} pair. */
export const HeadTrackZ = z.object({ pan: TrackAxisZ.optional(), tilt: TrackAxisZ.optional() })
  .strict().refine(nonEmpty, "at least one axis");

const token = z.string().regex(/^[A-Za-z0-9_]+$/);
/** config-set.json: one Pico setting. */
export const HeadConfigSetZ = z.object({
  scope: token, key: token, value: z.number(), save: z.boolean().optional(),
}).strict();

const vec = (n: number) => z.array(z.number()).length(n);
/** imu-burst.json: the `GET /api/imu` response. */
export const HeadImuBurstZ = z.object({
  n: z.number().int().min(1),
  samples: z.array(z.object({
    t: z.number(),
    heading: z.number(),
    roll: z.number(),
    pitch: z.number(),
    quat: vec(4),
    gravity: vec(3),
    linacc: vec(3),
    cal: CalZ,
    tempC: z.number(),
  }).strict()),
}).strict();

/**
 * The pan/tilt scopes of `GET /api/config`. The Pico scopes carry more keys
 * than the host reads, and the full set is the firmware's, so these objects
 * are deliberately NOT strict: only the four keys the host needs are required.
 */
const AxisConfigZ = z.object({
  min: z.number(), max: z.number(), vmax: z.number(), amax: z.number(),
}).passthrough();
/** The whole `GET /api/config` body ({pan, tilt, zoom, focus, global, head}), validated loosely. */
export const HeadConfigResponseZ = z.record(z.string(), z.record(z.string(), z.unknown()));
export type HeadConfigResponse = z.infer<typeof HeadConfigResponseZ>;

export const HeadAxisConfigResponseZ = z.object({ pan: AxisConfigZ, tilt: AxisConfigZ }).passthrough();
