import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpDashboardClient } from "../src/dashboard/client.js";
import { text } from "../src/mcp/tool-helpers.js";

// McpDashboardClient.connect() hardcodes a StreamableHTTPClientTransport (real
// HTTP), but its private `client` is a plain MCP SDK Client -- for this test
// we bypass connect() entirely and hand that Client the OTHER end of an
// InMemoryTransport pair, same fake-daemon pattern every tools/geo-tools/
// server test in this repo already uses (McpServer + InMemoryTransport.
// createLinkedPair()), just pointed at the dashboard's own client class
// instead of the raw SDK Client directly. No new dependencies, no network.
async function connectFakeDaemon(dash: McpDashboardClient, calibrationResponse: unknown): Promise<void> {
  const server = new McpServer({ name: "fake-daemon", version: "test" });
  server.registerTool(
    "get_calibration",
    { description: "fake", inputSchema: {} },
    async () => text(JSON.stringify(calibrationResponse)),
  );
  const sdkClient = (dash as unknown as { client: { connect(t: unknown): Promise<void> } }).client;
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), sdkClient.connect(c)]);
}

// Regression pin for the 2026-07-28 dashboard-redesign blocker: this
// snake_case (wire) <-> camelCase (DashboardState) boundary is the sharp
// edge -- the wire says imu_mounting.rms_deg, the UI reads
// imuMounting.rmsDeg, and CalibrationRawZ silently drops anything it doesn't
// recognize (see the module comment atop client.ts) rather than failing
// loudly, so a renamed/misspelled key here would NOT throw; it would just
// make hasImu permanently false again downstream, reproducing the original
// bug with no compile error and no obviously-failing test -- until this one.
describe("McpDashboardClient.getCalibration — imu_mounting -> imuMounting mapping", () => {
  it("maps imu_mounting.rms_deg -> imuMounting.rmsDeg", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemon(dash, {
      calibrated: false, rig: null, sightings: [], solved_at: null, provisional: false,
      imu_mounting: { rms_deg: 1.4 },
    });
    const cal = await dash.getCalibration();
    expect(cal.imuMounting).toEqual({ rmsDeg: 1.4 });
  });

  it("maps an explicit null imu_mounting -> null (before characterize_imu has run)", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemon(dash, {
      calibrated: false, rig: null, sightings: [], solved_at: null, provisional: false,
      imu_mounting: null,
    });
    const cal = await dash.getCalibration();
    expect(cal.imuMounting).toBeNull();
  });

  it("tolerates an older daemon that omits imu_mounting entirely -> null", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemon(dash, {
      calibrated: false, rig: null, sightings: [], solved_at: null, provisional: false,
      // imu_mounting key entirely absent -- pre-this-feature daemon shape.
    });
    const cal = await dash.getCalibration();
    expect(cal.imuMounting).toBeNull();
  });
});

// Same fake-daemon technique as connectFakeDaemon above, generalized to an
// arbitrary tool name -- get_taught_limits here, rather than get_calibration.
async function connectFakeDaemonTool(dash: McpDashboardClient, toolName: string, response: unknown): Promise<void> {
  const server = new McpServer({ name: "fake-daemon", version: "test" });
  server.registerTool(toolName, { description: "fake", inputSchema: {} }, async () => text(JSON.stringify(response)));
  const sdkClient = (dash as unknown as { client: { connect(t: unknown): Promise<void> } }).client;
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), sdkClient.connect(c)]);
}

// Review fix, UI-9 fix round, finding I-2: getTaughtLimits() reads the
// SAME get_taught_limits response getLimits() already parses, but its OWN
// `taught` object (per-edge, null until actually captured) rather than
// `effective` -- see state.ts's TaughtLimits for why this is a second
// client method instead of reshaping getLimits()'s existing, working
// return type.
describe("McpDashboardClient.getTaughtLimits -- get_taught_limits's `taught` object -> TaughtLimits", () => {
  it("maps a real captured edge through, leaving the rest null", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemonTool(dash, "get_taught_limits", {
      taught: { pan_min: null, pan_max: 12.5, tilt_min: null, tilt_max: null },
      config_ceiling: { pan_min: -170, pan_max: 170, tilt_min: -10, tilt_max: 80 },
      effective: { pan_min: -170, pan_max: 12.5, tilt_min: -10, tilt_max: 80 },
    });
    const t = await dash.getTaughtLimits();
    expect(t).toEqual({ panMinDeg: null, panMaxDeg: 12.5, tiltMinDeg: null, tiltMaxDeg: null });
  });

  it("maps every-edge-untaught (all null) through, distinct from a real 0-valued capture", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    await connectFakeDaemonTool(dash, "get_taught_limits", {
      taught: { pan_min: null, pan_max: null, tilt_min: null, tilt_max: null },
      config_ceiling: { pan_min: -170, pan_max: 170, tilt_min: -10, tilt_max: 80 },
      effective: { pan_min: -170, pan_max: 170, tilt_min: -10, tilt_max: 80 },
    });
    const t = await dash.getTaughtLimits();
    expect(t).toEqual({ panMinDeg: null, panMaxDeg: null, tiltMinDeg: null, tiltMaxDeg: null });
  });
});

// Review fix, finding I-3: set_capture_mode had a tool but no dashboard
// client method at all -- pins that McpDashboardClient.setCaptureMode
// actually reaches the real MCP tool with the `enabled` argument, not just
// that ControlDeps/runAction (test/dashboard-controls.test.ts) route to a
// fake.
describe("McpDashboardClient.setCaptureMode", () => {
  it("reaches set_capture_mode with the enabled argument", async () => {
    const dash = new McpDashboardClient("http://unused/mcp");
    const server = new McpServer({ name: "fake-daemon", version: "test" });
    const seen: unknown[] = [];
    server.registerTool(
      "set_capture_mode",
      { description: "fake", inputSchema: { enabled: z.boolean() } },
      async ({ enabled }: { enabled: boolean }) => {
        seen.push(enabled);
        return text(`auto capture ${enabled ? "enabled" : "disabled"}`);
      },
    );
    const sdkClient = (dash as unknown as { client: { connect(t: unknown): Promise<void> } }).client;
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), sdkClient.connect(c)]);

    const msg = await dash.setCaptureMode(true);
    expect(seen).toEqual([true]);
    expect(msg).toMatch(/enabled/i);
  });
});

// Task 8: the agent armed flag, the daemon-side E-STOP legs, the head
// reference procedures, and the tracking automation gates -- each pinned
// against a real McpServer so the tool names and argument shapes are real.
describe("McpDashboardClient -- armed flag, E-STOP legs, head procedures", () => {
  async function wired() {
    const dash = new McpDashboardClient("http://unused/mcp");
    const server = new McpServer({ name: "fake-daemon", version: "test" });
    const seen: Array<[string, unknown]> = [];
    let armed = false;
    server.registerTool("get_agent_armed", { description: "f", inputSchema: {} },
      async () => text(JSON.stringify({ armed })));
    server.registerTool("set_agent_armed", { description: "f", inputSchema: { armed: z.boolean() } },
      async ({ armed: a }: { armed: boolean }) => { seen.push(["set_agent_armed", a]); armed = a; return text("{}"); });
    for (const name of ["estop", "clear_estop", "reference_pan"]) {
      server.registerTool(name, { description: "f", inputSchema: {} },
        async () => { seen.push([name, {}]); return text(`${name} ok`); });
    }
    server.registerTool("home", { description: "f", inputSchema: { axes: z.array(z.string()).optional() } },
      async (a: unknown) => { seen.push(["home", a]); return text("homing tilt"); });
    server.registerTool("set_position",
      { description: "f", inputSchema: { pan_deg: z.number().optional(), tilt_deg: z.number().optional() } },
      async (a: unknown) => { seen.push(["set_position", a]); return text("position declared"); });
    server.registerTool("get_tracking_status", { description: "f", inputSchema: {} }, async () => text(JSON.stringify({
      state: "waiting", label: null, target_azimuth_deg: null, target_elevation_deg: null, target_range_m: null,
      pointing_error_deg: null, pan_limited: false, tilt_limited: false, pan_referenced: true, calibration_verified: false,
    })));
    const sdkClient = (dash as unknown as { client: { connect(t: unknown): Promise<void> } }).client;
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), sdkClient.connect(c)]);
    return { dash, seen };
  }

  it("reads and writes the armed flag", async () => {
    const { dash, seen } = await wired();
    expect(await dash.getAgentArmed()).toBe(false);
    await dash.setAgentArmed(true);
    expect(await dash.getAgentArmed()).toBe(true);
    expect(seen).toEqual([["set_agent_armed", true]]);
  });

  it("calls estop, clear_estop, home, set_position and reference_pan with their real argument shapes", async () => {
    const { dash, seen } = await wired();
    await dash.estop();
    await dash.clearEstop();
    expect(await dash.home()).toBe("homing tilt");
    await dash.setPosition(12.5, undefined);
    await dash.setPosition(undefined, -2);
    expect(await dash.referencePan()).toBe("reference_pan ok");
    expect(seen).toEqual([
      ["estop", {}], ["clear_estop", {}], ["home", { axes: ["tilt"] }],
      ["set_position", { pan_deg: 12.5 }], ["set_position", { tilt_deg: -2 }], ["reference_pan", {}],
    ]);
  });

  it("getTrackingStatus carries pan_referenced and calibration_verified", async () => {
    const { dash } = await wired();
    const t = await dash.getTrackingStatus();
    expect(t.pan_referenced).toBe(true);
    expect(t.calibration_verified).toBe(false);
  });

  // The dashboard can start before the MCP server; its startup connect then
  // fails and the SDK client says "Not connected" forever unless a call
  // reconnects. The reconnect is attempted (and here fails: nothing listens).
  it("a call on a never-connected client attempts a reconnect instead of failing 'Not connected' forever", async () => {
    const dash = new McpDashboardClient("http://127.0.0.1:1/mcp");
    await expect(dash.getAgentArmed()).rejects.toThrow();
    await expect(dash.getAgentArmed()).rejects.not.toThrow(/^Not connected$/);
  });
});
