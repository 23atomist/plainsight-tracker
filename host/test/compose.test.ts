import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type Svc = {
  image?: string;
  network_mode?: string;
  profiles?: string[];
  volumes?: { target: string }[];
  environment?: Record<string, string>;
  devices?: unknown[];
  device_cgroup_rules?: string[];
};

function render(): Record<string, Svc> {
  const out = execFileSync(
    "docker",
    ["compose", "--env-file", ".env.example", "--profile", "*", "config", "--format", "json"],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(out).services;
}

describe("compose.yaml", () => {
  const services = render();

  it("defines every service", () => {
    for (const name of ["mcp", "agent", "dashboard", "mediamtx", "adsb", "readsb-pluto", "gpsd", "detector"]) {
      expect(services[name], name).toBeDefined();
    }
  });

  it("uses host networking for the Node services", () => {
    expect(services.mcp.network_mode).toBe("host");
  });

  it("gates optional services behind profiles", () => {
    expect(services.adsb.profiles).toContain("adsb");
    expect(services["readsb-pluto"].profiles).toContain("adsb");
    expect(services.gpsd.profiles).toContain("gps");
    expect(services.detector.profiles).toContain("vision");
  });

  it("mounts /config in every plainsight-host service", () => {
    const hosts = Object.entries(services).filter(([, s]) => s.image === "plainsight-host");
    expect(hosts.map(([n]) => n).sort()).toEqual(["agent", "dashboard", "mcp"]);
    for (const [name, s] of hosts) {
      expect(s.volumes?.some((v) => v.target === "/config"), name).toBe(true);
    }
  });

  it("runs ultrafeeder without an SDR, fed by readsb-pluto", () => {
    const env = services.adsb.environment ?? {};
    expect(env.READSB_DEVICE_TYPE).toBeUndefined();
    expect(env.READSB_NET_CONNECTOR).toBe("127.0.0.1,31005,beast_in");
    expect(services.adsb.device_cgroup_rules).toBeUndefined();
    expect(services["readsb-pluto"].device_cgroup_rules).toContain("c 189:* rwm");
  });
});
