import { describe, it, expect } from "vitest";
import { WIDGET_IDS, loadVisibility, saveVisibility, applyVisibility, toggleVisibility } from "../dashboard/public/widgets.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, dump: () => Object.fromEntries(m) };
}

describe("widgets -- visibility persistence", () => {
  it("defaults every widget to visible", () => {
    expect(loadVisibility(fakeStorage())).toEqual({ rig: true, trim: true, tracking: true });
    expect(WIDGET_IDS).toEqual(["rig", "trim", "tracking"]);
  });
  it("round-trips through storage and ignores junk", () => {
    const st = fakeStorage();
    saveVisibility(st, { rig: false, trim: true, tracking: false });
    expect(loadVisibility(st)).toEqual({ rig: false, trim: true, tracking: false });
    expect(loadVisibility(fakeStorage({ "tb3.widgets": "{not json" }))).toEqual({ rig: true, trim: true, tracking: true });
    expect(loadVisibility(fakeStorage({ "tb3.widgets": JSON.stringify({ rig: false, bogus: 1 }) }))).toEqual({ rig: false, trim: true, tracking: true });
  });
  it("survives a storage that throws (private mode)", () => {
    const boom = { getItem: () => { throw new Error("nope"); }, setItem: () => { throw new Error("nope"); } };
    expect(loadVisibility(boom)).toEqual({ rig: true, trim: true, tracking: true });
    expect(() => saveVisibility(boom, { rig: false, trim: true, tracking: true })).not.toThrow();
  });
  it("toggleVisibility returns a new object, never mutating the old one", () => {
    const a = { rig: true, trim: true, tracking: true };
    const b = toggleVisibility(a, "trim");
    expect(b).toEqual({ rig: true, trim: false, tracking: true });
    expect(a.trim).toBe(true);
  });
  it("applyVisibility hides the cards and presses the rail buttons", () => {
    const cards: Record<string, { hidden: boolean }> = { rig: { hidden: false }, trim: { hidden: false }, tracking: { hidden: false } };
    const buttons: Record<string, { pressed: string | null; classes: Set<string> }> = {};
    for (const id of WIDGET_IDS) buttons[id] = { pressed: null, classes: new Set() };
    const root = { querySelector: (sel: string) => { const m = sel.match(/data-widget="(\w+)"/); return m ? cards[m[1]] : null; } };
    const rail = { querySelector: (sel: string) => {
      const m = sel.match(/data-widget-toggle="(\w+)"/);
      if (!m) return null;
      const b = buttons[m[1]];
      return { setAttribute: (_k: string, v: string) => { b.pressed = v; }, classList: { toggle: (c: string, on: boolean) => { if (on) b.classes.add(c); else b.classes.delete(c); } } };
    } };
    applyVisibility(root, rail, { rig: true, trim: false, tracking: true });
    expect(cards.trim.hidden).toBe(true);
    expect(cards.rig.hidden).toBe(false);
    expect(buttons.trim.pressed).toBe("false");
    expect(buttons.rig.pressed).toBe("true");
    expect(buttons.rig.classes.has("rail-on")).toBe(true);
    expect(buttons.trim.classes.has("rail-on")).toBe(false);
  });
});
