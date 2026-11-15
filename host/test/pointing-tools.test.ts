import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FakeHead } from "./fake-head.js";
import { Device } from "../src/shared/device.js";
import { loadConfig } from "../src/shared/config.js";
import { CalibrationStore } from "../src/shared/calibration.js";
import { registerPointingTools } from "../src/mcp/pointing-tools.js";
import type { Mat3 } from "../src/shared/geo/vec3.js";

const PORT = 8807;
let mock: FakeHead | null = null;
let dev: Device | null = null;
const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

async function harness() {
  mock = new FakeHead(); await mock.start({ port: PORT });
  const cfg = loadConfig(undefined, { TB3_HEAD_URL: `http://127.0.0.1:${PORT}` });
  dev = new Device(cfg); dev.start();
  const t0 = Date.now();
  while (!dev.getState().connected && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
  const filepath = `/tmp/tb3-pointingtest-${Math.random().toString(36).slice(2, 9)}.json`;
  const store = new CalibrationStore(filepath); store.load();
  const server = new McpServer({ name: "tb3-mcp", version: "test" });
  registerPointingTools(server, dev, cfg, store);
  const client = new Client({ name: "c", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return { client, store };
}

afterEach(async () => { dev?.close(); dev = null; if (mock) { await mock.stop(); mock = null; } });
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("get_pointing", () => {
  it("reports nulls (not an error) with no orientation", async () => {
    const { client } = await harness();
    const p = JSON.parse(textOf(await client.callTool({ name: "get_pointing", arguments: {} })));
    expect(p.azimuth_deg).toBeNull();
    expect(p.elevation_deg).toBeNull();
    expect(p.source).toBeNull();
    expect(typeof p.pan_deg).toBe("number");
    expect(typeof p.tilt_deg).toBe("number");
  });

  it("reports the boresight az/el under a provisional orientation (identity mount: pan 0 tilt 0 points north, level)", async () => {
    const { client, store } = await harness();
    store.setProvisionalOrientation(IDENTITY, new Date().toISOString());
    const p = JSON.parse(textOf(await client.callTool({ name: "get_pointing", arguments: {} })));
    expect(p.source).toBe("provisional");
    // The fake head rests at pan 0 / tilt 0; identity R maps the mount's
    // +Y (north) boresight straight onto ENU north at the horizon.
    expect(Math.abs(p.azimuth_deg)).toBeLessThan(0.01);
    expect(Math.abs(p.elevation_deg)).toBeLessThan(0.01);
  });

  it("names a solved orientation as calibration", async () => {
    const { client, store } = await harness();
    store.setOrientation(IDENTITY, new Date().toISOString());
    const p = JSON.parse(textOf(await client.callTool({ name: "get_pointing", arguments: {} })));
    expect(p.source).toBe("calibration");
  });
});
