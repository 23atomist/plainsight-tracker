import { describe, it, expect } from "vitest";
import { destructiveConfirm } from "../dashboard/public/procedures.js";

describe("destructiveConfirm", () => {
  it("requires confirmation for clearing taught limits, naming what is lost", () => {
    const r = destructiveConfirm("clear_taught_limits", {});
    expect(r.needed).toBe(true);
    expect(r.message).toMatch(/every taught travel-limit edge/i);
  });

  it("does not gate a harmless action", () => {
    expect(destructiveConfirm("teach_limit", {}).needed).toBe(false);
  });

  // The head reference procedures replace the retired ESP32 home-zeroing
  // tool, which cleared calibration and taught limits. None of these clears
  // anything (a pan re-reference shifts them by the delta), so none needs a
  // destructive confirmation.
  it("does not gate the head reference procedures", () => {
    for (const a of ["home", "set_position", "reference_pan"]) {
      expect(destructiveConfirm(a, { calibration: { calibrated: true } }).needed).toBe(false);
    }
  });
});

// Smaller-items fix: "Sighting [redo] is destructive and mislabelled" --
// addSighting's `[...sightings, s].slice(-2)` (src/calibration.ts, untouched
// by this fix) discards the OLDEST recorded sighting on any third call, no
// matter which slot's [redo] was clicked, and once both slots are filled
// also clears an already-completed solve. `resight-sight-1`/`resight-sight-2`
// share the exact same confirmation (the real store behaviour doesn't
// actually depend on which slot's redo was clicked -- see procedure-
// actions.js's redoStep for the dispatch side).
describe("destructiveConfirm -- sighting redo (resight-sight-1 / resight-sight-2)", () => {
  it("needs no confirmation when fewer than 2 sightings exist yet -- nothing is discarded", () => {
    expect(destructiveConfirm("resight-sight-1", { calibration: { sightings: [{ label: "A" }] } }).needed).toBe(false);
    expect(destructiveConfirm("resight-sight-1", { calibration: { sightings: [] } }).needed).toBe(false);
    expect(destructiveConfirm("resight-sight-1", {}).needed).toBe(false);
  });

  it("requires confirmation once both slots are filled, naming the OLDER sighting as what's discarded", () => {
    const r = destructiveConfirm("resight-sight-2", {
      calibration: { sightings: [{ label: "UAL123" }, { label: "AAL456" }], calibrated: false },
    });
    expect(r.needed).toBe(true);
    expect(r.message).toContain("UAL123");
    expect(r.message).toMatch(/older/i);
  });

  it("says the same thing regardless of which slot's redo was clicked -- the actual store behaviour doesn't distinguish them", () => {
    const state = { calibration: { sightings: [{ label: "UAL123" }, { label: "AAL456" }], calibrated: false } };
    const m1 = destructiveConfirm("resight-sight-1", state).message;
    const m2 = destructiveConfirm("resight-sight-2", state).message;
    expect(m1).toBe(m2);
  });

  it("also warns that a completed solve is discarded, only when one actually exists", () => {
    const withSolve = destructiveConfirm("resight-sight-2", {
      calibration: { sightings: [{ label: "A" }, { label: "B" }], calibrated: true },
    }).message;
    expect(withSolve).toMatch(/solve/i);

    const withoutSolve = destructiveConfirm("resight-sight-2", {
      calibration: { sightings: [{ label: "A" }, { label: "B" }], calibrated: false },
    }).message;
    expect(withoutSolve).not.toMatch(/solve/i);
  });

  it("falls back to a generic label when the older sighting has none", () => {
    const m = destructiveConfirm("resight-sight-2", {
      calibration: { sightings: [{}, { label: "B" }], calibrated: false },
    }).message;
    expect(m).toMatch(/older sighting/i);
  });
});
