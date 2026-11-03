// FakeHead: an in-process stand-in for the plainsight head (docs/HEAD-API.md),
// replacing the ESP32 MockTb3. A real express + ws server on an ephemeral
// localhost port, so the Device client under test goes through real HTTP and
// a real WebSocket.
//
// It is held to the head's contract, not just to what the Device happens to
// send: every outgoing tick and event is validated against the JSON Schemas
// in docs/head-api/schemas (a test that makes it publish something the real
// head never would fails loudly), and every request body is validated against
// the request schemas (a Device that sends a body the head would 400 gets the
// 400 here too). The status-code rules follow the head: 202 for goto, home and
// reference, 200 otherwise; 423 while the E-STOP latch is set, checked before
// 503 while the Pico link is down; 409 for setpos on a moving axis or while a
// reference run is busy; 503 from GET /api/imu while the IMU is not ok.
//
// Motion is a simple simulation (constant-speed goto, integrated jog rate,
// and a TRACK servo: the setpoint is extrapolated at the commanded rate and the
// axis is pulled onto it, stopping on the Pico's track timeout), stepped by
// the auto-tick timer or by advance(); the model is public and mutable so a
// test can put the head in any state and publish it with tick().
import { createServer, Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { NextFunction, Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import Ajv2020Module from "ajv/dist/2020.js";
import {
  HEAD_AXES, HeadAxis, HeadAxisName, HeadEvent, HeadImu, HeadLink, HeadRef, HeadTrackCmd,
} from "../src/shared/head-types.js";

export const HEAD_API_DOC = fileURLToPath(new URL("../../docs/HEAD-API.md", import.meta.url));
const SCHEMA_DIR = fileURLToPath(new URL("../../docs/head-api/schemas/", import.meta.url));
const SCHEMA_NAMES = ["tick", "event", "goto", "track", "jog", "setpos", "config-set", "imu-burst"] as const;

const G = 9.80665;
const SIM_DPS = 90; // simulated goto/home speed, fast for tests
// TRACK servo: feed-forward at the commanded rate plus this much catch-up per
// degree of error (1/s), capped at SIM_DPS. A first-order stand-in for the
// Pico's servo, so a host that sends a wrong rate or setpoint shows a
// following error instead of teleporting onto the target.
const TRACK_GAIN_PER_S = 5;
const IMU_BURST_MAX = 1000;

type Validate = (schema: string, data: unknown) => string[];
let cachedValidator: Validate | null = null;

/** Validates `data` against docs/head-api/schemas/<schema>.json; returns the error messages (empty = valid). */
export function headSchemaValidator(): Validate {
  if (cachedValidator) return cachedValidator;
  // ajv ships CommonJS; under NodeNext the default import is the module object,
  // whose `default` is the class.
  const Ajv2020 = Ajv2020Module.default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const name of SCHEMA_NAMES) {
    compiled.set(name, ajv.compile(JSON.parse(readFileSync(`${SCHEMA_DIR}${name}.json`, "utf8"))));
  }
  cachedValidator = (schema, data) => {
    const v = compiled.get(schema);
    if (!v) return [`no schema named ${schema}`];
    return v(data) ? [] : (v.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  };
  return cachedValidator;
}

export interface FakeHeadModel {
  axes: Record<HeadAxisName, HeadAxis>;
  enabled: boolean;
  estop: boolean;
  imu: HeadImu;
  ref: HeadRef;
  link: HeadLink;
  /** Published only while both links are up (null otherwise, as the head does). */
  tiltDisagreeDeg: number | null;
  /** A reference run in progress: setpos and reference answer 409. */
  referenceBusy: boolean;
}

export interface FakeHeadCall {
  method: string;
  path: string;
  query: Record<string, string>;
  /** The parsed JSON body, or undefined when the request had none. */
  body: unknown;
}

function axis(pos: number, homed: boolean): HeadAxis {
  return { pos, vel: 0, tgt: pos, mode: "I", homed, endstop: false, driver: true };
}

const okImu = (): HeadImu => ({
  ok: true, heading: 0, pitch: 0, roll: 0, cal: { sys: 3, gyr: 3, acc: 3, mag: 3 }, tempC: 25,
});

function defaultModel(): FakeHeadModel {
  return {
    axes: { pan: axis(0, true), tilt: axis(0, true), zoom: axis(0, false), focus: axis(0, false) },
    enabled: true,
    estop: false,
    imu: okImu(),
    ref: { pan: "imu", persisted: true, ageS: 0 },
    link: { pico: true, imu: true },
    tiltDisagreeDeg: 0,
    referenceBusy: false,
  };
}

// Pico CFG scopes. Values mirror the Pico's current defaults (vmax 5, amax 10).
function defaultConfig(): Record<string, Record<string, number>> {
  const ax = (min: number, max: number) => ({ min, max, vmax: 5, amax: 10, home_dir: 0 });
  return {
    pan: ax(-180, 180),
    tilt: { ...ax(0, 90), home_dir: -1 },
    zoom: ax(0, 360),
    focus: ax(0, 360),
    global: { track_timeout_ms: 1000, host_baud: 115200 },
  };
}

export class FakeHead {
  model: FakeHeadModel = defaultModel();
  config = defaultConfig();
  calls: FakeHeadCall[] = [];
  lastGoto: Partial<Record<HeadAxisName, number>> | null = null;
  lastTrack: HeadTrackCmd | null = null;
  lastJog: Partial<Record<HeadAxisName, number>> | null = null;
  stopCount = 0;
  homeCount = 0;
  /** Count of ACCEPTED goto calls (a 423/503/400 does not increment it). */
  gotoCount = 0;
  /** Delay every HTTP response by this much (a slow head). */
  responseDelayMs = 0;
  private failures = new Map<string, { status: number; times: number }>();

  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private port = 0;
  private savedImu: HeadImu = okImu();
  /** Simulated ms since the last TRACK, per axis (the Pico's track timeout). */
  private trackAgeMs: Partial<Record<"pan" | "tilt", number>> = {};
  private readonly validate = headSchemaValidator();

  get url(): string { return `http://127.0.0.1:${this.port}`; }

  get imuOk(): boolean { return this.model.imu.ok; }
  /** false: the IMU link drops (imu fields null, GET /api/imu 503); true restores the last readings. */
  set imuOk(ok: boolean) {
    if (ok === this.model.imu.ok) return;
    if (!ok) {
      this.savedImu = { ...this.model.imu };
      this.model.imu = { ok: false, heading: null, pitch: null, roll: null, cal: null, tempC: null };
    } else {
      this.model.imu = { ...this.savedImu, ok: true };
    }
    this.model.link.imu = ok;
  }

  /** Place pan/tilt at rest (degrees, device frame). */
  setPosition(panDeg: number, tiltDeg: number): void {
    for (const [name, pos] of [["pan", panDeg], ["tilt", tiltDeg]] as const) {
      const a = this.model.axes[name];
      this.model.axes[name] = { ...a, pos, tgt: pos, vel: 0, mode: "I" };
    }
  }

  /** The gravity vector (m/s², IMU frame) the fake reports for a pitch/roll (degrees). */
  static gravityFor(pitchDeg: number, rollDeg: number): [number, number, number] {
    const p = (pitchDeg * Math.PI) / 180;
    const r = (rollDeg * Math.PI) / 180;
    return [-G * Math.sin(p), G * Math.sin(r) * Math.cos(p), G * Math.cos(r) * Math.cos(p)];
  }

  /**
   * Starts the server. `tickMs` (default 50) steps the motion simulation and
   * publishes a tick on that period; 0 disables it (publish with tick()).
   * Resolves with the bound port (ephemeral unless `port` is given).
   */
  async start(opts: { port?: number; tickMs?: number } = {}): Promise<number> {
    const app = express();
    app.use(express.json({ limit: "64kb" }));
    app.use((req, res, next) => {
      const hasBody = (req.headers["content-type"] ?? "").includes("json") && req.headers["content-length"] !== "0";
      this.calls.push({
        method: req.method, path: req.path,
        query: Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)])),
        body: hasBody ? req.body : undefined,
      });
      const fail = this.failures.get(req.path);
      if (fail && fail.times > 0) {
        fail.times -= 1;
        res.status(fail.status).json({ ok: false, error: `injected failure ${fail.status}` });
        return;
      }
      if (this.responseDelayMs > 0) setTimeout(next, this.responseDelayMs); else next();
    });
    this.routes(app);
    app.use((_req, res) => { res.status(404).json({ ok: false, error: "not found" }); });
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(400).json({ ok: false, error: `invalid JSON: ${err.message}` });
    });

    this.http = createServer(app);
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (ws) => ws.send(JSON.stringify(this.buildTick(this.model.link.pico, false))));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      // ws re-emits the http server's 'error' on the WebSocketServer; with no
      // listener there it would throw instead of rejecting.
      this.wss!.once("error", onError);
      this.http!.once("error", onError);
      this.http!.listen(opts.port ?? 0, "127.0.0.1", () => {
        this.http!.removeListener("error", onError);
        this.wss!.removeListener("error", onError);
        resolve();
      });
    });
    const addr = this.http.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    const tickMs = opts.tickMs ?? 50;
    if (tickMs > 0) {
      this.tickTimer = setInterval(() => { this.advance(tickMs); this.tick(); }, tickMs);
    }
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.wss?.clients.forEach((c) => c.terminate());
    if (this.wss) await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
    if (this.http) {
      this.http.closeAllConnections();
      await new Promise<void>((resolve) => this.http!.close(() => resolve()));
    }
    this.wss = null;
    this.http = null;
  }

  /** The next `times` requests to `path` answer `status` with the error envelope (logged in `calls` first). */
  failNext(path: string, status: number, times = 1): void {
    this.failures.set(path, { status, times });
  }

  /** The tick the model would publish now (seq not advanced), for building variants. */
  currentTick(): Record<string, unknown> {
    return this.buildTick(this.model.link.pico, false);
  }

  /**
   * Sends a raw text frame to every client, bypassing schema validation: for
   * tests of how the client handles a head that breaks its contract.
   */
  sendRaw(frame: string): void {
    this.wss?.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(frame); });
  }

  /** Terminates every WebSocket client (the server keeps listening). */
  dropClients(): void {
    this.wss?.clients.forEach((c) => c.terminate());
  }

  /** Publishes one tick from the model (without `axes` while `link.pico` is false). */
  tick(): void {
    this.broadcast(this.buildTick(this.model.link.pico, true));
  }

  /** Publishes one IMU-only tick, as the head does at 2 Hz while the Pico link is down. */
  tickNoAxes(): void {
    this.broadcast(this.buildTick(false, true));
  }

  /** Publishes an event. Throws if it does not match docs/head-api/schemas/event.json. */
  emitEvent(e: HeadEvent): void {
    this.broadcast(e);
  }

  /** Writes Pico config values and publishes one `config` event per key, like POST /api/config. */
  setConfig(scope: string, patch: Record<string, number>): void {
    this.config[scope] = { ...(this.config[scope] ?? {}), ...patch };
    for (const [key, value] of Object.entries(patch)) this.event("config", null, { scope, key, value });
  }

  /** Steps the motion simulation by `ms`. */
  advance(ms: number): void {
    const dt = ms / 1000;
    for (const name of HEAD_AXES) {
      const a = this.model.axes[name];
      if (a.mode === "P") {
        const d = a.tgt - a.pos;
        const step = SIM_DPS * dt;
        if (Math.abs(d) <= step) this.model.axes[name] = { ...a, pos: a.tgt, vel: 0, mode: "I" };
        else this.model.axes[name] = { ...a, pos: a.pos + Math.sign(d) * step, vel: Math.sign(d) * SIM_DPS };
      } else if (a.mode === "V") {
        this.model.axes[name] = { ...a, pos: a.pos + a.vel * dt };
      } else if (a.mode === "T" && (name === "pan" || name === "tilt")) {
        this.advanceTrack(name, ms);
      }
    }
  }

  // The Pico extrapolates the TRACK setpoint at the commanded rate and servos
  // the axis onto it; with no TRACK for track_timeout_ms it stops the axis and
  // says so.
  private advanceTrack(name: "pan" | "tilt", ms: number): void {
    const a = this.model.axes[name];
    const age = (this.trackAgeMs[name] ?? 0) + ms;
    this.trackAgeMs[name] = age;
    if (age > (this.config.global?.track_timeout_ms ?? 1000)) {
      this.model.axes[name] = { ...a, vel: 0, tgt: a.pos, mode: "I" };
      this.event("track_timeout", name, null);
      return;
    }
    const dt = ms / 1000;
    const rate = Math.max(-SIM_DPS, Math.min(SIM_DPS, a.vel + TRACK_GAIN_PER_S * (a.tgt - a.pos)));
    this.model.axes[name] = { ...a, pos: a.pos + rate * dt, tgt: a.tgt + a.vel * dt };
  }

  // --- wire --------------------------------------------------------------------

  private buildTick(withAxes: boolean, advanceSeq: boolean): Record<string, unknown> {
    const m = this.model;
    if (advanceSeq) this.seq += 1;
    const tick: Record<string, unknown> = { type: "tick", t: Date.now(), seq: this.seq };
    if (withAxes) {
      tick.axes = Object.fromEntries(HEAD_AXES.map((n) => [n, { ...m.axes[n] }]));
      tick.enabled = m.enabled;
      tick.moving = this.moving();
    }
    tick.estop = m.estop;
    tick.imu = { ...m.imu, cal: m.imu.cal ? { ...m.imu.cal } : null };
    tick.tiltDisagreeDeg = m.link.pico && m.link.imu ? m.tiltDisagreeDeg : null;
    tick.ref = { ...m.ref };
    tick.link = { ...m.link };
    this.assertValid("tick", tick);
    return tick;
  }

  private moving(): boolean {
    return HEAD_AXES.some((n) => this.model.axes[n].vel !== 0 || this.model.axes[n].mode === "H");
  }

  private event(name: string, axisName: string | null, detail: unknown): void {
    this.broadcast({ type: "event", t: Date.now(), name, axis: axisName, detail });
  }

  private broadcast(msg: object): void {
    this.assertValid((msg as { type: string }).type, msg);
    const s = JSON.stringify(msg);
    this.wss?.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(s); });
  }

  private assertValid(schema: string, msg: unknown): void {
    const errors = this.validate(schema, msg);
    if (errors.length > 0) {
      throw new Error(`FakeHead: outgoing ${schema} violates the ${schema}.json schema: ${errors.join("; ")}: ${JSON.stringify(msg)}`);
    }
  }

  // --- routes ------------------------------------------------------------------

  private routes(app: express.Express): void {
    const fail = (res: Response, status: number, error: string) => { res.status(status).json({ ok: false, error }); };
    const ok = (res: Response, status = 200) => { res.status(status).json({ ok: true }); };
    // 423 before 503, as the head checks the latch first.
    const guard = (res: Response): boolean => {
      if (this.model.estop) { fail(res, 423, "estop latched; POST /api/estop/clear"); return false; }
      if (!this.model.link.pico) { fail(res, 503, "pico link down"); return false; }
      return true;
    };
    const body = (req: Request, res: Response, schema: string): Record<string, unknown> | null => {
      const errors = this.validate(schema, req.body);
      if (errors.length > 0) { fail(res, 400, errors.join("; ")); return null; }
      return req.body as Record<string, unknown>;
    };
    const axisList = (req: Request): HeadAxisName[] | null => {
      const axes = (req.body as { axes?: unknown } | undefined)?.axes;
      if (axes === undefined) return [];
      if (!Array.isArray(axes) || !axes.every((a) => (HEAD_AXES as readonly unknown[]).includes(a))) return null;
      return [...new Set(axes as HeadAxisName[])];
    };

    app.get("/api/state", (_req, res) => { res.json(this.buildTick(this.model.link.pico, false)); });
    app.get("/healthz", (_req, res) => {
      res.json({ ok: true, pico: this.model.link.pico, imu: this.model.link.imu, estop: this.model.estop });
    });

    app.get("/api/config", (_req, res) => {
      if (!this.model.link.pico) return fail(res, 503, "pico link down");
      res.json({ ...structuredClone(this.config), head: { port: this.port } });
    });

    app.post("/api/config", (req, res) => {
      const b = body(req, res, "config-set");
      if (!b) return;
      const scope = String(b.scope), key = String(b.key);
      const guarded = ["socket", "host_baud"].includes(key.toLowerCase()) || scope.toLowerCase() === "global";
      if (guarded && req.query.force !== "1") return fail(res, 403, "guarded setting; add ?force=1");
      if (!guard(res)) return;
      this.setConfig(scope, { [key]: Number(b.value) });
      ok(res);
    });

    app.post("/api/goto", (req, res) => {
      if (!guard(res)) return;
      const b = body(req, res, "goto");
      if (!b) return;
      this.lastGoto = { ...b } as Partial<Record<HeadAxisName, number>>;
      this.gotoCount += 1;
      for (const [name, tgt] of Object.entries(this.lastGoto) as [HeadAxisName, number][]) {
        const a = this.model.axes[name];
        const d = tgt - a.pos;
        this.model.axes[name] = d === 0
          ? { ...a, tgt, vel: 0, mode: "I" }
          : { ...a, tgt, vel: Math.sign(d) * SIM_DPS, mode: "P" };
      }
      ok(res, 202);
    });

    app.post("/api/track", (req, res) => {
      if (!guard(res)) return;
      const b = body(req, res, "track");
      if (!b) return;
      this.lastTrack = structuredClone(b) as HeadTrackCmd;
      for (const name of ["pan", "tilt"] as const) {
        const cmd = this.lastTrack[name];
        if (!cmd) continue;
        this.model.axes[name] = { ...this.model.axes[name], tgt: cmd.pos, vel: cmd.vel, mode: "T" };
        this.trackAgeMs[name] = 0;
      }
      ok(res);
    });

    app.post("/api/jog", (req, res) => {
      if (!guard(res)) return;
      const b = body(req, res, "jog");
      if (!b) return;
      this.lastJog = { ...b } as Partial<Record<HeadAxisName, number>>;
      for (const [name, rate] of Object.entries(this.lastJog) as [HeadAxisName, number][]) {
        const a = this.model.axes[name];
        this.model.axes[name] = { ...a, vel: rate, tgt: a.pos, mode: rate === 0 ? "I" : "V" };
      }
      ok(res);
    });

    app.post("/api/stop", (req, res) => {
      const axes = axisList(req);
      if (axes === null) return fail(res, 400, "axes: unknown axis");
      if (!this.model.link.pico) return fail(res, 503, "pico link down");
      this.stopAxes(axes.length > 0 ? axes : [...HEAD_AXES]);
      this.stopCount += 1;
      ok(res);
    });

    app.post("/api/estop", (_req, res) => {
      this.model.estop = true;
      this.event("estop", null, null);
      if (!this.model.link.pico) return fail(res, 503, "pico link down");
      this.stopAxes([...HEAD_AXES]);
      ok(res);
    });

    app.post("/api/estop/clear", (_req, res) => {
      this.model.estop = false;
      this.event("estop_cleared", null, null);
      ok(res);
    });

    app.post("/api/enable", (req, res) => {
      const on = (req.body as { on?: unknown } | undefined)?.on;
      if (typeof on !== "boolean") return fail(res, 400, "on: expected true or false");
      if (!this.model.link.pico) return fail(res, 503, "pico link down");
      this.model.enabled = on;
      if (!on && this.model.ref.pan !== "none") {
        this.model.ref = { pan: "none", persisted: false, ageS: null };
        this.event("pan_reference", null, { source: "none", reason: "enable off" });
      }
      ok(res);
    });

    // Homing completes at once: the axis is at 0, homed, and `homed` is published.
    app.post("/api/home", (req, res) => {
      if (!guard(res)) return;
      const axes = axisList(req);
      if (axes === null) return fail(res, 400, "axes: unknown axis");
      this.homeCount += 1;
      for (const name of axes.length > 0 ? axes : ["tilt" as const]) {
        this.model.axes[name] = { ...this.model.axes[name], pos: 0, tgt: 0, vel: 0, mode: "I", homed: true };
        this.event("homed", name, null);
      }
      ok(res, 202);
    });

    app.post("/api/setpos", (req, res) => {
      if (!guard(res)) return;
      const b = body(req, res, "setpos");
      if (!b) return;
      if (this.model.referenceBusy) return fail(res, 409, "reference busy");
      const values = b as Partial<Record<HeadAxisName, number>>;
      for (const name of Object.keys(values) as HeadAxisName[]) {
        const a = this.model.axes[name];
        if (a.vel !== 0 || a.mode === "H" || a.mode === "V") return fail(res, 409, `${name} is moving; stop it first`);
      }
      for (const [name, pos] of Object.entries(values) as [HeadAxisName, number][]) {
        const a = this.model.axes[name];
        this.model.axes[name] = { ...a, pos, tgt: pos, homed: name === "pan" ? true : a.homed };
        if (name === "pan") {
          this.model.ref = { pan: "host", persisted: true, ageS: 0 };
          this.event("pan_reference", null, { source: "host", pan: pos, previous: a.homed ? a.pos : null });
        }
      }
      ok(res);
    });

    // The reference run finishes on the next turn of the event loop: pan is
    // renamed to the IMU heading, or the run fails if the IMU is down.
    app.post("/api/reference", (_req, res) => {
      if (!guard(res)) return;
      if (this.model.referenceBusy) return fail(res, 409, "reference busy");
      this.model.referenceBusy = true;
      ok(res, 202);
      setImmediate(() => {
        this.model.referenceBusy = false;
        const pan = this.model.axes.pan;
        const heading = this.model.imu.heading;
        if (!this.model.imu.ok || heading === null) {
          this.event("pan_reference_failed", null, { reason: "imu calibration timeout", source: this.model.ref.pan });
          return;
        }
        this.model.axes.pan = { ...pan, pos: heading, tgt: heading, homed: true };
        this.model.ref = { pan: "imu", persisted: true, ageS: 0 };
        this.event("pan_reference", null, { source: "imu", pan: heading, previous: pan.homed ? pan.pos : null });
      });
    });

    app.get("/api/imu", (req, res) => {
      const raw = req.query.n === undefined ? "100" : String(req.query.n);
      if (!/^-?\d+$/.test(raw)) return fail(res, 400, "n: expected an integer");
      const n = Math.max(1, Math.min(Number(raw), IMU_BURST_MAX));
      if (!this.model.imu.ok) return fail(res, 503, "imu not ok");
      res.json({ n, samples: this.imuSamples(n) });
    });
  }

  private stopAxes(axes: HeadAxisName[]): void {
    for (const name of axes) {
      const a = this.model.axes[name];
      this.model.axes[name] = { ...a, vel: 0, tgt: a.pos, mode: "I" };
    }
  }

  // Gravity from the model's pitch/roll with a small alternating ripple whose
  // mean is exactly zero, so a burst's mean is gravityFor(pitch, roll).
  private imuSamples(n: number): object[] {
    const imu = this.model.imu;
    const pitch = imu.pitch ?? 0, roll = imu.roll ?? 0;
    const g = FakeHead.gravityFor(pitch, roll);
    const t0 = performance.now() / 1000;
    return Array.from({ length: n }, (_, i) => {
      const ripple = n % 2 === 1 && i === n - 1 ? 0 : (i % 2 === 0 ? 0.02 : -0.02);
      return {
        t: t0 + i * 0.01,
        heading: imu.heading ?? 0, roll, pitch,
        quat: [1, 0, 0, 0],
        gravity: [g[0] + ripple, g[1] - ripple, g[2]],
        linacc: [0, 0, 0],
        cal: imu.cal ?? { sys: 3, gyr: 3, acc: 3, mag: 3 },
        tempC: imu.tempC ?? 25,
      };
    });
  }
}
