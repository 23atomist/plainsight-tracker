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
  user?: string;
  group_add?: unknown[];
  command?: string[];
  healthcheck?: { test: string[] };
  depends_on?: Record<string, { condition?: string }>;
};

const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function render(): Record<string, Svc> {
  const out = execFileSync(
    "docker",
    ["compose", "--env-file", ".env.example", "--profile", "*", "config", "--format", "json"],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(out).services;
}

describe.skipIf(!dockerAvailable)("compose.yaml", () => {
  const services = dockerAvailable ? render() : {};

  it("defines every service", () => {
    for (const name of ["mcp", "agent", "dashboard", "mediamtx", "adsb", "gpsd", "detector"]) {
      expect(services[name], name).toBeDefined();
    }
  });

  it("uses host networking for all Node services", () => {
    for (const n of ["mcp", "agent", "dashboard"]) expect(services[n].network_mode, n).toBe("host");
  });

  it("health-gates the agent on mcp /healthz", () => {
    expect(services.mcp.healthcheck?.test.join(" ")).toContain("/healthz");
    expect(services.agent.depends_on?.mcp?.condition).toBe("service_healthy");
  });

  it("gives the dashboard the render node and both groups", () => {
    expect(JSON.stringify(services.dashboard.devices)).toContain("/dev/dri/renderD128");
    expect(services.dashboard.group_add).toHaveLength(2);
  });

  // M7: recordings/keep and the camera device must not depend on config.json
  // having been derived from config.example.json.
  it("pins the recordings paths and the camera device for mcp and the dashboard", () => {
    for (const name of ["mcp", "dashboard"]) {
      const env = services[name].environment ?? {};
      expect(env.TB3_CAPTURE_RECORDINGS_DIR, name).toBe("/recordings/tb3");
      expect(env.TB3_CAPTURE_KEEP_DIR, name).toBe("/recordings/keep");
      expect(env.TB3_CAMERA_V4L2_DEVICE, name).toMatch(/^\/dev\/v4l\/by-id\//);
    }
  });

  it("runs mediamtx as uid 1000 with /recordings writable", () => {
    expect(services.mediamtx.user).toBe("1000:1000");
    const rec = services.mediamtx.volumes?.find((v) => v.target === "/recordings") as
      { read_only?: boolean } | undefined;
    expect(rec).toBeDefined();
    expect(rec?.read_only).toBeFalsy();
  });

  it("gates optional services behind profiles", () => {
    expect(services.adsb.profiles).toContain("adsb");
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

  it("runs ultrafeeder on the RTL-SDR directly, no Beast sidecar", () => {
    const env = services.adsb.environment ?? {};
    expect(env.READSB_DEVICE_TYPE).toBe("rtlsdr");
    expect(env.READSB_GAIN).toBe("autogain");
    expect(env.READSB_NET_ONLY).toBeUndefined();
    expect(env.READSB_NET_CONNECTOR).toBeUndefined();
    expect(services.adsb.depends_on).toBeUndefined();
    expect(services.adsb.device_cgroup_rules).toContain("c 189:* rwm");
    expect(services.adsb.volumes?.some((v) => v.target === "/dev/bus/usb")).toBe(true);
  });
});
