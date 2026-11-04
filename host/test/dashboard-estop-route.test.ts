import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildControlDeps, registerControlRoutes } from "../src/dashboard/server.js";

type Sources = Parameters<typeof buildControlDeps>[0];

// An MCP client whose every tool call fails, as when the MCP server is down.
// A Proxy so buildControlDeps can bind() any method it likes.
function downClient(calls: string[]): Sources["client"] {
  return new Proxy({}, {
    get: (_t, name) => async () => { calls.push(`mcp:${String(name)}`); throw new Error("fetch failed"); },
  }) as unknown as Sources["client"];
}

function upClient(calls: string[]): Sources["client"] {
  return new Proxy({}, {
    get: (_t, name) => async () => { calls.push(`mcp:${String(name)}`); return "ok"; },
  }) as unknown as Sources["client"];
}

function fakeHead(calls: string[], fail?: string): Sources["head"] {
  return {
    estop: async () => { calls.push("head:estop"); if (fail) throw new Error(fail); },
    clearEstop: async () => { calls.push("head:clearEstop"); if (fail) throw new Error(fail); },
  } as unknown as Sources["head"];
}

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

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
  // Plan Review Focus 3: the dashboard E-STOP must latch the head with the
  // MCP server down.
  it("latches the head directly even when every MCP call throws, and answers 200", async () => {
    const calls: string[] = [];
    const base = await start(downClient(calls), fakeHead(calls));
    const r = await fetch(`${base}/api/control/estop`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.head).toEqual({ ok: true, message: "head E-STOP latched" });
    expect(body.agent.ok).toBe(false);
    expect(body.tracking.ok).toBe(false);
    expect(body.allOk).toBe(false);
    // Order: disarm, stop tracking, then the head.
    expect(calls).toEqual(["mcp:setAgentArmed", "mcp:stopTracking", "head:estop"]);
  });

  it("answers 502 with the head's error text only when the head leg fails", async () => {
    const calls: string[] = [];
    const base = await start(upClient(calls), fakeHead(calls, "head unreachable at http://h:8780: ECONNREFUSED"));
    const r = await fetch(`${base}/api/control/estop`, { method: "POST" });
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.error).toBe("head unreachable at http://h:8780: ECONNREFUSED");
    expect(body.head.ok).toBe(false);
    expect(body.agent.ok).toBe(true);
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
