import { describe, it, expect } from "vitest";
import { emergencyStop, runAction, type ControlDeps } from "../src/dashboard/controls.js";

function deps(over: Partial<ControlDeps> = {}): { d: ControlDeps; calls: string[] } {
  const calls: string[] = [];
  const rec = (n: string) => async (...a: unknown[]) => { calls.push(`${n}:${JSON.stringify(a)}`); };
  const d: ControlDeps = {
    track: rec("track"), stopTracking: rec("stopTracking"),
    jog: rec("jog"),
    // Returns the tool's JSON now, not void: runAction relays it so the
    // dashboard can see `clamped` and tell the operator the trim ran out.
    nudgeAimOffset: async (p: number, t: number) => {
      calls.push(`nudgeAimOffset:${JSON.stringify([p, t])}`);
      return '{"offset_pan_deg":0,"offset_tilt_deg":0,"clamped":false}';
    },
    setRigLocation: rec("setRigLocation"), sightLandmark: rec("sightLandmark"),
    sightAircraft: async (hex: string) => { calls.push(`sightAircraft:${JSON.stringify([hex])}`); return `slot 1/2 sighted ${hex}`; },
    solveCalibration: async () => { calls.push("solve"); return "heading 71"; }, clearCalibration: rec("clearCalibration"),
    getTrackSector: async () => { calls.push("getTrackSector:[]"); return { enabled: false, startDeg: 0, endDeg: 360 }; },
    setTrackSector: rec("setTrackSector"),
    getTrackFloor: async () => ({ enabled: false, minElevationDeg: 0 }),
    setTrackFloor: rec("setTrackFloor"),
    setSunGuard: rec("setSunGuard"),
    setAgentArmed: rec("setAgentArmed"),
    headEstop: async () => { calls.push("headEstop:[]"); return { picoConfirmed: true }; },
    headClearEstop: rec("headClearEstop"), mcpClearEstop: rec("mcpClearEstop"),
    home: async () => { calls.push("home:[]"); return "homing tilt"; },
    setPosition: async (p?: number, t?: number) => { calls.push(`setPosition:${JSON.stringify([p ?? null, t ?? null])}`); return "position declared"; },
    referencePan: async () => { calls.push("referencePan:[]"); return "re-referencing pan"; },
    cameraStart: () => { calls.push("cameraStart:[]"); },
    cameraStop: () => { calls.push("cameraStop:[]"); },
    // Previously-unreachable tools (2026-07-28 dashboard-redesign plumbing) --
    // fakes return a message string, same convention as sightAircraft/
    // solveCalibration above (rec() returns void, which doesn't fit these).
    characterizeImu: async () => { calls.push("characterizeImu:[]"); return "rms 0.9"; },
    setNorthZero: async () => { calls.push("setNorthZero:[]"); return "north zero set"; },
    teachLimit: async (edge: string) => { calls.push(`teachLimit:${JSON.stringify([edge])}`); return `taught ${edge}`; },
    clearTaughtLimits: async () => { calls.push("clearTaughtLimits:[]"); return "taught limits cleared"; },
    captureSnapshot: async (icao?: string) => { calls.push(`captureSnapshot:${JSON.stringify([icao])}`); return "snapshot written"; },
    startRecording: async () => { calls.push("startRecording:[]"); return "recording started"; },
    stopRecording: async () => { calls.push("stopRecording:[]"); return "recording stopped"; },
    setCaptureMode: async (enabled: boolean) => { calls.push(`setCaptureMode:${JSON.stringify([enabled])}`); return `auto capture ${enabled ? "enabled" : "disabled"}`; },
    setPolicy: async (rs: unknown) => { calls.push(`setPolicy:${JSON.stringify([rs])}`); return "policy saved (0 enabled rules)"; },
    ...over,
  };
  return { d, calls };
}

describe("emergencyStop", () => {
  // Controller ruling: the head is latched FIRST; a hung MCP must never delay
  // the latch. Then the two daemon legs, best-effort.
  it("latches the head first, then disarms the agent and stops tracking, and reports allOk", async () => {
    const { d, calls } = deps();
    const r = await emergencyStop(d);
    expect(calls[0]).toBe("headEstop:[]");
    expect([...calls].sort()).toEqual(["headEstop:[]", "setAgentArmed:[false]", "stopTracking:[]"]);
    expect(r).toMatchObject({ ok: true, pico_confirmed: true, allOk: true });
    expect(r.warning).toBeUndefined();
    expect(r.head).toEqual({ ok: true, message: "head E-STOP latched" });
  });

  // The field lesson: the E-STOP must not depend on the MCP daemon.
  it("latches the head when every MCP leg throws (daemon down); ok stays true", async () => {
    const { d, calls } = deps({
      setAgentArmed: async () => { throw new Error("fetch failed"); },
      stopTracking: async () => { throw new Error("fetch failed"); },
    });
    const r = await emergencyStop(d);
    expect(calls).toEqual(["headEstop:[]"]);
    expect(r.ok).toBe(true);
    expect(r.agent).toEqual({ ok: false, message: "fetch failed" });
    expect(r.tracking.ok).toBe(false);
    expect(r.allOk).toBe(false);
  });

  it("with the MCP legs hanging, the head is latched at once and the response waits at most one leg budget", async () => {
    const never = () => new Promise<void>(() => {});
    let latchedAt = -1;
    const t0 = Date.now();
    const { d } = deps({
      setAgentArmed: never, stopTracking: never,
      headEstop: async () => { latchedAt = Date.now() - t0; return { picoConfirmed: true }; },
    });
    const r = await emergencyStop(d, 200);
    expect(latchedAt).toBeGreaterThanOrEqual(0);
    expect(latchedAt).toBeLessThan(50);
    expect(Date.now() - t0).toBeLessThan(1000);   // legs run in parallel, one budget
    expect(r.agent.message).toMatch(/timed out/);
    expect(r.tracking.message).toMatch(/timed out/);
    expect(r.ok).toBe(true);
  });

  it("a latched head whose Pico did not confirm is ok, with pico_confirmed false and the warning", async () => {
    const warning = "head E-STOP latched, but the Pico did not confirm the stop (HTTP 503 pico link down) -- check the head";
    const { d } = deps({ headEstop: async () => ({ picoConfirmed: false, warning }) });
    const r = await emergencyStop(d);
    expect(r).toMatchObject({ ok: true, pico_confirmed: false, warning, allOk: false });
    expect(r.head).toEqual({ ok: true, message: warning });
  });

  it("reports a failed head leg (nothing says it latched) without claiming success", async () => {
    const { d } = deps({ headEstop: async () => { throw new Error("head unreachable"); } });
    const r = await emergencyStop(d);
    expect(r.ok).toBe(false);
    expect(r.pico_confirmed).toBe(false);
    expect(r.head).toEqual({ ok: false, message: "head unreachable" });
    expect(r.agent.ok).toBe(true);
    expect(r.allOk).toBe(false);
  });
});

describe("clear_estop", () => {
  it("clears the head, then the daemon best-effort; never re-arms the agent", async () => {
    const { d, calls } = deps();
    const r = await runAction(d, "clear_estop", {});
    expect(r).toEqual({ ok: true, message: "E-STOP cleared" });
    expect(calls).toEqual(["headClearEstop:[]", "mcpClearEstop:[]"]);
  });

  it("succeeds when only the daemon leg fails, and says so", async () => {
    const { d } = deps({ mcpClearEstop: async () => { throw new Error("fetch failed"); } });
    const r = await runAction(d, "clear_estop", {});
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/cleared on the head.*fetch failed/);
  });

  it("fails when the head did not clear (and skips the daemon leg)", async () => {
    const { d, calls } = deps({ headClearEstop: async () => { throw new Error("HTTP 500"); } });
    const r = await runAction(d, "clear_estop", {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/head did not clear E-STOP: HTTP 500/);
    expect(calls).not.toContain("mcpClearEstop:[]");
  });
});

describe("head reference actions", () => {
  it("routes head/home, head/reference-pan, head/set-position (omitted axis stays omitted)", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "head/home", {})).message).toBe("homing tilt");
    expect((await runAction(d, "head/reference-pan", {})).message).toBe("re-referencing pan");
    expect((await runAction(d, "head/set-position", { pan_deg: 12.5 })).ok).toBe(true);
    expect((await runAction(d, "head/set-position", { pan_deg: 0, tilt_deg: -3 })).ok).toBe(true);
    expect(calls).toEqual(["home:[]", "referencePan:[]", "setPosition:[12.5,null]", "setPosition:[0,-3]"]);
  });

  it("head/set-position with neither axis (or non-finite values) is refused without a call", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "head/set-position", {})).ok).toBe(false);
    expect((await runAction(d, "head/set-position", { pan_deg: "12", tilt_deg: null })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a refused tool (e.g. tracking active) comes back as {ok:false} with its text", async () => {
    const { d } = deps({ home: async () => { throw new Error("home: tracking active; stop_tracking first"); } });
    const r = await runAction(d, "head/home", {});
    expect(r).toEqual({ ok: false, message: "home: tracking active; stop_tracking first" });
  });
});

describe("runAction", () => {
  // The Auto toggle keeps its control name; it now flips the armed flag.
  it("agent {on} maps to set_agent_armed", async () => {
    const { d, calls } = deps();
    expect(await runAction(d, "agent", { on: true })).toEqual({ ok: true, message: "agent armed" });
    expect(await runAction(d, "agent", { on: false })).toEqual({ ok: true, message: "agent disarmed" });
    expect(await runAction(d, "agent", {})).toEqual({ ok: true, message: "agent disarmed" });
    expect(calls).toEqual(["setAgentArmed:[true]", "setAgentArmed:[false]", "setAgentArmed:[false]"]);
  });
  it("routes track/stop/agent/jog/calibration", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "track", { hex: "abc" })).ok).toBe(true);
    await runAction(d, "stop", {});
    await runAction(d, "agent", { on: true });
    await runAction(d, "jog", { pan_dps: 5, tilt_dps: 0, duration_ms: 300 });
    await runAction(d, "calibrate/set-location", { lat: 1, lon: 2, height_m: 3 });
    await runAction(d, "calibrate/sight", { lat: 1, lon: 2, height_m: 3, label: "A" });
    const solved = await runAction(d, "calibrate/solve", {});
    expect(solved.message).toMatch(/heading/);
    expect(calls).toContain('track:["abc"]');
    expect(calls).toContain("setAgentArmed:[true]");
    expect(calls).toContain("jog:[5,0,300]");
  });
  it("routes nudge-aim-offset", async () => {
    const { d, calls } = deps();
    const r = await runAction(d, "nudge-aim-offset", { delta_pan_deg: 0.5, delta_tilt_deg: -0.2 });
    expect(r.ok).toBe(true);
    expect(calls).toContain("nudgeAimOffset:[0.5,-0.2]");
  });
  it("routes calibrate/sight-aircraft", async () => {
    const { d, calls } = deps();
    const r = await runAction(d, "calibrate/sight-aircraft", { hex: "A1B2C3" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/sighted a1b2c3/i);
    expect(calls).toContain('sightAircraft:["A1B2C3"]');
  });
  it("calibrate/sight-aircraft without a hex → {ok:false}", async () => {
    const { d } = deps();
    const r = await runAction(d, "calibrate/sight-aircraft", {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/hex/i);
  });
  it("routes camera start/stop", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "camera/start", {})).ok).toBe(true);
    await runAction(d, "camera/stop", {});
    expect(calls).toContain("cameraStart:[]");
    expect(calls).toContain("cameraStop:[]");
  });
  it("unknown action → {ok:false}", async () => {
    const { d } = deps();
    expect((await runAction(d, "explode", {})).ok).toBe(false);
  });
  it("a throwing dep → {ok:false, message}", async () => {
    const { d } = deps({ track: async () => { throw new Error("sun locked"); } });
    const r = await runAction(d, "track", { hex: "x" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/sun locked/);
  });
  it("routes sun-guard/set with a boolean enabled", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "sun-guard/set", { enabled: true })).ok).toBe(true);
    await runAction(d, "sun-guard/set", { enabled: false });
    await runAction(d, "sun-guard/set", {}); // missing → false
    expect(calls).toContain("setSunGuard:[true]");
    expect(calls).toContain("setSunGuard:[false]");
    expect(calls.filter((c) => c === "setSunGuard:[false]").length).toBe(2);
  });

  // Previously the dashboard had no transport at all for these tools (the
  // operator asked how to trigger teach_limit from the UI and the
  // answer was "you can't") -- this pins that every one of them is now a
  // real ControlDeps method AND routed through runAction.
  it("exposes a control for every tool the redesign needs", () => {
    const { d } = deps();
    for (const k of ["characterizeImu", "setNorthZero", "teachLimit", "clearTaughtLimits",
                     "captureSnapshot", "startRecording", "stopRecording", "setCaptureMode"]) {
      expect(typeof (d as unknown as Record<string, unknown>)[k]).toBe("function");
    }
  });

  it("teachLimit passes the edge through unchanged", async () => {
    const seen: string[] = [];
    const { d } = deps({ teachLimit: async (e: string) => { seen.push(e); return "ok"; } });
    await d.teachLimit("pan_max");
    expect(seen).toEqual(["pan_max"]);
  });

  it("routes calibrate/characterize-imu, calibrate/set-north-zero", async () => {
    const { d, calls } = deps();
    expect((await runAction(d, "calibrate/characterize-imu", {})).message).toMatch(/rms/);
    expect((await runAction(d, "calibrate/set-north-zero", {})).message).toMatch(/north zero/);
    expect(calls).toContain("characterizeImu:[]");
    expect(calls).toContain("setNorthZero:[]");
  });

  it("routes limits/teach with an edge, and limits/clear-taught", async () => {
    const { d, calls } = deps();
    const r = await runAction(d, "limits/teach", { edge: "pan_max" });
    expect(r.ok).toBe(true);
    expect(calls).toContain('teachLimit:["pan_max"]');
    await runAction(d, "limits/clear-taught", {});
    expect(calls).toContain("clearTaughtLimits:[]");
  });

  it("limits/teach without an edge → {ok:false}", async () => {
    const { d } = deps();
    const r = await runAction(d, "limits/teach", {});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/edge/i);
  });

  it("routes capture/snapshot (with and without an icao), capture/start-recording, capture/stop-recording", async () => {
    const { d, calls } = deps();
    await runAction(d, "capture/snapshot", { icao: "A1B2C3" });
    await runAction(d, "capture/snapshot", {});
    await runAction(d, "capture/start-recording", {});
    await runAction(d, "capture/stop-recording", {});
    expect(calls).toContain('captureSnapshot:["A1B2C3"]');
    expect(calls).toContain("captureSnapshot:[null]"); // no icao -> JSON.stringify([undefined]) === "[null]"
    expect(calls).toContain("startRecording:[]");
    expect(calls).toContain("stopRecording:[]");
  });

  // Review fix, finding I-3: set_capture_mode (src/tools.ts) had no dashboard
  // transport at all -- it's the only thing that flips captureAutoEnabled,
  // which the dashboard could otherwise display but never change.
  it("routes capture/set-mode with a boolean enabled", async () => {
    const { d, calls } = deps();
    const r = await runAction(d, "capture/set-mode", { enabled: true });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/enabled/i);
    await runAction(d, "capture/set-mode", { enabled: false });
    await runAction(d, "capture/set-mode", {}); // missing -> false
    expect(calls).toContain("setCaptureMode:[true]");
    expect(calls).toContain("setCaptureMode:[false]");
    expect(calls.filter((c) => c === "setCaptureMode:[false]").length).toBe(2);
  });

  it("policy/set forwards the ruleset to the daemon", async () => {
    let got: unknown = null;
    const { d } = deps({ setPolicy: async (rs: unknown) => { got = rs; return "policy saved (1 rule)"; } });
    const rs = { version: 1, rules: [
      { id: "a", name: "A", enabled: true, canPreempt: false, conditions: [] },
    ] };
    const r = await runAction(d, "policy/set", { ruleset: rs });
    expect(r.ok).toBe(true);
    expect(got).toEqual(rs);
  });

  it("policy/set rejects a malformed ruleset rather than persisting it", async () => {
    const { d } = deps({ setPolicy: async () => { throw new Error("invalid ruleset"); } });
    const r = await runAction(d, "policy/set", { ruleset: { version: 9, rules: "nope" } });
    expect(r.ok).toBe(false);
  });
});
