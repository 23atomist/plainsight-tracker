import { describe, it, expect, vi, afterEach } from "vitest";
import { HeadDirectClient } from "../src/dashboard/head.js";
import { parseHeadState } from "../src/dashboard/parse.js";
import { runAction, FOCUS_MAX_NUDGE_DEG, type ControlDeps } from "../src/dashboard/controls.js";
// @ts-expect-error -- plain browser JS module, no declaration file
import { createFocusHold, formatFocus, TAP_STEP_DEG, HOLD_STEP_DEG, HOLD_DELAY_MS, HOLD_INTERVAL_MS } from "../dashboard/public/focus-control.js";

const axis = (pos: number, tgt: number) => ({ pos, vel: 0, tgt, mode: "I", homed: false, endstop: false, driver: true });
function tick(focusPos: number, focusTgt: number) {
  return {
    type: "tick", t: 1, seq: 1,
    axes: { pan: axis(0, 0), tilt: axis(0, 0), zoom: axis(0, 0), focus: axis(focusPos, focusTgt) },
    enabled: true, moving: false, estop: false,
    imu: { ok: true, heading: 0, pitch: 0, roll: 0, cal: null, tempC: 25 },
    tiltDisagreeDeg: null,
    ref: { pan: "none", persisted: false, ageS: null, frameId: null },
    link: { pico: true, imu: true },
  };
}

type Call = { url: string; method: string; body: unknown };
function recorder(reply: (url: string) => { ok: boolean; status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = reply(url);
    return { ok: r.ok, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("parseHeadState focus", () => {
  it("reads focus position and target from the tick", () => {
    const r = parseHeadState(tick(12.5, 40));
    expect(r.focusDeg).toBe(12.5);
    expect(r.focusTgtDeg).toBe(40);
  });
  it("is null when the head is unreachable", () => {
    expect(parseHeadState(null).focusTgtDeg).toBeNull();
  });
});

describe("HeadDirectClient focus", () => {
  it("focusNudge steps from the TARGET and posts a focus-only goto", async () => {
    const { fn, calls } = recorder((url) => url.endsWith("/api/state")
      ? { ok: true, status: 200, body: tick(5, 30) } : { ok: true, status: 202, body: { ok: true } });
    const target = await new HeadDirectClient("http://h:8780", fn).focusNudge(-10);
    expect(target).toBe(20);
    expect(calls[1]).toEqual({ url: "http://h:8780/api/goto", method: "POST", body: { focus: 20 } });
  });
  it("focusNudge refuses without focus telemetry and sends nothing", async () => {
    const { fn, calls } = recorder(() => ({ ok: true, status: 200, body: { ...tick(0, 0), axes: undefined } }));
    await expect(new HeadDirectClient("http://h:8780", fn).focusNudge(10)).rejects.toThrow(/no focus telemetry/);
    expect(calls.map((c) => c.url)).toEqual(["http://h:8780/api/state"]);
  });
  it("focusNudge surfaces the head's refusal (E-STOP latch: 423)", async () => {
    const { fn } = recorder((url) => url.endsWith("/api/state")
      ? { ok: true, status: 200, body: tick(0, 0) } : { ok: false, status: 423, body: { ok: false, error: "estop latched" } });
    await expect(new HeadDirectClient("http://h:8780", fn).focusNudge(10)).rejects.toThrow(/HTTP 423 estop latched/);
  });
  it("focusStop stops the focus axis only", async () => {
    const { fn, calls } = recorder(() => ({ ok: true, status: 200, body: { ok: true } }));
    await new HeadDirectClient("http://h:8780", fn).focusStop();
    expect(calls).toEqual([{ url: "http://h:8780/api/stop", method: "POST", body: { axes: ["focus"] } }]);
  });
});

describe("runAction focus", () => {
  const deps = (calls: string[]) => ({
    focusNudge: async (d: number) => { calls.push(`nudge ${d}`); return 100 + d; },
    focusStop: async () => { calls.push("stop"); },
  }) as unknown as ControlDeps;

  it("nudges and reports the new target", async () => {
    const calls: string[] = [];
    expect(await runAction(deps(calls), "focus/nudge", { delta_deg: 10 })).toEqual({ ok: true, message: "focus -> 110.0 deg" });
    expect(calls).toEqual(["nudge 10"]);
  });
  it.each([[undefined], [0], ["10"], [FOCUS_MAX_NUDGE_DEG + 1], [Number.NaN]])("rejects delta_deg %s", async (v) => {
    const calls: string[] = [];
    const r = await runAction(deps(calls), "focus/nudge", { delta_deg: v });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });
  it("stops", async () => {
    const calls: string[] = [];
    expect((await runAction(deps(calls), "focus/stop", {})).ok).toBe(true);
    expect(calls).toEqual(["stop"]);
  });
});

describe("focus hold (browser)", () => {
  afterEach(() => { vi.useRealTimers(); });
  function setup(sign: 1 | -1) {
    vi.useFakeTimers();
    const posts: [string, unknown][] = [];
    const hold = createFocusHold({ post: (p: string, b: unknown) => { posts.push([p, b]); } }, sign);
    return { hold, posts };
  }

  it("a tap sends one step and no stop", () => {
    const { hold, posts } = setup(1);
    hold.press(); vi.advanceTimersByTime(HOLD_DELAY_MS - 1); hold.release();
    vi.advanceTimersByTime(5000);
    expect(posts).toEqual([["focus/nudge", { delta_deg: TAP_STEP_DEG }]]);
  });

  it("a hold repeats until release, then stops the axis", () => {
    const { hold, posts } = setup(-1);
    hold.press();
    vi.advanceTimersByTime(HOLD_DELAY_MS + 3 * HOLD_INTERVAL_MS);
    hold.release();
    vi.advanceTimersByTime(5000);
    expect(posts).toEqual([
      ["focus/nudge", { delta_deg: -TAP_STEP_DEG }],
      ["focus/nudge", { delta_deg: -HOLD_STEP_DEG }],
      ["focus/nudge", { delta_deg: -HOLD_STEP_DEG }],
      ["focus/nudge", { delta_deg: -HOLD_STEP_DEG }],
      ["focus/stop", {}],
    ]);
  });

  it("ignores a second press and a stray release", () => {
    const { hold, posts } = setup(1);
    hold.release(); hold.press(); hold.press(); hold.release();
    expect(posts).toHaveLength(1);
  });

  it("formats the readout", () => {
    expect(formatFocus(12.345)).toBe("12.3°");
    expect(formatFocus(null)).toBe("—");
  });
});
