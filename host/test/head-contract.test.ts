// The host's view of the head API, pinned to the head's own contract:
// docs/HEAD-API.md (tagged examples) and docs/head-api/schemas (JSON Schema
// 2020-12, validated against the live head by head/tests/test_contract.py).
// If the head changes a message shape, this file fails before the Device
// client silently drops the new message.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type { ZodTypeAny } from "zod";
import { FakeHead, headSchemaValidator, HEAD_API_DOC } from "./fake-head.js";
import {
  HeadTickZ, HeadEventZ, HeadGotoZ, HeadTrackZ, HeadJogZ, HeadSetposZ,
  HeadConfigSetZ, HeadImuBurstZ,
} from "../src/shared/head-types.js";

const ZOD: Record<string, ZodTypeAny> = {
  tick: HeadTickZ,
  event: HeadEventZ,
  goto: HeadGotoZ,
  track: HeadTrackZ,
  jog: HeadJogZ,
  setpos: HeadSetposZ,
  "config-set": HeadConfigSetZ,
  "imu-burst": HeadImuBurstZ,
};

function taggedExamples(): Array<{ schema: string; json: unknown; text: string }> {
  const md = readFileSync(HEAD_API_DOC, "utf8");
  const out: Array<{ schema: string; json: unknown; text: string }> = [];
  const fence = /```json ([a-z-]+)\n([\s\S]*?)```/g;
  for (let m = fence.exec(md); m; m = fence.exec(md)) {
    out.push({ schema: m[1], json: JSON.parse(m[2]), text: m[2] });
  }
  return out;
}

let head: FakeHead | null = null;
afterEach(async () => { if (head) { await head.stop(); head = null; } });

describe("head API contract", () => {
  it("HeadTickZ accepts every example in docs/HEAD-API.md", () => {
    const examples = taggedExamples();
    // Guard against a regex that silently matches nothing.
    expect(examples.filter((e) => e.schema === "tick").length).toBeGreaterThanOrEqual(2);
    expect(examples.filter((e) => e.schema === "event").length).toBeGreaterThanOrEqual(14);
    const validate = headSchemaValidator();
    for (const ex of examples) {
      const z = ZOD[ex.schema];
      expect(z, `no zod mirror for schema "${ex.schema}"`).toBeDefined();
      const r = z.safeParse(ex.json);
      expect(r.success, `${ex.schema}: ${ex.text}\n${r.success ? "" : r.error.message}`).toBe(true);
      // ...and the JSON Schema agrees, so the mirror is checked against the same examples.
      expect(validate(ex.schema, ex.json), `${ex.schema} (ajv): ${ex.text}`).toEqual([]);
    }
  });

  it("the zod mirrors reject what the JSON Schemas reject", () => {
    const validate = headSchemaValidator();
    const tick = taggedExamples().find((e) => e.schema === "tick")!.json as Record<string, unknown>;
    const bad: Array<[string, unknown]> = [
      ["tick", { ...tick, extra: 1 }],
      ["tick", { ...tick, axes: { ...(tick.axes as object), pan: { pos: 1 } } }],
      ["tick", { ...tick, ref: { pan: "gps", persisted: true, ageS: null, frameId: null } }],
      ["tick", { ...tick, t: 1.5 }],
      ["tick", { ...tick, imu: { ...(tick.imu as object), cal: { sys: 4, gyr: 0, acc: 0, mag: 0 } } }],
      ["event", { type: "event", t: 1, name: "homed", axis: null, detail: null }],
      ["event", { type: "event", t: 1, name: "estop", axis: null, detail: "x" }],
      ["event", { type: "event", t: 1, name: "pan_reference", axis: null, detail: { source: "imu", pan: 1 } }],
      // A rename's only reason is "restored"; anything else is outside the contract.
      ["event", { type: "event", t: 1, name: "pan_reference", axis: null, detail: { source: "imu", pan: 1, previous: null, frameId: "3f9c2a1b7d4e6f80", reason: "bored" } }],
      // A rename must name its frame.
      ["event", { type: "event", t: 1, name: "pan_reference", axis: null, detail: { source: "imu", pan: 1, previous: null } }],
      ["tick", { ...tick, ref: { pan: "imu", persisted: true, ageS: 1 } }],
      // ref is strict: the old host-side timestamp identity is not a head field.
      ["tick", { ...tick, ref: { ...(tick.ref as object), setAtMs: 1 } }],
      ["event", { type: "event", t: 1, name: "pan_reference", axis: null, detail: { source: "none", reason: "bored" } }],
      ["event", { type: "event", t: 1, name: "config", axis: null, detail: { scope: "pan", key: "vmax", value: 1, x: 1 } }],
      ["event", { type: "event", t: 1, name: "made_up", axis: null, detail: null }],
      ["goto", {}],
      ["goto", { pan: 1, roll: 2 }],
      ["track", { zoom: { pos: 1, vel: 0 } }],
      ["track", { pan: { pos: 1 } }],
      ["jog", { pan: "5" }],
      ["setpos", {}],
      ["config-set", { scope: "pan key", key: "vmax", value: 1 }],
      ["imu-burst", { n: 0, samples: [] }],
    ];
    for (const [schema, json] of bad) {
      expect(validate(schema, json).length, `ajv should reject ${schema} ${JSON.stringify(json)}`).toBeGreaterThan(0);
      expect(ZOD[schema].safeParse(json).success, `zod should reject ${schema} ${JSON.stringify(json)}`).toBe(false);
    }
  });

  it("FakeHead ticks and events validate against docs/head-api/schemas", async () => {
    head = new FakeHead();
    await head.start({ tickMs: 0 });
    const validate = headSchemaValidator();
    const got: unknown[] = [];
    const ws = new WebSocket(head.url.replace(/^http/, "ws") + "/ws");
    ws.on("message", (b) => got.push(JSON.parse(b.toString())));
    await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });

    head.tick();
    head.model.imu = { ok: false, heading: null, pitch: null, roll: null, cal: null, tempC: null };
    head.model.link.imu = false;
    head.tick();
    head.model.link.pico = false;
    head.tick(); // follows the model: no axes while the Pico link is down
    head.tickNoAxes();
    head.emitEvent({ type: "event", t: 1, name: "homed", axis: "tilt", detail: null });
    head.emitEvent({ type: "event", t: 2, name: "driver_fault", axis: "pan", detail: "drv_status=0x2" });
    head.emitEvent({ type: "event", t: 3, name: "pico_link", axis: null, detail: { up: false } });
    head.model.link.pico = true;
    head.setConfig("tilt", { vmax: 7 }); // publishes a config event
    await fetch(`${head.url}/api/estop`, { method: "POST" });
    await fetch(`${head.url}/api/estop/clear`, { method: "POST" });
    await fetch(`${head.url}/api/setpos`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pan: 3 }),
    });
    const state = await (await fetch(`${head.url}/api/state`)).json();
    const config = await (await fetch(`${head.url}/api/config`)).json();
    head.model.imu = { ok: true, heading: 1, pitch: 2, roll: 3, cal: { sys: 3, gyr: 3, acc: 3, mag: 3 }, tempC: 25 };
    const burst = await (await fetch(`${head.url}/api/imu?n=3`)).json();

    const expectEvents = ["homed", "driver_fault", "pico_link", "config", "estop", "estop_cleared", "pan_reference"];
    const deadline = Date.now() + 2000;
    const names = () => got.filter((m) => (m as { type: string }).type === "event").map((m) => (m as { name: string }).name);
    while (expectEvents.some((n) => !names().includes(n)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    ws.close();

    expect(names()).toEqual(expectEvents);
    const ticks = got.filter((m) => (m as { type: string }).type === "tick") as Array<Record<string, unknown>>;
    expect(ticks.length).toBe(5); // on-connect + four published
    expect(ticks.filter((t) => t.axes === undefined).length).toBe(2);
    for (const m of got) {
      const kind = (m as { type: string }).type;
      expect(validate(kind, m), JSON.stringify(m)).toEqual([]);
      expect(ZOD[kind].safeParse(m).success, JSON.stringify(m)).toBe(true);
    }
    expect(validate("tick", state)).toEqual([]);
    expect(validate("imu-burst", burst)).toEqual([]);
    expect(burst.n).toBe(3);
    expect(Object.keys(config).sort()).toEqual(["focus", "global", "head", "pan", "tilt", "zoom"]);
    expect(config.tilt.vmax).toBe(7);

    // FakeHead refuses to publish something the real head never would.
    expect(() => head!.emitEvent({ type: "event", t: 1, name: "estop", axis: "pan", detail: null })).toThrow(/schema/);
  });
});
