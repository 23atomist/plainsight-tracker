import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildControlDeps, registerControlRoutes } from "../src/dashboard/server.js";
import { HeadDirectClient } from "../src/dashboard/head.js";

type Sources = Parameters<typeof buildControlDeps>[0];

// An MCP client whose every tool call fails, as when the MCP server is down.
// A Proxy so buildControlDeps can bind() any method it likes.
function downClient(calls: string[]): Sources["client"] {
  return new Proxy({}, {
    get: (_t, name) => async () => { calls.push(`mcp:${String(name)}`); throw new Error("fetch failed"); },
  }) as unknown as Sources["client"];
}

// An MCP server that accepted the connection and never answers.
function hungClient(calls: string[]): Sources["client"] {
  return new Proxy({}, {
    get: (_t, name) => () => { calls.push(`mcp:${String(name)}`); return new Promise(() => {}); },
  }) as unknown as Sources["client"];
}

function upClient(calls: string[]): Sources["client"] {
  return new Proxy({}, {
    get: (_t, name) => async () => { calls.push(`mcp:${String(name)}`); return "ok"; },
  }) as unknown as Sources["client"];
}

function fakeHead(calls: string[], fail?: string): Sources["head"] {
  return {
    estop: async () => { calls.push("head:estop"); if (fail) throw new Error(fail); return { picoConfirmed: true }; },
    clearEstop: async () => { calls.push("head:clearEstop"); if (fail) throw new Error(fail); },
  } as unknown as Sources["head"];
}

let server: Server | null = null;
let headServer: Server | null = null;
afterEach(() => { server?.close(); server = null; headServer?.close(); headServer = null; });

// A real HTTP head stub answering POST /api/estop with `status` + JSON body,
// recording when (ms since `t0`) the request arrived.
async function stubHead(status: number, body: unknown, seen: { at: number[] }, t0: () => number): Promise<string> {
  const app = express();
  app.post("/api/estop", (_req, res) => { seen.at.push(Date.now() - t0()); res.status(status).json(body); });
  await new Promise<void>((r) => { headServer = app.listen(0, "127.0.0.1", r); });
  return `http://127.0.0.1:${(headServer!.address() as AddressInfo).port}`;
}

async function start(client: Sources["client"], head: Sources["head"]): Promise<string> {
  const camera = { enable: () => {}, disable: () => {}, status: () => ({ enabled: false, streaming: false, viewers: 0 }) };
  const deps = buildControlDeps({
    client, head, camera, cfg: {} as Sources["cfg"], mtx: null, cameraError: null,
  } as unknown as Sources);
  const app = express();
  app.use(express.json());
  registerControlRoutes(app, deps);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", r); });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("POST /api/control/estop", () => {
  // Plan Review Focus 3 + controller ruling: the dashboard E-STOP latches the
  // head FIRST, directly, with the MCP server down or hung.
  it("latches the head directly even when every MCP call throws, and answers 200", async () => {
    const calls: string[] = [];
    const base = await start(downClient(calls), fakeHead(calls));
    const r = await fetch(`${base}/api/control/estop`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, pico_confirmed: true, allOk: false });
    expect(body.head).toEqual({ ok: true, message: "head E-STOP latched" });
    expect(body.agent.ok).toBe(false);
    expect(body.tracking.ok).toBe(false);
    expect(calls[0]).toBe("head:estop");
  });

  it("with the MCP server hung, the real head receives POST /api/estop within ~50 ms", async () => {
    let t0 = 0;
    const seen = { at: [] as number[] };
    const headUrl = await stubHead(200, { ok: true }, seen, () => t0);
    const base = await start(hungClient([]), new HeadDirectClient(headUrl));
    t0 = Date.now();
    const r = await fetch(`${base}/api/control/estop`, { method: "POST" });
    expect(seen.at).toHaveLength(1);
    expect(seen.at[0]).toBeLessThan(50);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.pico_confirmed).toBe(true);
    expect(body.agent.message).toMatch(/timed out/);
  });

  // The head sets its latch before the Pico round trip: a 503/504 means
  // latched, Pico unconfirmed -- 200, not a failure.
  it("a head 503/504 answers 200 with ok:true, pico_confirmed:false and the warning", async () => {
    for (const status of [503, 504]) {
      const seen = { at: [] as number[] };
      const headUrl = await stubHead(status, { ok: false, error: "pico link down" }, seen, () => 0);
      const base = await start(upClient([]), new HeadDirectClient(headUrl));
      const r = await fetch(`${base}/api/control/estop`, { method: "POST" });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ ok: true, pico_confirmed: false });
      expect(body.warning).toMatch(new RegExp(`Pico did not confirm.*HTTP ${status} pico link down`));
      server?.close(); headServer?.close(); server = null; headServer = null;
    }
  });

  it("answers 502 with the error text when the head is unreachable", async () => {
    const base = await start(upClient([]), new HeadDirectClient("http://127.0.0.1:1"));
    const r = await fetch(`${base}/api/control/estop`, { method: "POST" });
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/head unreachable at http:\/\/127\.0\.0\.1:1/);
    expect(body.head.ok).toBe(false);
    expect(body.agent.ok).toBe(true);
  });

  it("answers 502 when the answer is not JSON (not the head)", async () => {
    const app = express();
    app.post("/api/estop", (_req, res) => { res.status(200).type("text/html").send("<html>proxy</html>"); });
    await new Promise<void>((r) => { headServer = app.listen(0, "127.0.0.1", r); });
    const headUrl = `http://127.0.0.1:${(headServer!.address() as AddressInfo).port}`;
    const base = await start(upClient([]), new HeadDirectClient(headUrl));
    const r = await fetch(`${base}/api/control/estop`, { method: "POST" });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/not JSON/);
  });
});

describe("POST /api/control/clear_estop", () => {
  it("clears the head and then the daemon's latch", async () => {
    const calls: string[] = [];
    const base = await start(upClient(calls), fakeHead(calls));
    const r = await fetch(`${base}/api/control/clear_estop`, { method: "POST" });
    expect(await r.json()).toEqual({ ok: true, message: "E-STOP cleared" });
    expect(calls).toEqual(["head:clearEstop", "mcp:clearEstop"]);
  });

  it("clears the head with the MCP server down", async () => {
    const calls: string[] = [];
    const base = await start(downClient(calls), fakeHead(calls));
    const body = await (await fetch(`${base}/api/control/clear_estop`, { method: "POST" })).json();
    expect(body.ok).toBe(true);
    expect(body.message).toMatch(/cleared on the head/);
  });

  it("the Auto toggle's control name posts set_agent_armed", async () => {
    const calls: string[] = [];
    const base = await start(upClient(calls), fakeHead(calls));
    const r = await fetch(`${base}/api/control/agent`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }),
    });
    expect(await r.json()).toEqual({ ok: true, message: "agent armed" });
    expect(calls).toEqual(["mcp:setAgentArmed"]);
  });
});
