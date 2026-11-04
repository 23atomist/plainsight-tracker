import { describe, it, expect } from "vitest";
import { resultText, parseTrackingStatus, parseAgentArmed } from "../src/agent/mcp-client.js";

describe("resultText", () => {
  it("returns the text of a success result", () => {
    const result = { content: [{ type: "text", text: '{"aircraft":[]}' }] };
    expect(resultText("scan_aircraft", result)).toBe('{"aircraft":[]}');
  });

  it("throws on an error result, including the tool name and daemon text", () => {
    const result = {
      content: [{ type: "text", text: "sun guard active near solar keep-out zone" }],
      isError: true,
    };
    expect(() => resultText("track_aircraft", result)).toThrow(
      /track_aircraft.*sun guard active near solar keep-out zone/,
    );
  });

  it("throws when there is no text content", () => {
    const result = { content: [{ type: "image", data: "..." }] };
    expect(() => resultText("get_tracking_status", result)).toThrow(
      /get_tracking_status.*no text content/,
    );
  });
});

describe("parseTrackingStatus", () => {
  const body = { state: "waiting", reason: "pan_unreferenced", label: null, pointing_error_deg: null, estop: false, pan_limits_verified: true };

  it("reads pan_referenced into panReferenced", () => {
    expect(parseTrackingStatus(JSON.stringify({ ...body, pan_referenced: false, calibration_verified: true })))
      .toEqual({ state: "waiting", label: null, pointingErrorDeg: null, estop: false, panReferenced: false,
        calibrationVerified: true, panLimitsVerified: true });
    expect(parseTrackingStatus(JSON.stringify({ ...body, pan_referenced: true, calibration_verified: false })))
      .toMatchObject({ panReferenced: true, calibrationVerified: false });
  });

  // Fail closed: a status that does not say the rig is referenced must never
  // be read as permission to move it.
  it("rejects a status without pan_referenced or calibration_verified", () => {
    expect(() => parseTrackingStatus(JSON.stringify({ ...body, calibration_verified: true }))).toThrow();
    expect(() => parseTrackingStatus(JSON.stringify({ ...body, pan_referenced: true }))).toThrow();
  });

  it("reads pan_limits_verified, and rejects a status that does not carry it", () => {
    const ok = { ...body, pan_referenced: true, calibration_verified: true };
    expect(parseTrackingStatus(JSON.stringify({ ...ok, pan_limits_verified: false }))).toMatchObject({ panLimitsVerified: false });
    const { pan_limits_verified: _omit, ...without } = ok;
    expect(() => parseTrackingStatus(JSON.stringify(without))).toThrow();
  });

  it("reads estop, and rejects a status that does not carry it", () => {
    const ok = { ...body, pan_referenced: true, calibration_verified: true };
    expect(parseTrackingStatus(JSON.stringify({ ...ok, estop: true }))).toMatchObject({ estop: true });
    const { estop: _omit, ...noEstop } = ok;
    expect(() => parseTrackingStatus(JSON.stringify(noEstop))).toThrow();
  });
});

describe("parseAgentArmed", () => {
  it("reads the armed flag", () => {
    expect(parseAgentArmed(JSON.stringify({ armed: true }))).toBe(true);
    expect(parseAgentArmed(JSON.stringify({ armed: false }))).toBe(false);
  });

  // Fail closed: an answer that does not say "armed" must never be read as armed.
  it("rejects a body without a boolean armed", () => {
    expect(() => parseAgentArmed(JSON.stringify({}))).toThrow();
    expect(() => parseAgentArmed(JSON.stringify({ armed: "true" }))).toThrow();
  });
});
