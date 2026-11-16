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
  ipc?: string;
  cap_add?: string[];
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
    // -f compose.yaml explicitly: a COMPOSE_FILE in the env file must not
    // silently pull the GPU overlay into the "base" render.
    ["compose", "-f", "compose.yaml", "--env-file", ".env.example", "--profile", "*", "config", "--format", "json"],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(out).services;
}

describe.skipIf(!dockerAvailable)("compose.yaml", () => {
  const services = dockerAvailable ? render() : {};

  it("defines every service", () => {
    for (const name of ["mcp", "agent", "dashboard", "mediamtx", "adsb", "readsb-pluto", "gpsd", "chrony", "detector"]) {
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

  it("keeps readsb-pluto off ultrafeeder's ports", () => {
    const cmd = (services["readsb-pluto"].command ?? []).join(" ");
    expect(cmd).toContain("--net-bo-port 29005");
    for (const f of ["--net-ri-port", "--net-ro-port", "--net-sbs-port", "--net-bi-port"]) {
      expect(cmd).toContain(`${f} 0`);
    }
    expect(cmd).not.toContain("--net-only");
  });

  it("gates optional services behind profiles", () => {
    expect(services.adsb.profiles).toContain("adsb");
    expect(services["readsb-pluto"].profiles).toContain("adsb");
    expect(services.gpsd.profiles).toContain("gps");
    expect(services.chrony.profiles).toContain("gps");
    expect(services.detector.profiles).toContain("vision");
  });

  // chrony reads gpsd's NTP shared-memory segments, so both must share the
  // host IPC namespace; setting the host clock needs CAP_SYS_TIME; serving
  // NTP to the LAN needs the host network. The drift file must persist.
  it("disciplines the host clock from gpsd over shared memory", () => {
    expect(services.gpsd.ipc).toBe("host");
    expect(services.chrony.ipc).toBe("host");
    expect(services.chrony.network_mode).toBe("host");
    expect(services.chrony.cap_add).toContain("SYS_TIME");
    expect(services.chrony.depends_on?.gpsd).toBeDefined();
    expect(services.chrony.volumes?.some((v) => v.target === "/var/lib/chrony")).toBe(true);
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
    expect(env.READSB_NET_CONNECTOR).toBe("127.0.0.1,29005,beast_in");
    expect(services.adsb.device_cgroup_rules).toBeUndefined();
    expect(services["readsb-pluto"].device_cgroup_rules).toContain("c 189:* rwm");
  });
});

// compose.gpu.yaml is an OVERLAY (COMPOSE_FILE=compose.yaml:compose.gpu.yaml)
// so the base stack stays deployable without the NVIDIA toolkit. Rendered
// together here: NVENC for the dashboard, the local LLM for the agent, and
// the GPU for the detector.
function renderGpu(): Record<string, Svc & { deploy?: { resources?: { reservations?: { devices?: { driver: string; capabilities: string[] }[] } } } }> {
  const out = execFileSync(
    "docker",
    ["compose", "-f", "compose.yaml", "-f", "compose.gpu.yaml", "--env-file", ".env.example", "--profile", "*", "config", "--format", "json"],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(out).services;
}

describe.skipIf(!dockerAvailable)("compose.gpu.yaml", () => {
  const services = dockerAvailable ? renderGpu() : {};
  const gpuDevices = (name: string) => services[name].deploy?.resources?.reservations?.devices ?? [];

  it("gives the dashboard the GPU with the video capability (NVENC) and switches the encoder", () => {
    const dev = gpuDevices("dashboard");
    expect(dev).toHaveLength(1);
    expect(dev[0].driver).toBe("nvidia");
    expect(dev[0].capabilities).toEqual(expect.arrayContaining(["gpu", "video"]));
    expect(services.dashboard.environment?.TB3_CAMERA_ENCODER).toBe("nvenc");
    // The base service's camera device and mounts survive the overlay.
    expect(JSON.stringify(services.dashboard.devices)).toContain("video-index0");
    expect(services.dashboard.volumes?.some((v) => v.target === "/recordings")).toBe(true);
  });

  it("runs ollama on the GPU, loopback only, behind the llm profile, with persistent models", () => {
    expect(services.ollama.profiles).toContain("llm");
    expect(services.ollama.network_mode).toBe("host");
    expect(gpuDevices("ollama")[0]?.driver).toBe("nvidia");
    expect(services.ollama.environment?.OLLAMA_HOST).toBe("127.0.0.1:11434");
    expect(services.ollama.environment?.OLLAMA_MAX_LOADED_MODELS).toBe("1");
    expect(services.ollama.volumes?.some((v) => v.target === "/root/.ollama")).toBe(true);
  });

  it("points the agent at the local model and starts it after ollama", () => {
    expect(services.agent.depends_on?.ollama).toBeDefined();
    expect(services.agent.depends_on?.mcp?.condition).toBe("service_healthy");
  });

  it("gives the detector the GPU too", () => {
    expect(gpuDevices("detector")[0]?.driver).toBe("nvidia");
  });

  it("keeps the base file free of any nvidia device reservation", () => {
    for (const [name, s] of Object.entries(render())) {
      expect(JSON.stringify((s as { deploy?: unknown }).deploy ?? {}), name).not.toContain("nvidia");
    }
  });
});
