import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/shared/agent-store.js";

let path: string;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "agent-store-")), "state", "agent.json");
});

describe("AgentStore", () => {
  it("starts disarmed when the file does not exist", () => {
    const s = new AgentStore(path);
    s.load();
    expect(s.get()).toEqual({ armed: false });
  });

  it("round-trips through disk (creating the directory)", () => {
    new AgentStore(path).set(true);
    const b = new AgentStore(path);
    b.load();
    expect(b.get()).toEqual({ armed: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ armed: true });
    b.set(false);
    const c = new AgentStore(path);
    c.load();
    expect(c.get()).toEqual({ armed: false });
  });

  // The safe direction: a damaged state file must never start autonomous motion.
  it("falls back to disarmed on a corrupt or wrong-shaped file rather than throwing", () => {
    const a = new AgentStore(path);
    a.set(true);
    writeFileSync(path, "{ not json");
    const b = new AgentStore(path);
    expect(() => b.load()).not.toThrow();
    expect(b.get()).toEqual({ armed: false });
    writeFileSync(path, JSON.stringify({ armed: "yes" }));
    b.load();
    expect(b.get()).toEqual({ armed: false });
  });

  it("get() returns a copy", () => {
    const s = new AgentStore(path);
    const g = s.get();
    g.armed = true;
    expect(s.get().armed).toBe(false);
  });
});
