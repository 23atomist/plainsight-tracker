import WebSocket from "ws";
import type { ZodError } from "zod";
import { Config } from "./config.js";
import { DeviceState } from "./types.js";
import {
  HeadAxisConfig, HeadAxisConfigResponseZ, HeadAxisName, HeadEvent, HeadEventZ, HeadImuBurstZ, HeadRef,
  HeadTick, HeadTickZ, HeadTrackCmd, PanReferenceDetailZ,
} from "./head-types.js";
import { Vec3, normalize } from "./geo/vec3.js";

const ARRIVAL_TOL_DEG = 0.25;
const COMMAND_TIMEOUT_MS = 2000;
// A 100-sample burst at the BNO055's rate takes about a second; the margin is
// for a slow link. characterize_imu handles retries per rig position.
const IMU_TIMEOUT_MS = 20000;
const RECONNECT_MS = 1000;
const JOG_KEEPALIVE_MS = 100;
const CONFIG_RETRY_MS = 2000;
// At most one console warning per kind of rejected message per window: a head
// that drifts from the contract sends a reject every tick (10 Hz).
const REJECT_WARN_INTERVAL_MS = 10_000;

type RejectKind = "tick" | "event" | "config";

// A motion POST waiting its turn in the Device's FIFO (see enqueueMotion).
type MotionKind = "goto" | "track" | "stop" | "jog" | "home" | "setpos";
interface MotionCommand {
  readonly kind: MotionKind;
  readonly path: string;
  readonly body: object | undefined;
  // The axes a TRACK carries, for coalescing.
  readonly axes: readonly string[];
  readonly resolve: () => void;
  readonly reject: (e: unknown) => void;
}

// Whether queued-but-unsent `older` is made pointless by `newer`: a newer jog
// frame always replaces an older one (both carry pan and tilt), and a newer
// TRACK replaces an older one that it covers axis for axis. A TRACK that
// leaves out an axis the older one had (the limit guard holding that axis)
// does not, so the older one's other axis is never silently lost.
function supersedes(newer: MotionCommand, older: MotionCommand): boolean {
  if (newer.kind !== older.kind) return false;
  if (newer.kind === "jog") return true;
  return newer.kind === "track" && older.axes.every((a) => newer.axes.includes(a));
}

/** Counts of head messages the client could not use (see Device.getDiagnostics). */
export interface DeviceDiagnostics {
  rejectedTicks: number;
  rejectedEvents: number;
  rejectedConfig: number;
}

/** A pan reference change, from a `pan_reference` event. */
export interface ReferenceChange {
  source: HeadRef["pan"];
  /** The new pan value of the physical position (null when the reference was dropped). */
  pan: number | null;
  /** The same position in the old frame (null when there was no frame to shift from). */
  previous: number | null;
}

export type AxisConfig = Record<"pan" | "tilt", HeadAxisConfig>;

/**
 * A non-OK HTTP response from the head, carrying the status code alongside
 * the head's error text. Callers that must react differently per cause
 * (409 "pan is moving" is routine and self-healing, 423 is a latched E-STOP,
 * 503 a Pico link that is down) need the code, and matching on the message
 * string would couple them to the head's wording. Thrown with the message the
 * head sent (its `{ok:false, error}` envelope), so existing message-formatting
 * call sites are unaffected.
 */
export class DeviceHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DeviceHttpError";
  }
}

type FetchFn = typeof fetch;
type WsFactory = (url: string) => WebSocket;

/**
 * The one module that talks to the head (docs/HEAD-API.md). Commands are HTTP;
 * `/ws` is read-only telemetry (ticks and events). Single host, reconnect
 * every second.
 */
export class Device {
  private readonly httpBase: string;
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private state: DeviceState = {
    connected: false, panDeg: 0, tiltDeg: 0, zoomDeg: 0, focusDeg: 0,
    moving: false, enabled: false, estop: false, tiltDisagreeDeg: null,
    ref: { pan: "none", persisted: false, ageS: null },
    link: { pico: false, imu: false },
    lastUpdateMs: 0,
  };
  private axisConfig: AxisConfig | null = null;
  private configGeneration = 0;
  private configRetryTimer: NodeJS.Timeout | null = null;

  // A message that fails the strict schema is dropped. Silently, that looks
  // exactly like the 2026-07-22 telemetry freeze (one unparseable token cost
  // the whole tick, lastUpdateMs froze while the socket stayed up, and nothing
  // said why), so every reject is counted and warned about, rate-limited.
  private rejected: Record<RejectKind, number> = { tick: 0, event: 0, config: 0 };
  private lastRejectWarnMs: Record<RejectKind, number> = { tick: -Infinity, event: -Infinity, config: -Infinity };

  private jogVec: { panDps: number; tiltDps: number; expiresAtMs: number } | null = null;
  private jogTimer: NodeJS.Timeout | null = null;
  private jogLocked = false;
  // Every motion POST (goto, TRACK, STOP, home, setpos, jog frames including the keep-alive)
  // leaves this Device strictly in call order, one in flight at a time. Two
  // HTTP requests in flight can reach the head in either order, and in motion
  // the order IS the meaning: a STOP that lands after the park goto it
  // preceded cancels the park, a late TRACK after a STOP restarts the axis, a
  // stale jog refresh after the final zero leaves the axis jogging until the
  // head's dead-man. The head serializes its Pico commands anyway, so this
  // costs one round trip of latency, not throughput. Superseded TRACK and jog
  // frames coalesce (see supersedes()), so a slow head never builds a backlog
  // of stale setpoints.
  private motionQueue: readonly MotionCommand[] = [];
  private motionDraining = false;
  // The newest jog frame queued; jog() waits for it (the final zero) to be answered.
  private lastJogFrame: Promise<void> | null = null;
  private jogError: unknown = null;
  // Bumped by close() and estop(): an in-progress jog() loop sees the change
  // and exits instead of re-arming the keep-alive.
  private jogEpoch = 0;

  // Fired once per REAL parsed telemetry tick (see onMessage below), not on
  // a timer -- a caller that needs one sample per tick with no drops and no
  // duplicates (PostureHistory's feed in server.ts, added in vision-lock
  // fix round 2) should use this instead of polling getState() on its own
  // schedule, which can both miss a tick (two land between polls) and
  // duplicate one (a poll lands between two ticks with nothing new to
  // report). Only ticks that carry `axes` count: an IMU-only tick (Pico link
  // down) has no posture in it, and replaying the frozen one would be exactly
  // the duplicate this listener exists to avoid.
  private telemetryListeners: ((s: DeviceState) => void)[] = [];
  private eventListeners: ((e: HeadEvent) => void)[] = [];
  private referenceListeners: ((c: ReferenceChange) => void)[] = [];
  private configListeners: ((c: AxisConfig) => void)[] = [];

  constructor(
    cfg: Config,
    private readonly now: () => number = Date.now,
    private readonly fetchFn: FetchFn = fetch,
    private readonly wsFactory: WsFactory = (url) => new WebSocket(url),
  ) {
    const base = new URL(cfg.headUrl);
    this.httpBase = base.origin;
    this.wsUrl = `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}/ws`;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.configRetryTimer) { clearTimeout(this.configRetryTimer); this.configRetryTimer = null; }
    this.abortJog();
    // A closed Device sends nothing more: queued motion is refused, not sent
    // late to whatever answers at that address next.
    const dropped = this.motionQueue;
    this.motionQueue = [];
    for (const d of dropped) d.reject(new Error("device closed"));
    this.ws?.removeAllListeners();
    this.ws?.on("error", () => { /* a close() during CONNECTING errors; nothing listens any more */ });
    this.ws?.close();
    this.ws = null;
    this.state.connected = false;
  }

  getState(): DeviceState { return this.snapshot(); }

  /** Head messages rejected so far (malformed JSON, or failing the strict schema). */
  getDiagnostics(): DeviceDiagnostics {
    return {
      rejectedTicks: this.rejected.tick,
      rejectedEvents: this.rejected.event,
      rejectedConfig: this.rejected.config,
    };
  }

  private reject(kind: RejectKind, why: string): void {
    this.rejected[kind] += 1;
    const t = this.now();
    if (t - this.lastRejectWarnMs[kind] < REJECT_WARN_INTERVAL_MS) return;
    this.lastRejectWarnMs[kind] = t;
    console.warn(
      `head: rejected ${kind} (${this.rejected[kind]} so far; warning at most every ` +
      `${REJECT_WARN_INTERVAL_MS / 1000}s): ${why}`,
    );
  }

  getAxisConfig(): AxisConfig | null {
    return this.axisConfig ? cloneAxisConfig(this.axisConfig) : null;
  }

  // Registers a listener fired once per successfully parsed telemetry tick
  // that carries `axes`, with a snapshot of the state as of that tick. A
  // listener must never throw here for the same reason TrackingSession.
  // setState()'s listeners don't: one caller's bug must not stop telemetry
  // processing for every other consumer (or, worse, break the WS message
  // handler itself). The same isolation applies to every listener below.
  onTelemetry(cb: (s: DeviceState) => void): void { this.telemetryListeners.push(cb); }

  /** Every head event, as parsed against the event schema. */
  onEvent(cb: (e: HeadEvent) => void): void { this.eventListeners.push(cb); }

  /** `pan_reference` events: the pan frame was renamed (or dropped: source "none"). */
  onReferenceChanged(cb: (c: ReferenceChange) => void): void { this.referenceListeners.push(cb); }

  /** After each successful `GET /api/config` (on connect and on every `config` event). */
  onConfig(cb: (c: AxisConfig) => void): void { this.configListeners.push(cb); }

  private snapshot(): DeviceState {
    const s = this.state;
    return {
      ...s,
      ref: { ...s.ref },
      link: { ...s.link },
      ...(s.imu ? { imu: { ...s.imu } } : {}),
    };
  }

  // --- telemetry -------------------------------------------------------------

  private connect(): void {
    if (this.closed) return;
    const ws = this.wsFactory(this.wsUrl);
    this.ws = ws;
    ws.on("open", () => {
      this.state.connected = true;
      void this.refreshConfig();
    });
    ws.on("message", (buf) => this.onMessage(buf.toString()));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.state.connected = false;
      this.scheduleReconnect();
    });
    ws.on("error", () => { /* close will follow */ });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  private onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      // Unparseable, so the type is a guess from the raw text; ticks are the 10 Hz traffic.
      const kind: RejectKind = /"type"\s*:\s*"event"/.test(raw) ? "event" : "tick";
      this.reject(kind, `JSON parse error: ${(e as Error).message}`);
      return;
    }
    const type = (msg as { type?: unknown } | null)?.type;
    if (type === "tick") {
      const r = HeadTickZ.safeParse(msg);
      if (r.success) this.onTick(r.data);
      else this.reject("tick", zodWhy(r.error));
    } else if (type === "event") {
      const r = HeadEventZ.safeParse(msg);
      if (r.success) this.onHeadEvent(r.data);
      else this.reject("event", `name ${JSON.stringify((msg as { name?: unknown }).name)}: ${zodWhy(r.error)}`);
    } else {
      this.reject("event", `unknown message type ${JSON.stringify(type)}`);
    }
  }

  private onTick(t: HeadTick): void {
    const s = this.state;
    s.estop = t.estop;
    s.imu = { ...t.imu, cal: t.imu.cal ? { ...t.imu.cal } : null };
    s.tiltDisagreeDeg = t.tiltDisagreeDeg;
    s.ref = { ...t.ref };
    s.link = { ...t.link };
    if (!t.axes) return; // IMU-only tick: no motion telemetry (see DeviceState)
    s.axes = {
      pan: { ...t.axes.pan }, tilt: { ...t.axes.tilt },
      zoom: { ...t.axes.zoom }, focus: { ...t.axes.focus },
    };
    s.panDeg = t.axes.pan.pos;
    s.tiltDeg = t.axes.tilt.pos;
    s.zoomDeg = t.axes.zoom.pos;
    s.focusDeg = t.axes.focus.pos;
    s.moving = t.moving ?? Object.values(t.axes).some((a) => a.vel !== 0 || a.mode === "H");
    s.enabled = t.enabled ?? s.enabled;
    s.lastUpdateMs = this.now();
    if (this.telemetryListeners.length > 0) {
      const snap = this.snapshot();
      for (const cb of this.telemetryListeners) {
        try { cb(snap); } catch { /* a listener must never break telemetry processing */ }
      }
    }
  }

  private onHeadEvent(e: HeadEvent): void {
    // The tick that follows carries the same facts; applying them now saves
    // the gate up to a tick period.
    if (e.name === "estop") this.state.estop = true;
    else if (e.name === "estop_cleared") this.state.estop = false;
    else if (e.name === "pico_link") {
      this.state.link.pico = (e.detail as { up: boolean }).up;
      // GET /api/config is a Pico round trip: it 503s while the link is down
      // (e.g. at connect), and a Pico that rebooted may come back with other
      // limits. Re-read whenever the link comes up.
      if (this.state.link.pico) void this.refreshConfig();
    } else if (e.name === "config") void this.refreshConfig();

    for (const cb of this.eventListeners) {
      try { cb(e); } catch { /* isolated, see onTelemetry */ }
    }
    if (e.name === "pan_reference") {
      const d = PanReferenceDetailZ.parse(e.detail);
      const change: ReferenceChange = "pan" in d
        ? { source: d.source, pan: d.pan, previous: d.previous }
        : { source: d.source, pan: null, previous: null };
      for (const cb of this.referenceListeners) {
        try { cb({ ...change }); } catch { /* isolated, see onTelemetry */ }
      }
    }
  }

  // Fetches the Pico limits and rates. Overlapping fetches (a burst of config
  // events) resolve in any order; only the newest one is applied. Until one
  // has succeeded, a failure is retried every CONFIG_RETRY_MS while the socket
  // is up: the limit guard falls back to a constant without it.
  private async refreshConfig(): Promise<void> {
    const gen = ++this.configGeneration;
    let raw: unknown;
    try {
      raw = await this.request("GET", "/api/config");
    } catch {
      if (!this.closed && gen === this.configGeneration) this.scheduleConfigRetry();
      return; // unreachable, or the Pico link is down (503)
    }
    if (this.closed || gen !== this.configGeneration) return;
    const parsed = HeadAxisConfigResponseZ.safeParse(raw);
    if (!parsed.success) {
      this.reject("config", zodWhy(parsed.error));
      this.scheduleConfigRetry();
      return;
    }
    const pick = (a: HeadAxisConfig): HeadAxisConfig => ({ min: a.min, max: a.max, vmax: a.vmax, amax: a.amax });
    const config: AxisConfig = { pan: pick(parsed.data.pan), tilt: pick(parsed.data.tilt) };
    this.axisConfig = config;
    for (const cb of this.configListeners) {
      try { cb(cloneAxisConfig(config)); } catch { /* isolated, see onTelemetry */ }
    }
  }

  private scheduleConfigRetry(): void {
    if (this.closed || this.configRetryTimer || this.axisConfig !== null) return;
    this.configRetryTimer = setTimeout(() => {
      this.configRetryTimer = null;
      if (!this.closed && this.state.connected && this.axisConfig === null) void this.refreshConfig();
    }, CONFIG_RETRY_MS);
  }

  // --- HTTP ------------------------------------------------------------------

  private async request(
    method: "GET" | "POST", path: string, body?: object, timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<unknown> {
    const r = await this.fetchFn(`${this.httpBase}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) {
      const err = (json as { error?: unknown } | null)?.error;
      throw new DeviceHttpError(typeof err === "string" ? err : `HTTP ${r.status}`, r.status);
    }
    return json;
  }

  private async post(path: string, body?: object): Promise<void> {
    await this.request("POST", path, body);
  }

  // --- motion ----------------------------------------------------------------

  // Queues a motion POST behind every earlier one (see motionQueue). Resolves
  // when the head has answered it, or at once if a newer command superseded
  // it before it was sent; rejects with the head's error.
  private enqueueMotion(kind: MotionKind, path: string, body?: object): Promise<void> {
    if (this.closed) return Promise.reject(new Error("device closed"));
    return new Promise<void>((resolve, reject) => {
      const axes = kind === "track" && body ? Object.keys(body) : [];
      const cmd: MotionCommand = { kind, path, body, axes, resolve, reject };
      const dropped = this.motionQueue.filter((q) => supersedes(cmd, q));
      this.motionQueue = [...this.motionQueue.filter((q) => !supersedes(cmd, q)), cmd];
      for (const d of dropped) d.resolve();
      void this.drainMotion();
    });
  }

  private async drainMotion(): Promise<void> {
    if (this.motionDraining) return;
    this.motionDraining = true;
    try {
      while (this.motionQueue.length > 0 && !this.closed) {
        const [cmd, ...rest] = this.motionQueue;
        this.motionQueue = rest;
        try {
          await this.post(cmd.path, cmd.body);
          cmd.resolve();
        } catch (e) {
          cmd.reject(e);
        }
      }
    } finally {
      this.motionDraining = false;
    }
  }

  /** `POST /api/goto` (202). The head moves at the Pico's `vmax`; `speedDps` is accepted for callers and ignored. */
  async gotoAngle(devicePanDeg: number, deviceTiltDeg: number, _speedDps?: number): Promise<void> {
    await this.enqueueMotion("goto", "/api/goto", { pan: devicePanDeg, tilt: deviceTiltDeg });
  }

  /** `POST /api/track`: position-now plus rate; the Pico extrapolates and servos. */
  async track(cmd: HeadTrackCmd): Promise<void> {
    await this.enqueueMotion("track", "/api/track", cmd);
  }

  // `signal` lets a caller that has given up on this arrival (the goto was
  // superseded: a tracking session retargeted the head, a park was aborted)
  // end the wait now instead of polling out the whole timeout. It rejects.
  async waitForArrival(
    targetPanDeg: number, targetTiltDeg: number, timeoutMs: number, signal?: AbortSignal,
  ): Promise<DeviceState> {
    const t0 = this.now();
    const abandoned = (): void => {
      if (signal?.aborted) throw new Error("arrival wait abandoned: the goto was superseded");
    };
    // allow the head a moment to report moving before we test for arrival
    await new Promise((res) => setTimeout(res, 150));
    while (this.now() - t0 < timeoutMs) {
      abandoned();
      const s = this.state;
      if (!s.moving &&
          Math.abs(s.panDeg - targetPanDeg) < ARRIVAL_TOL_DEG &&
          Math.abs(s.tiltDeg - targetTiltDeg) < ARRIVAL_TOL_DEG) {
        return this.snapshot();
      }
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(
      `goto timed out after ${timeoutMs}ms at pan=${this.state.panDeg.toFixed(2)}° ` +
      `tilt=${this.state.tiltDeg.toFixed(2)}°`,
    );
  }

  /** `POST /api/stop`: the named axes, or all of them. Not guarded by the E-STOP latch. */
  async stop(axes?: readonly HeadAxisName[]): Promise<void> {
    await this.enqueueMotion("stop", "/api/stop", axes && axes.length > 0 ? { axes: [...axes] } : undefined);
  }

  /**
   * `POST /api/estop`: latches the head; every motion route returns 423 until
   * cleared. Deliberately NOT queued behind the motion FIFO: an E-STOP must
   * never wait for a slow goto to be answered.
   */
  async estop(): Promise<void> {
    // Nothing would accept the keep-alive's frames now: stop pumping them, drop
    // any queued frame, and end an in-progress jog() (it rejects).
    this.abortJog();
    // Every motion command still queued was issued BEFORE the E-STOP and must
    // never run after it: left queued, it would go out once the latch is
    // cleared (clearEstop() is not queued either) and the head would accept
    // it. Refused here, before the latch is even posted.
    const discarded = this.motionQueue;
    this.motionQueue = [];
    for (const d of discarded) d.reject(new Error(`E-STOP: queued ${d.kind} discarded, not sent`));
    await this.post("/api/estop");
  }

  // Not queued: clearing the latch is not motion, and must not wait behind it.
  async clearEstop(): Promise<void> {
    await this.post("/api/estop/clear");
  }

  /** `POST /api/home` (202). Completion arrives as a `homed`/`home_failed` event. */
  async home(axes?: string[]): Promise<void> {
    await this.enqueueMotion("home", "/api/home", axes ? { axes } : undefined);
  }

  /** `POST /api/setpos`: declares the current position. A pan value re-references pan (`pan_reference` event). */
  // Queued with the motion commands: it renames the frame every queued goto
  // and TRACK is expressed in, so it must land exactly where it was called.
  async setPos(pos: { pan?: number; tilt?: number }): Promise<void> {
    await this.enqueueMotion("setpos", "/api/setpos", pos);
  }

  /** `POST /api/reference` (202): re-runs the IMU north reference; the result arrives as an event. */
  async reference(): Promise<void> {
    await this.post("/api/reference");
  }

  // Normalized gravity direction in the IMU frame: the mean of the burst's
  // `gravity` vectors (the BNO055's fused gravity estimate, m/s²). Only the
  // direction matters to the gravity-anchoring callers (characterize_imu,
  // set_north_zero, solve_calibration), as with the old raw-accel burst.
  async getGravity(n = 100): Promise<Vec3> {
    if (this.state.imu?.ok === false) throw new Error("IMU not ok (the head reports imu.ok === false)");
    const raw = await this.request("GET", `/api/imu?n=${n}`, undefined, IMU_TIMEOUT_MS);
    const burst = HeadImuBurstZ.parse(raw);
    if (burst.samples.length === 0) throw new Error("GET /api/imu returned no samples");
    const sum = burst.samples.reduce<[number, number, number]>(
      (acc, s) => [acc[0] + s.gravity[0], acc[1] + s.gravity[1], acc[2] + s.gravity[2]], [0, 0, 0]);
    const k = burst.samples.length;
    const mean: Vec3 = [sum[0] / k, sum[1] / k, sum[2] / k];
    if (!mean.every(Number.isFinite) || Math.hypot(...mean) === 0) {
      throw new Error("GET /api/imu: degenerate mean gravity");
    }
    return normalize(mean);
  }

  // --- jog -------------------------------------------------------------------

  // Stops the keep-alive without sending a frame (the head's own dead-man,
  // or the E-STOP, stops the axis), drops any jog frame still queued, and ends
  // any jog() loop in progress.
  private abortJog(): void {
    this.jogEpoch += 1;
    this.jogVec = null;
    const dropped = this.motionQueue.filter((q) => q.kind === "jog");
    this.motionQueue = this.motionQueue.filter((q) => q.kind !== "jog");
    for (const d of dropped) d.resolve();
    this.stopJogTimer();
  }

  // Jog frames ride the motion FIFO like every other motion command; while
  // one is queued unsent, a newer frame replaces it (a stop is always the
  // latest frame after a clear).
  private sendJog(pan: number, tilt: number): void {
    if (this.closed) return;
    this.lastJogFrame = this.enqueueMotion("jog", "/api/jog", { pan, tilt })
      .catch((e: unknown) => { this.jogError ??= e; }); // first failure wins: it names the cause
  }

  private stopJogTimer(): void {
    if (this.jogTimer) { clearInterval(this.jogTimer); this.jogTimer = null; }
  }

  // The keep-alive. A vector older than its TTL means whoever set it stopped
  // proving it was alive — drop it and zero the head rather than keep slewing.
  // The head's own jog dead-man (500ms) is the second net, for when this
  // process dies or the network does.
  private pumpJog(): void {
    const v = this.jogVec;
    if (!v) { this.stopJogTimer(); return; }
    if (this.now() >= v.expiresAtMs) {
      this.jogVec = null;
      this.sendJog(0, 0);
      this.stopJogTimer();
      return;
    }
    this.sendJog(v.panDps, v.tiltDps);
  }

  // Set a sticky rate (deg/s, device frame) that is repeated to the head until
  // it expires. The caller MUST keep refreshing it; see pumpJog. `ttlMs` must
  // be comfortably greater than JOG_KEEPALIVE_MS (100ms): a TTL at or below
  // the keep-alive interval expires on the very first watchdog tick regardless
  // of how fresh the vector actually is -- it fails safe (stops early), but it
  // will silently defeat the caller's intent.
  //
  // The keep-alive interval is the ONLY sender: this call never posts a frame
  // itself except to kick off the very first frame when the timer is not
  // already running. Subsequent calls (refreshing the vector/TTL while the
  // timer is alive) just update state -- pumpJog's own tick sends it. This
  // keeps exactly one frame per JOG_KEEPALIVE_MS tick even when a caller
  // (jog()'s loop, or a tracking session) invokes this at roughly the
  // keep-alive rate; sending here too would double it.
  setJogVector(panDps: number, tiltDps: number, ttlMs: number): void {
    if (this.jogLocked || this.closed) return;
    this.jogVec = { panDps, tiltDps, expiresAtMs: this.now() + ttlMs };
    if (!this.jogTimer) {
      this.pumpJog();
      this.jogTimer = setInterval(() => this.pumpJog(), JOG_KEEPALIVE_MS);
    }
  }

  // Sends the zero frame only when a vector was live: a caller that clears
  // defensively (lockJog, a jog()'s end after the TTL already zeroed it) must
  // not spray stop frames at a head nobody was jogging.
  clearJog(): void {
    const live = this.jogVec !== null;
    this.jogVec = null;
    this.stopJogTimer();
    if (live) this.sendJog(0, 0);
  }

  // Driven by SunSupervisor's lock state (see setLocked). While latched, any
  // in-flight jog() keep-alive loop that re-calls setJogVector to refresh its
  // vector becomes a no-op, so the guard's clearJog() below cannot be undone
  // by a manual jog that was already running when the lock engaged.
  lockJog(): void {
    this.jogLocked = true;
    this.clearJog();
  }

  unlockJog(): void {
    this.jogLocked = false;
  }

  // Timed jog (the manual `jog` tool), built on the same vector so there is
  // exactly one keep-alive owner. Deliberately reads no clock: the loop is
  // bounded by tick count, so a test may freeze the injected clock without
  // hanging here. Cadence is governed by JOG_KEEPALIVE_MS, the same interval
  // the watchdog runs on, and every refreshed vector still carries a real
  // this.now()-policed TTL — so even a stuck jog is not exempt from expiry.
  // Resolves once the zero frame has been answered; rejects with the first
  // frame the head refused (423 E-STOP, 503 link down), after stopping.
  // close() ends the loop quietly (nothing more is sent); estop() ends it
  // with a rejection, so the caller does not report a jog that was cut short.
  async jog(panDps: number, tiltDps: number, durationMs: number): Promise<void> {
    if (this.closed) return;
    this.jogError = null;
    const epoch = this.jogEpoch;
    const aborted = (): boolean => {
      if (epoch === this.jogEpoch) return false;
      if (this.closed) return true;
      throw new Error("jog aborted: E-STOP latched");
    };
    const ticks = Math.ceil(durationMs / JOG_KEEPALIVE_MS);
    this.setJogVector(panDps, tiltDps, JOG_KEEPALIVE_MS * 5);
    for (let i = 0; i < ticks; i++) {
      await new Promise((res) => setTimeout(res, JOG_KEEPALIVE_MS));
      if (aborted()) return;
      this.setJogVector(panDps, tiltDps, JOG_KEEPALIVE_MS * 5);
    }
    this.clearJog();
    // Wait for the newest jog frame (normally the zero) to be answered.
    for (let frame = this.lastJogFrame; frame !== null; frame = this.lastJogFrame) {
      await frame;
      if (frame === this.lastJogFrame) break;
    }
    const err = this.jogError;
    this.jogError = null;
    if (err) throw err;
  }

  // --- removed ESP32 features --------------------------------------------------

  /** @deprecated TRANSITIONAL — removed in Task 6 with the list_programs/select_program tools (the head has no programs) */
  async listPrograms(): Promise<{ current: number; names: string[]; selectable: boolean }> {
    throw new Error("removed: the head has no programs");
  }

  /** @deprecated TRANSITIONAL — removed in Task 6 with the list_programs/select_program tools (the head has no programs) */
  async selectProgram(_index: number, _commit: boolean): Promise<void> {
    throw new Error("removed: the head has no programs");
  }

  /** @deprecated TRANSITIONAL — removed in Task 6 with the trigger_camera tool (the head has no camera trigger) */
  async triggerCamera(_action: "shoot" | "focus", _ms: number): Promise<void> {
    throw new Error("removed: the head has no camera trigger");
  }

  /** @deprecated TRANSITIONAL — removed in Task 6 with the set_home tool (use setPos({pan}) / home()) */
  async setHome(): Promise<void> {
    throw new Error("removed: use setPos({ pan }) or home()");
  }
}

function zodWhy(err: ZodError): string {
  return err.issues.slice(0, 3)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

function cloneAxisConfig(c: AxisConfig): AxisConfig {
  return { pan: { ...c.pan }, tilt: { ...c.tilt } };
}
