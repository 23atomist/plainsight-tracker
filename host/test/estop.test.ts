import { describe, it, expect, vi } from "vitest";
import { createEstop, CLEAR_GRACE_MS } from "../dashboard/public/estop.js";

// Hand-rolled fake DOM -- same convention as cockpit.test.ts/drawer.test.ts
// (no jsdom in this repo).
function fakeClassList() {
  const set = new Set<string>();
  return {
    add: (...cs: string[]) => { for (const c of cs) set.add(c); },
    remove: (...cs: string[]) => { for (const c of cs) set.delete(c); },
    has: (c: string) => set.has(c),
  };
}

function fakeEl() {
  return {
    estopBanner: { classList: fakeClassList() },
    estopBannerDetail: { textContent: "" },
  };
}

function setup(fetchImpl?: typeof fetch, clock = { t: 100000 }) {
  const el = fakeEl();
  const toasts: Array<[string, boolean]> = [];
  const toast = (message: string, ok: boolean) => { toasts.push([message, ok]); };
  const applyMotionGate = vi.fn();
  const refreshCockpitLock = vi.fn();
  if (fetchImpl) vi.stubGlobal("fetch", fetchImpl);
  const estop = createEstop({ el, toast, applyMotionGate, refreshCockpitLock, now: () => clock.t });
  return { el, estop, toasts, applyMotionGate, refreshCockpitLock, clock };
}

// Routes by URL so one stub serves both the E-STOP and the Clear posts.
function routes(map: Record<string, unknown | (() => unknown)>) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const v = map[url];
    if (v instanceof Error) throw v;
    return { json: async () => (typeof v === "function" ? (v as () => unknown)() : v) };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("createEstop", () => {
  it("starts unlatched", () => {
    const { estop } = setup();
    expect(estop.isLatched()).toBe(false);
  });

  // The safety property this whole module exists for: the latch must be
  // true THE INSTANT trigger() is called, before any network round trip --
  // not after the fetch resolves. A synchronous check right after calling
  // trigger() (not awaiting it) proves this.
  it("latches synchronously, before the network request resolves", () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    const { estop, el, applyMotionGate, refreshCockpitLock } = setup(
      (() => pending) as unknown as typeof fetch,
    );
    expect(estop.isLatched()).toBe(false);
    void estop.trigger(); // deliberately not awaited
    expect(estop.isLatched()).toBe(true);
    expect(el.estopBanner.classList.has("show")).toBe(true);
    expect(applyMotionGate).toHaveBeenCalledTimes(1);
    expect(refreshCockpitLock).toHaveBeenCalledTimes(1);
    resolveFetch({ json: async () => ({ allOk: true }) });
  });

  it("on a successful response, renders the per-leg detail (head first) and toasts success", async () => {
    const { estop, el, toasts } = setup((async () =>
      ({ json: async () => ({
        agent: { ok: true, message: "agent disarmed" },
        tracking: { ok: true, message: "tracking stopped" },
        head: { ok: true, message: "head E-STOP latched" },
        allOk: true,
      }) })) as unknown as typeof fetch);
    await estop.trigger();
    expect(el.estopBannerDetail.textContent).toMatch(/^head: ok \(head E-STOP latched\)/);
    expect(el.estopBannerDetail.textContent).toContain("agent: ok (agent disarmed)");
    expect(toasts.some(([m, ok]) => ok && /head latched/.test(m))).toBe(true);
  });

  // The MCP server is down: the head still latched, so the stop worked.
  it("a failed daemon leg with the head latched is reported, but as a latched head", async () => {
    const { estop, el, toasts } = setup((async () =>
      ({ json: async () => ({
        agent: { ok: false, message: "fetch failed" },
        tracking: { ok: false, message: "fetch failed" },
        head: { ok: true, message: "head E-STOP latched" },
        allOk: false,
      }) })) as unknown as typeof fetch);
    await estop.trigger();
    expect(el.estopBannerDetail.textContent).toContain("agent: FAIL (fetch failed)");
    expect(toasts.some(([m, ok]) => !ok && /head latched.*daemon leg failed/i.test(m))).toBe(true);
  });

  // The 502 body: the head did not confirm. Must say so loudly.
  it("reports a failed HEAD leg without claiming success", async () => {
    const { estop, el, toasts } = setup((async () =>
      ({ status: 502, json: async () => ({
        agent: { ok: true, message: "agent disarmed" },
        tracking: { ok: true, message: "tracking stopped" },
        head: { ok: false, message: "head unreachable" },
        allOk: false, error: "head unreachable",
      }) })) as unknown as typeof fetch);
    await estop.trigger();
    expect(estop.isLatched()).toBe(true);
    expect(el.estopBannerDetail.textContent).toContain("head: FAIL (head unreachable)");
    expect(toasts.some(([m, ok]) => !ok && /HEAD did not confirm/.test(m))).toBe(true);
  });

  // The whole point of a client-side latch: even when the network request
  // itself throws, the rig is still treated as stopped -- it must NEVER
  // silently unlatch on a failed request.
  it("stays latched even when the request itself throws", async () => {
    const { estop, el, toasts } = setup((async () => { throw new Error("network down"); }) as unknown as typeof fetch);
    await estop.trigger();
    expect(estop.isLatched()).toBe(true);
    expect(el.estopBannerDetail.textContent).toMatch(/request failed/i);
    expect(toasts.some(([m, ok]) => !ok && /remaining latched/i.test(m))).toBe(true);
  });

  it("clear() posts clear_estop and, on success, unlatches, clears the banner, and re-applies the gate", async () => {
    const { fn, calls } = routes({
      "/api/control/estop": { allOk: true },
      "/api/control/clear_estop": { ok: true, message: "E-STOP cleared" },
    });
    const { estop, el, toasts, applyMotionGate, refreshCockpitLock } = setup(fn);
    await estop.trigger();
    expect(estop.isLatched()).toBe(true);

    await estop.clear();
    expect(calls).toEqual(["/api/control/estop", "/api/control/clear_estop"]);
    expect(estop.isLatched()).toBe(false);
    expect(el.estopBanner.classList.has("show")).toBe(false);
    expect(el.estopBannerDetail.textContent).toBe("");
    expect(toasts).toContainEqual(["E-STOP cleared", true]);
    // Once for trigger()'s latch, once for clear().
    expect(applyMotionGate).toHaveBeenCalledTimes(2);
    expect(refreshCockpitLock).toHaveBeenCalledTimes(2);
  });

  // Never show "resumed" while the head still refuses motion.
  it("clear() stays latched when the head did not clear, or the request fails", async () => {
    const { fn } = routes({
      "/api/control/estop": { allOk: true },
      "/api/control/clear_estop": { ok: false, message: "head did not clear E-STOP: HTTP 500" },
    });
    const { estop, el, toasts } = setup(fn);
    await estop.trigger();
    await estop.clear();
    expect(estop.isLatched()).toBe(true);
    expect(el.estopBanner.classList.has("show")).toBe(true);
    expect(el.estopBannerDetail.textContent).toMatch(/clear failed: head did not clear/);
    expect(toasts.some(([m, ok]) => !ok && /NOT cleared/.test(m))).toBe(true);

    vi.stubGlobal("fetch", (async () => { throw new Error("network down"); }) as unknown as typeof fetch);
    await estop.clear();
    expect(estop.isLatched()).toBe(true);
    expect(el.estopBannerDetail.textContent).toMatch(/clear request failed: network down/);
  });

  // An E-STOP from anywhere (MCP estop tool, another browser) locks this page.
  it("syncFromHead latches on the head's latch, but never unlatches", () => {
    const { estop, el, applyMotionGate } = setup();
    estop.syncFromHead(false);
    expect(estop.isLatched()).toBe(false);
    estop.syncFromHead(true);
    expect(estop.isLatched()).toBe(true);
    expect(el.estopBanner.classList.has("show")).toBe(true);
    expect(el.estopBannerDetail.textContent).toMatch(/head reports/);
    estop.syncFromHead(true);
    expect(applyMotionGate).toHaveBeenCalledTimes(1);   // no re-latch churn
    estop.syncFromHead(false);
    expect(estop.isLatched()).toBe(true);               // clears only on an operator Clear
  });

  it("syncFromHead ignores a stale latched tick just after a successful clear, then honours it", async () => {
    const { fn } = routes({ "/api/control/clear_estop": { ok: true, message: "E-STOP cleared" } });
    const { estop, clock } = setup(fn);
    estop.syncFromHead(true);
    await estop.clear();
    expect(estop.isLatched()).toBe(false);
    clock.t += 1000;
    estop.syncFromHead(true);                            // in-flight tick from before the clear
    expect(estop.isLatched()).toBe(false);
    clock.t += CLEAR_GRACE_MS;
    estop.syncFromHead(true);                            // a real new latch
    expect(estop.isLatched()).toBe(true);
  });

  it("a malformed/non-object response is reported, not thrown", async () => {
    const { estop, el } = setup((async () => ({ json: async () => null })) as unknown as typeof fetch);
    await estop.trigger();
    expect(el.estopBannerDetail.textContent).toBe("no response from server");
  });
});
