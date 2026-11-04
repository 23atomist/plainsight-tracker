import { describe, it, expect } from "vitest";
import { HeadDirectClient } from "../src/dashboard/head.js";

// GET /api/state of the head: the tick object (docs/HEAD-API.md).
const BODY = {
  type: "tick", t: 1, seq: 1,
  axes: {
    pan: { pos: 10, vel: 0, tgt: 10, mode: "I", homed: true, endstop: false, driver: true },
    tilt: { pos: 0, vel: 0, tgt: 0, mode: "I", homed: true, endstop: false, driver: true },
    zoom: { pos: 0, vel: 0, tgt: 0, mode: "I", homed: false, endstop: false, driver: true },
    focus: { pos: 0, vel: 0, tgt: 0, mode: "I", homed: false, endstop: false, driver: true },
  },
  enabled: true, moving: false, estop: true,
  imu: { ok: true, heading: 0, pitch: 1, roll: 2, cal: { sys: 3, gyr: 3, acc: 3, mag: 3 }, tempC: 25 },
  tiltDisagreeDeg: null,
  ref: { pan: "none", persisted: false, ageS: null, frameId: "00000000000000a1" },
  link: { pico: true, imu: false },
};

type Call = { url: string; method: string };
function recorder(reply: (url: string) => { ok: boolean; status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const r = reply(url);
    return { ok: r.ok, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("HeadDirectClient", () => {
  it("state() reads the head's /api/state at headUrl (trailing slash tolerated)", async () => {
    const { fn, calls } = recorder(() => ({ ok: true, status: 200, body: BODY }));
    const r = await new HeadDirectClient("http://1.2.3.4:8780/", fn).state();
    expect(calls).toEqual([{ url: "http://1.2.3.4:8780/api/state", method: "GET" }]);
    expect(r.connected).toBe(true);
    expect(r.panDeg).toBe(10);
    expect(r.estop).toBe(true);
    expect(r.ref?.pan).toBe("none");
    expect(r.link).toEqual({ pico: true, imu: false });
  });

  it("state() on a fetch failure or a non-ok answer reads as not connected (never throws)", async () => {
    const bad = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
    expect((await new HeadDirectClient("http://h:8780", bad).state()).connected).toBe(false);
    const { fn } = recorder(() => ({ ok: false, status: 500 }));
    expect((await new HeadDirectClient("http://h:8780", fn).state()).connected).toBe(false);
  });

  it("estop()/clearEstop()/stop() POST their routes", async () => {
    const { fn, calls } = recorder(() => ({ ok: true, status: 200, body: { ok: true } }));
    const h = new HeadDirectClient("http://h:8780", fn);
    await h.estop();
    await h.clearEstop();
    await h.stop();
    expect(calls).toEqual([
      { url: "http://h:8780/api/estop", method: "POST" },
      { url: "http://h:8780/api/estop/clear", method: "POST" },
      { url: "http://h:8780/api/stop", method: "POST" },
    ]);
  });

  it("estop() resolves confirmed on a 2xx JSON answer", async () => {
    const { fn } = recorder(() => ({ ok: true, status: 200, body: { ok: true } }));
    expect(await new HeadDirectClient("http://h:8780", fn).estop()).toEqual({ picoConfirmed: true });
  });

  // The head latches BEFORE the Pico round trip, so these answers mean the
  // latch is set but the stop is unconfirmed: not a failure.
  it("estop() on a head 503/504 (and 400/502) resolves latched-but-unconfirmed with the head's error text", async () => {
    for (const status of [503, 504, 400, 502]) {
      const { fn } = recorder(() => ({ ok: false, status, body: { ok: false, error: "pico link down" } }));
      const out = await new HeadDirectClient("http://h:8780", fn).estop();
      expect(out.picoConfirmed).toBe(false);
      expect(out.warning).toMatch(new RegExp(`latched, but the Pico did not confirm.*HTTP ${status} pico link down.*check the head`));
    }
  });

  it("estop() throws on a non-JSON answer (not the head) or an unexpected status", async () => {
    const notJson = (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })) as unknown as typeof fetch;
    await expect(new HeadDirectClient("http://h:8780", notJson).estop()).rejects.toThrow(/not JSON/);
    const { fn } = recorder(() => ({ ok: false, status: 404, body: { error: "nope" } }));
    await expect(new HeadDirectClient("http://h:8780", fn).estop()).rejects.toThrow(/HTTP 404 nope/);
  });

  it("estop() throws 'head unreachable' when the head cannot be reached", async () => {
    const bad = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(new HeadDirectClient("http://h:8780", bad).estop()).rejects.toThrow(/head unreachable.*ECONNREFUSED/);
  });
});
