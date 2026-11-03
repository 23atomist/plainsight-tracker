import { describe, it, expect } from "vitest";
import { resultText, parseTrackingStatus } from "../src/agent/mcp-client.js";

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
  const body = { state: "waiting", reason: "pan_unreferenced", label: null, pointing_error_deg: null };

  it("reads pan_referenced into panReferenced", () => {
    expect(parseTrackingStatus(JSON.stringify({ ...body, pan_referenced: false, calibration_verified: true })))
      .toEqual({ state: "waiting", label: null, pointingErrorDeg: null, panReferenced: false, calibrationVerified: true });
    expect(parseTrackingStatus(JSON.stringify({ ...body, pan_referenced: true, calibration_verified: false })))
      .toMatchObject({ panReferenced: true, calibrationVerified: false });
  });

  // Fail closed: a status that does not say the rig is referenced must never
  // be read as permission to move it.
  it("rejects a status without pan_referenced or calibration_verified", () => {
    expect(() => parseTrackingStatus(JSON.stringify({ ...body, calibration_verified: true }))).toThrow();
    expect(() => parseTrackingStatus(JSON.stringify({ ...body, pan_referenced: true }))).toThrow();
  });
});
