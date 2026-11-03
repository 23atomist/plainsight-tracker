import { describe, it, expect, afterEach, vi } from "vitest";
import { FakeHead } from "./fake-head.js";
import { Device, DeviceHttpError } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";
import type { DeviceState } from "../src/shared/types.js";
import type { HeadAxisConfig, HeadEvent } from "../src/shared/head-types.js";

let head: FakeHead | null = null;
let dev: Device | null = null;

// Manual ticks by default (tickMs: 0): every tick a test sees is one it published.
async function startHead(tickMs = 0): Promise<FakeHead> {
  head = new FakeHead();
  await head.start({ tickMs });
  return head;
}

function makeDevice(h: FakeHead): Device {
  const cfg = loadConfig(undefined, { TB3_HEAD_URL: h.url });
  dev = new Device(cfg);
  return dev;
}

async function startDevice(h: FakeHead): Promise<Device> {
  const d = makeDevice(h);
  d.start();
  await waitFor(() => d.getState().connected && d.getState().lastUpdateMs > 0);
  return d;
}

afterEach(async () => {
  vi.restoreAllMocks();
  dev?.close(); dev = null;
  if (head) { await head.stop(); head = null; }
});

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  if (!pred()) throw new Error("waitFor timed out");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jogBodies(h: FakeHead): Array<{ pan?: number; tilt?: number }> {
  return h.calls.filter((c) => c.method === "POST" && c.path === "/api/jog")
    .map((c) => c.body as { pan?: number; tilt?: number });
}

function lastJogIsZero(h: FakeHead): boolean {
  const f = jogBodies(h);
  return f.length > 0 && f[f.length - 1].pan === 0 && f[f.length - 1].tilt === 0;
}

describe("Device (head API)", () => {
  it("parses a tick into degrees and fires telemetry once per tick", async () => {
    const h = await startHead();
    h.setPosition(30.5, 12.25);
    const d = makeDevice(h);
    const seen: DeviceState[] = [];
    d.onTelemetry((s) => seen.push(s));
    d.start();
    // The head sends the current tick on connect.
    await waitFor(() => seen.length === 1);
    expect(seen[0].panDeg).toBe(30.5);
    expect(seen[0].tiltDeg).toBe(12.25);
    expect(seen[0].moving).toBe(false);
    expect(seen[0].connected).toBe(true);
    expect(seen[0].axes?.pan.mode).toBe("I");

    h.setPosition(31, 13);
    h.tick();
    h.tick();
    await waitFor(() => seen.length === 3);
    await sleep(100);
    expect(seen.length).toBe(3);
    // The snapshot handed to the listener is the state as of that tick.
    expect(seen[2].panDeg).toBe(31);
    expect(d.getState().panDeg).toBe(31);
    expect(d.getState().tiltDeg).toBe(13);
    expect(d.getState().ref.pan).toBe("imu");
    expect(d.getState().link).toEqual({ pico: true, imu: true });
  });

  it("a throwing onTelemetry listener does not stop telemetry processing or other listeners", async () => {
    const h = await startHead();
    const d = makeDevice(h);
    let good = 0;
    d.onTelemetry(() => { throw new Error("boom"); });
    d.onTelemetry(() => { good += 1; });
    d.start();
    await waitFor(() => good === 1);
    h.setPosition(7, 0);
    h.tick();
    await waitFor(() => good === 2);
    expect(d.getState().panDeg).toBe(7);
  });

  it("a tick without axes updates link/imu/ref but not lastUpdateMs or angles", async () => {
    const h = await startHead();
    h.setPosition(40, 20);
    const d = makeDevice(h);
    let fired = 0;
    d.onTelemetry(() => { fired += 1; });
    d.start();
    await waitFor(() => fired === 1);
    const before = d.getState();
    expect(before.panDeg).toBe(40);

    h.model.link.pico = false;
    h.model.imu.heading = 200;
    h.model.ref = { pan: "none", persisted: false, ageS: null };
    h.model.estop = true;
    h.setPosition(99, 99); // the head cannot see this: the Pico link is down
    await sleep(5);
    h.tickNoAxes();
    await waitFor(() => d.getState().link.pico === false);

    const after = d.getState();
    expect(after.link).toEqual({ pico: false, imu: true });
    expect(after.imu?.heading).toBe(200);
    expect(after.ref.pan).toBe("none");
    expect(after.estop).toBe(true);
    // No motion telemetry: angles, moving and lastUpdateMs stay as the last
    // tick that carried axes left them, so staleness checks still fire.
    expect(after.panDeg).toBe(40);
    expect(after.tiltDeg).toBe(20);
    expect(after.moving).toBe(before.moving);
    expect(after.lastUpdateMs).toBe(before.lastUpdateMs);
    expect(after.connected).toBe(true);
    expect(fired).toBe(1);
  });

  it("goto posts /api/goto and resolves on 202; 423 becomes DeviceHttpError(423)", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    await d.gotoAngle(15, 30, 20);
    expect(h.lastGoto).toEqual({ pan: 15, tilt: 30 });
    expect(h.gotoCount).toBe(1);

    h.model.estop = true;
    const err = await d.gotoAngle(1, 2).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceHttpError);
    expect((err as DeviceHttpError).status).toBe(423);
    expect((err as Error).message).toMatch(/estop latched/);

    // 423 is checked before 503.
    h.model.link.pico = false;
    expect(((await d.gotoAngle(1, 2).catch((e) => e)) as DeviceHttpError).status).toBe(423);
    h.model.estop = false;
    expect(((await d.gotoAngle(1, 2).catch((e) => e)) as DeviceHttpError).status).toBe(503);
    expect(h.gotoCount).toBe(1);
  });

  it("gotoAngle + waitForArrival resolve against the simulated move", async () => {
    const h = await startHead(50);
    h.setPosition(0, 10);
    const d = await startDevice(h);
    await d.gotoAngle(15, 20);
    const final = await d.waitForArrival(15, 20, 5000);
    expect(final.panDeg).toBeCloseTo(15, 6);
    expect(final.tiltDeg).toBeCloseTo(20, 6);
    expect(final.moving).toBe(false);
  });

  it("track posts the pos/vel pairs exactly as given", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    await d.track({ pan: { pos: 123.4, vel: 0.8 }, tilt: { pos: 31.2, vel: -0.1 } });
    expect(h.lastTrack).toEqual({ pan: { pos: 123.4, vel: 0.8 }, tilt: { pos: 31.2, vel: -0.1 } });
    await d.track({ tilt: { pos: 5, vel: 0 } });
    expect(h.lastTrack).toEqual({ tilt: { pos: 5, vel: 0 } });
    h.model.link.pico = false;
    const err = await d.track({ pan: { pos: 1, vel: 0 } }).catch((e) => e);
    expect((err as DeviceHttpError).status).toBe(503);
  });

  it("jog refreshes every 100ms and sends zeros at the end; setJogVector expires via TTL", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    const t0 = Date.now();
    await d.jog(10, -5, 300);
    const elapsed = Date.now() - t0;
    const frames = jogBodies(h);
    const moving = frames.filter((f) => f.pan !== 0 || f.tilt !== 0);
    // One frame up front plus one per 100ms keep-alive tick.
    expect(moving.length).toBeGreaterThanOrEqual(3);
    expect(moving.length).toBeLessThanOrEqual(5);
    for (const f of moving) expect(f).toEqual({ pan: 10, tilt: -5 });
    // jog() resolves only once the zero frame has reached the head.
    expect(lastJogIsZero(h)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(290);

    h.calls.length = 0;
    d.setJogVector(5, 0, 250);
    await waitFor(() => lastJogIsZero(h), 1500);
    const ttlFrames = jogBodies(h);
    expect(ttlFrames[0]).toEqual({ pan: 5, tilt: 0 });
    expect(ttlFrames.length).toBeGreaterThanOrEqual(3);
    const n = ttlFrames.length;
    await sleep(300);
    expect(jogBodies(h).length).toBe(n); // the keep-alive stopped after expiry
  });

  it("jog resolves only after the zero frame is answered, even when the head is slow", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.responseDelayMs = 150; // slower than the keep-alive interval
    await d.jog(8, 0, 250);
    const frames = jogBodies(h);
    expect(lastJogIsZero(h)).toBe(true);
    expect(frames.slice(0, -1).every((f) => f.pan === 8)).toBe(true);
  });

  it("a jog refused by the head rejects with the head's status", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.model.estop = true;
    const err = await d.jog(5, 0, 150).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceHttpError);
    expect((err as DeviceHttpError).status).toBe(423);
  });

  it("lockJog clears and blocks refreshes until unlockJog", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    d.setJogVector(6, 1, 1000);
    await waitFor(() => jogBodies(h).length >= 2);
    d.lockJog();
    await waitFor(() => lastJogIsZero(h));
    await sleep(150);
    const atLock = jogBodies(h).length;
    d.setJogVector(7, 0, 1000); // no-op while locked
    await sleep(250);
    expect(jogBodies(h).length).toBe(atLock);

    d.unlockJog();
    d.setJogVector(7, 0, 1000);
    await waitFor(() => jogBodies(h).some((f) => f.pan === 7));
    d.clearJog();
    await waitFor(() => lastJogIsZero(h));
  });

  // --- the motion FIFO ------------------------------------------------------

  function motion(h: FakeHead): { path: string; body: unknown }[] {
    return h.calls.filter((c) => ["/api/goto", "/api/track", "/api/stop", "/api/jog"].includes(c.path))
      .map((c) => ({ path: c.path, body: c.body }));
  }

  it("motion commands reach the head strictly in call order, one in flight at a time", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.responseDelayMs = 100;
    const done = Promise.all([
      d.track({ pan: { pos: 1, vel: 1 }, tilt: { pos: 2, vel: 0 } }),
      d.stop(),
      d.gotoAngle(10, 20),
    ]);
    await sleep(50);
    expect(motion(h).map((c) => c.path)).toEqual(["/api/track"]);   // the rest wait their turn
    await done;
    expect(motion(h).map((c) => c.path)).toEqual(["/api/track", "/api/stop", "/api/goto"]);
  });

  it("a queued TRACK is replaced by a newer one covering the same axes (and resolves)", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.responseDelayMs = 100;
    const a = d.track({ pan: { pos: 1, vel: 0 }, tilt: { pos: 1, vel: 0 } });   // in flight
    const b = d.track({ pan: { pos: 2, vel: 0 }, tilt: { pos: 2, vel: 0 } });   // queued...
    const c = d.track({ pan: { pos: 3, vel: 0 }, tilt: { pos: 3, vel: 0 } });   // ...replaced by this
    await Promise.all([a, b, c]);
    expect(motion(h).map((m) => (m.body as { pan: { pos: number } }).pan.pos)).toEqual([1, 3]);
  });

  it("a TRACK that leaves an axis out does not replace a queued one that had it", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.responseDelayMs = 100;
    const a = d.track({ pan: { pos: 1, vel: 0 } });
    const b = d.track({ pan: { pos: 2, vel: 0 }, tilt: { pos: 2, vel: 0 } });
    const c = d.track({ tilt: { pos: 3, vel: 0 } });
    await Promise.all([a, b, c]);
    expect(motion(h)).toHaveLength(3);
  });

  it("a queued command that the head refuses rejects its own caller only", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.failNext("/api/goto", 503);
    const goto = d.gotoAngle(1, 1).catch((e) => e);
    const stop = d.stop();
    expect(await goto).toBeInstanceOf(DeviceHttpError);
    await expect(stop).resolves.toBeUndefined();
  });

  it("a closed Device sends no queued motion, and refuses new motion", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.responseDelayMs = 100;
    const goto = d.gotoAngle(1, 1).catch((e) => e);   // in flight
    const stop = d.stop().catch((e) => e);             // queued
    d.close();
    expect(await stop).toBeInstanceOf(Error);
    await goto;
    await sleep(150);
    expect(h.calls.filter((c) => c.path === "/api/stop")).toHaveLength(0);
    await expect(d.track({ pan: { pos: 0, vel: 0 } })).rejects.toThrow(/closed/);
  });

  it("E-STOP discards queued motion: a pre-E-STOP goto never runs after the latch is cleared", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.responseDelayMs = 150;
    const track = d.track({ pan: { pos: 1, vel: 0 } }).catch((e) => e);   // in flight
    const goto = d.gotoAngle(10, 20).catch((e) => e);                     // queued behind it
    await sleep(20);
    await d.estop();
    await d.clearEstop();
    await track;
    const err = await goto;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/E-STOP/);
    await sleep(200);
    const paths = h.calls.map((c) => c.path).filter((p) => p !== "/api/config");
    expect(paths.slice(paths.indexOf("/api/estop"))).toEqual(["/api/estop", "/api/estop/clear"]);
    expect(h.lastGoto).toBeNull();
  });

  it("home and setPos ride the motion FIFO in call order", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.responseDelayMs = 80;
    await Promise.all([d.gotoAngle(1, 1), d.setPos({ pan: 0 }).catch(() => {}), d.home(["tilt"])]);
    const paths = h.calls.map((c) => c.path).filter((p) => ["/api/goto", "/api/setpos", "/api/home"].includes(p));
    expect(paths).toEqual(["/api/goto", "/api/setpos", "/api/home"]);
  });

  it("E-STOP is not queued behind a slow motion command", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.responseDelayMs = 200;
    const goto = d.gotoAngle(10, 20);
    const stop = d.stop().catch((e) => e);
    await sleep(20);
    const estop = d.estop();
    await sleep(50);
    const paths = h.calls.map((c) => c.path).filter((p) => p !== "/api/config");
    expect(paths).toEqual(["/api/goto", "/api/estop"]);   // estop overtook the queued stop...
    expect(await stop).toBeInstanceOf(Error);             // ...which it discarded
    await Promise.allSettled([goto, estop]);
  });

  it("clearJog sends a zero frame only when a jog vector was live", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    d.clearJog();                       // nothing live: nothing to stop
    await sleep(100);
    expect(jogBodies(h)).toHaveLength(0);

    d.setJogVector(4, 0, 1000);
    await waitFor(() => jogBodies(h).length >= 1);
    d.clearJog();                       // live: one zero frame
    await waitFor(() => lastJogIsZero(h));
    const afterFirst = jogBodies(h).length;
    d.clearJog();                       // already cleared: nothing more
    await sleep(100);
    expect(jogBodies(h)).toHaveLength(afterFirst);
  });

  it("stop(axes) stops only the named axes; stop() stops all", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    await d.stop(["pan"]);
    expect(h.calls.filter((c) => c.path === "/api/stop").at(-1)?.body).toEqual({ axes: ["pan"] });
    await d.stop();
    expect(h.calls.filter((c) => c.path === "/api/stop").at(-1)?.body).toBeUndefined();
    expect(h.stopCount).toBe(2);
  });

  it("estop/clearEstop/home/setPos/reference hit their routes", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    const events: HeadEvent[] = [];
    d.onEvent((e) => events.push(e));

    await d.stop();
    expect(h.stopCount).toBe(1);

    await d.estop();
    expect(h.model.estop).toBe(true);
    await waitFor(() => events.some((e) => e.name === "estop"));
    await waitFor(() => d.getState().estop === true);
    await d.clearEstop();
    expect(h.model.estop).toBe(false);
    await waitFor(() => events.some((e) => e.name === "estop_cleared"));
    await waitFor(() => d.getState().estop === false);

    await d.home(["tilt"]);
    await d.home();
    expect(h.homeCount).toBe(2);

    await d.setPos({ pan: 0 });
    await d.reference();

    const posts = h.calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body]);
    expect(posts).toEqual([
      ["/api/stop", undefined],
      ["/api/estop", undefined],
      ["/api/estop/clear", undefined],
      ["/api/home", { axes: ["tilt"] }],
      ["/api/home", undefined],
      ["/api/setpos", { pan: 0 }],
      ["/api/reference", undefined],
    ]);

    // 409 on a moving axis carries the head's text.
    h.model.axes.pan.vel = 3;
    const err = await d.setPos({ pan: 1 }).catch((e) => e);
    expect((err as DeviceHttpError).status).toBe(409);
    expect((err as Error).message).toMatch(/pan is moving/);
  });

  it("getGravity averages the burst gravity vectors and throws when imu.ok is false", async () => {
    const h = await startHead();
    h.model.imu.pitch = 10;
    h.model.imu.roll = -4;
    const d = await startDevice(h);
    const g = await d.getGravity(20);
    expect(h.calls.some((c) => c.method === "GET" && c.path === "/api/imu" && c.query.n === "20")).toBe(true);
    const e = FakeHead.gravityFor(10, -4);
    const len = Math.hypot(...e);
    expect(g[0]).toBeCloseTo(e[0] / len, 6);
    expect(g[1]).toBeCloseTo(e[1] / len, 6);
    expect(g[2]).toBeCloseTo(e[2] / len, 6);
    expect(Math.hypot(...g)).toBeCloseTo(1, 9);

    // The head's 503 surfaces as a DeviceHttpError.
    h.imuOk = false;
    const httpErr = await d.getGravity(5).catch((x) => x);
    expect(httpErr).toBeInstanceOf(DeviceHttpError);
    expect((httpErr as DeviceHttpError).status).toBe(503);
    expect((httpErr as Error).message).toMatch(/imu not ok/i);

    // Once a tick has reported imu.ok === false the client refuses up front.
    h.tick();
    await waitFor(() => d.getState().imu?.ok === false);
    const before = h.calls.length;
    await expect(d.getGravity(5)).rejects.toThrow(/IMU not ok/);
    expect(h.calls.length).toBe(before);
  });

  it("fetches /api/config on open and on a config event; getAxisConfig returns pan/tilt", async () => {
    const h = await startHead();
    const d = makeDevice(h);
    const seen: Array<Record<"pan" | "tilt", HeadAxisConfig>> = [];
    d.onConfig((c) => seen.push(c));
    expect(d.getAxisConfig()).toBeNull();
    d.start();
    await waitFor(() => seen.length === 1);
    expect(h.calls.filter((c) => c.method === "GET" && c.path === "/api/config").length).toBe(1);
    expect(d.getAxisConfig()).toEqual({
      pan: { min: -180, max: 180, vmax: 5, amax: 10 },
      tilt: { min: 0, max: 90, vmax: 5, amax: 10 },
    });

    h.setConfig("pan", { vmax: 20, amax: 40 });
    await waitFor(() => d.getAxisConfig()?.pan.vmax === 20 && d.getAxisConfig()?.pan.amax === 40);
    expect(seen[seen.length - 1].pan).toEqual({ min: -180, max: 180, vmax: 20, amax: 40 });
    expect(seen[seen.length - 1].tilt.vmax).toBe(5);
  });

  it("re-reads /api/config when the Pico link comes up (it 503s while the link is down)", async () => {
    const h = await startHead();
    h.model.link.pico = false;
    const d = makeDevice(h);
    d.start();
    // The on-connect tick has no axes, so lastUpdateMs stays 0; wait on the fetch.
    await waitFor(() => h.calls.some((c) => c.path === "/api/config"));
    expect(d.getState().lastUpdateMs).toBe(0);
    await sleep(50);
    expect(d.getAxisConfig()).toBeNull();
    h.model.link.pico = true;
    h.emitEvent({ type: "event", t: 1, name: "pico_link", axis: null, detail: { up: true } });
    await waitFor(() => d.getAxisConfig() !== null);
    expect(d.getAxisConfig()?.tilt).toEqual({ min: 0, max: 90, vmax: 5, amax: 10 });
  });

  it("pan_reference events fire onReferenceChanged with source/pan/previous", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    const changes: Array<{ source: string; pan: number | null; previous: number | null }> = [];
    d.onReferenceChanged((c) => changes.push(c));

    h.emitEvent({ type: "event", t: 1, name: "homed", axis: "tilt", detail: null });
    h.emitEvent({
      type: "event", t: 2, name: "pan_reference", axis: null,
      detail: { source: "imu", pan: 123.4, previous: 121.9 },
    });
    h.emitEvent({
      type: "event", t: 3, name: "pan_reference", axis: null,
      detail: { source: "host", pan: 0, previous: null },
    });
    h.emitEvent({
      type: "event", t: 4, name: "pan_reference", axis: null,
      detail: { source: "none", reason: "pan unhomed" },
    });
    h.emitEvent({
      type: "event", t: 5, name: "pan_reference_failed", axis: null,
      detail: { reason: "imu calibration timeout", source: "host" },
    });
    await waitFor(() => changes.length === 3);
    await sleep(50);
    expect(changes).toEqual([
      { source: "imu", pan: 123.4, previous: 121.9 },
      { source: "host", pan: 0, previous: null },
      { source: "none", pan: null, previous: null, reason: "pan unhomed" },
    ]);

    // POST /api/setpos with pan makes the head announce the rename.
    h.setPosition(42, 10);
    await d.setPos({ pan: 90 });
    await waitFor(() => changes.length === 4);
    expect(changes[3]).toEqual({ source: "host", pan: 90, previous: 42 });
  });

  it("reconnects after the socket closes", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.dropClients();
    await waitFor(() => !d.getState().connected);
    await waitFor(() => d.getState().connected, 3000);
    // The fresh socket triggers a fresh config fetch.
    await waitFor(() => h.calls.filter((c) => c.path === "/api/config").length === 2);
  });

  it("close() while a reconnect backoff is pending leaves the device restartable", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    h.dropClients();
    await waitFor(() => !d.getState().connected);
    d.close();
    await sleep(1200);
    expect(d.getState().connected).toBe(false); // the pending reconnect was cancelled
    d.start();
    await waitFor(() => d.getState().connected);
    h.dropClients();
    await waitFor(() => !d.getState().connected);
    await waitFor(() => d.getState().connected, 3000);
  });

  it("rejected ticks and events leave state untouched, are counted, and warn once per burst", async () => {
    const h = await startHead();
    h.setPosition(40, 20);
    const d = await startDevice(h);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = d.getState();

    // A bare NaN literal (invalid JSON) and an extra key (fails the strict schema),
    // both carrying a pan the client must not adopt.
    const tick = h.currentTick() as { axes: { pan: { pos: number } } };
    tick.axes.pan.pos = 77;
    const nanFrame = JSON.stringify(tick).replace(/"tiltDisagreeDeg":[^,]+/, '"tiltDisagreeDeg":NaN');
    expect(nanFrame).toContain("NaN");
    const extraFrame = JSON.stringify({ ...tick, extra: 1 });
    for (let i = 0; i < 3; i++) { h.sendRaw(nanFrame); h.sendRaw(extraFrame); }
    await waitFor(() => d.getDiagnostics().rejectedTicks === 6);

    const after = d.getState();
    expect(after.panDeg).toBe(40);
    expect(after.lastUpdateMs).toBe(before.lastUpdateMs);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/rejected tick.*JSON parse error/);

    // Events are a separate kind: their own counter and their own warning.
    h.sendRaw(JSON.stringify({ type: "event", t: 1, name: "estop", axis: "pan", detail: null }));
    await waitFor(() => d.getDiagnostics().rejectedEvents === 1);
    expect(d.getState().estop).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toMatch(/rejected event.*"estop"/);

    expect(d.getDiagnostics()).toEqual({ rejectedTicks: 6, rejectedEvents: 1, rejectedConfig: 0 });

    // A config response missing a required key is rejected too.
    delete (h.config.pan as Record<string, number>).amax;
    h.emitEvent({ type: "event", t: 2, name: "config", axis: null, detail: { scope: "pan", key: "x", value: 1 } });
    await waitFor(() => d.getDiagnostics().rejectedConfig >= 1);
    expect(d.getAxisConfig()?.pan.amax).toBe(10); // the cached config is kept
    expect(String(warn.mock.calls[2][0])).toMatch(/rejected config.*pan\.amax/);
  });

  it("a strict-schema reject names the zod issue", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.sendRaw(JSON.stringify({ ...h.currentTick(), extra: 1 }));
    await waitFor(() => d.getDiagnostics().rejectedTicks === 1);
    expect(String(warn.mock.calls[0][0])).toMatch(/rejected tick.*extra/);
  });

  it("close() mid-jog stops the keep-alive: no further /api/jog calls land", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    const p = d.jog(5, 0, 1000);
    await waitFor(() => jogBodies(h).length >= 2);
    const closedAt = Date.now();
    d.close();
    await p; // ends quietly, at the next keep-alive tick rather than after the full duration
    expect(Date.now() - closedAt).toBeLessThan(300);

    // A jog on an already-closed device returns at once and sends nothing.
    const t0 = Date.now();
    await d.jog(5, 0, 1000);
    expect(Date.now() - t0).toBeLessThan(50);
    await sleep(50); // let an already in-flight frame land
    const n = jogBodies(h).length;
    await sleep(350);
    expect(jogBodies(h).length).toBe(n);
    expect(jogBodies(h).every((f) => f.pan === 5)).toBe(true); // nothing sent after close, not even zeros
  });

  it("estop() mid-jog ends the jog with a rejection and stops the keep-alive", async () => {
    const h = await startHead();
    const d = await startDevice(h);
    const p = d.jog(5, 0, 1000);
    const settled = p.catch((e) => e);
    await waitFor(() => jogBodies(h).length >= 2);
    await d.estop();
    expect(String(await settled)).toMatch(/E-STOP/);
    await sleep(300);
    const estopAt = h.calls.findIndex((c) => c.path === "/api/estop");
    expect(h.calls.slice(estopAt + 1).filter((c) => c.path === "/api/jog")).toEqual([]);
  });

  it("onConfig does not fire after close() when a config fetch was in flight", async () => {
    const h = await startHead();
    h.responseDelayMs = 200;
    const d = makeDevice(h);
    let fired = 0;
    d.onConfig(() => { fired += 1; });
    d.start();
    await waitFor(() => h.calls.some((c) => c.path === "/api/config"));
    d.close();
    await sleep(400);
    expect(fired).toBe(0);
    expect(d.getAxisConfig()).toBeNull();
  });

  it("retries a failed config fetch until it succeeds", async () => {
    const h = await startHead();
    h.failNext("/api/config", 500);
    // Record what the device actually received, so the injected failure is
    // proven to be the head's JSON envelope and not some other error page.
    const configResponses: Array<{ status: number; body: unknown }> = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const r = await fetch(input, init);
      if (String(input).endsWith("/api/config")) {
        configResponses.push({ status: r.status, body: await r.clone().json() });
      }
      return r;
    };
    const cfg = loadConfig(undefined, { TB3_HEAD_URL: h.url });
    const d = new Device(cfg, Date.now, recordingFetch);
    dev = d;
    d.start();
    await waitFor(() => d.getAxisConfig() !== null, 4000);
    expect(h.calls.filter((c) => c.path === "/api/config").length).toBe(2);
    expect(configResponses[0]).toEqual({ status: 500, body: { ok: false, error: "injected failure 500" } });
    expect(configResponses[1].status).toBe(200);
  });
});
