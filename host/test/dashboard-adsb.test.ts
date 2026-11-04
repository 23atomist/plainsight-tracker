import { describe, it, expect, vi, afterEach } from "vitest";
import { getAdsb, peekAdsb, probeHttp, deriveServices, mediamtxProbeUrl } from "../src/dashboard/server.js";
import type { Config } from "../src/shared/config.js";
import type { McpDashboardClient } from "../src/dashboard/client.js";
import type { AircraftRow } from "../src/dashboard/state.js";

const AIRCRAFT_ROW: AircraftRow = {
  hex: "abc123", callsign: "TEST", category: null, squawk: null, altitude_m: 6000,
  ground_speed_kt: 400, azimuth_deg: 90, elevation_deg: 10, range_km: 30, est_track_sec: 60,
  reachable: true, sunSafe: true, slewOk: true, inSector: true, trackable: true,
};

// getAdsb takes the raw count from peekAdsb (tested below); null here.
const RAW_COUNT: number | null = null;

function fakeClient(over: {
  scanTrackable?: () => Promise<AircraftRow[]>;
  scanAircraft?: () => Promise<AircraftRow[]>;
}): McpDashboardClient {
  return {
    scanTrackable: over.scanTrackable ?? (async () => []),
    scanAircraft: over.scanAircraft ?? (async () => []),
  } as unknown as McpDashboardClient;
}

describe("getAdsb", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The operator's actual blocked case (see the field report this pins):
  // pre-calibration, the daemon correctly refuses scanTrackable() (no solved
  // mount orientation yet) while scanAircraft() correctly succeeds (rig
  // location alone is enough -- see 489313c). The old Promise.all let that
  // *expected* scanTrackable rejection discard the successful scanAircraft()
  // result too, leaving both lists empty. getAdsb must instead degrade
  // `trackable` to [] and still return the populated `aircraft` list.
  it("scanTrackable rejects, scanAircraft resolves -> ok, aircraft populated, trackable empty", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = fakeClient({
        scanTrackable: async () => { throw new Error("no solved mount orientation (R)"); },
        scanAircraft: async () => [AIRCRAFT_ROW],
      });

      const result = await getAdsb(client, RAW_COUNT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.aircraft).toEqual([AIRCRAFT_ROW]);
        expect(result.value.trackable).toEqual([]);
      }
      // The refusal must still reach the operator, not be swallowed.
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("scanTrackable"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("scanAircraft rejects, scanTrackable resolves -> ok, mirrored", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = fakeClient({
        scanTrackable: async () => [AIRCRAFT_ROW],
        scanAircraft: async () => { throw new Error("boom"); },
      });

      const result = await getAdsb(client, RAW_COUNT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.trackable).toEqual([AIRCRAFT_ROW]);
        expect(result.value.aircraft).toEqual([]);
      }
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("scanAircraft"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("both legs reject -> error Result, as today", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = fakeClient({
        scanTrackable: async () => { throw new Error("trackable-down"); },
        scanAircraft: async () => { throw new Error("aircraft-down"); },
      });

      const result = await getAdsb(client, RAW_COUNT);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("trackable-down");
        expect(result.error).toContain("aircraft-down");
      }
    } finally {
      errSpy.mockRestore();
    }
  });

  // Pinned so a future change to this leg is provably a widening, not a
  // regression: both legs succeeding must stay unchanged from today.
  it("both legs resolve -> ok, unchanged from current behavior", async () => {
    const trackableRow = { ...AIRCRAFT_ROW, hex: "trackable1" };
    const aircraftRow = { ...AIRCRAFT_ROW, hex: "aircraft1" };
    const client = fakeClient({
      scanTrackable: async () => [trackableRow],
      scanAircraft: async () => [aircraftRow],
    });

    const result = await getAdsb(client, RAW_COUNT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.trackable).toEqual([trackableRow]);
      expect(result.value.aircraft).toEqual([aircraftRow]);
    }
  });

  it("a hanging leg still hits its per-call timeout and doesn't stall the other", async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hanging = new Promise<AircraftRow[]>(() => { /* deliberately never settles */ });
      const client = fakeClient({
        scanTrackable: () => hanging,
        scanAircraft: async () => [AIRCRAFT_ROW],
      });

      const pending = getAdsb(client, RAW_COUNT);
      await vi.advanceTimersByTimeAsync(4001); // > COLLECT_CALL_TIMEOUT_MS (4000ms in server.ts)
      const result = await pending;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.aircraft).toEqual([AIRCRAFT_ROW]);
        expect(result.value.trackable).toEqual([]);
      }
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("scanTrackable"));
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("services probes (no service manager: direct observation)", () => {
  const reply = (r: { ok: boolean; body?: unknown } | Error) => {
    const urls: string[] = [];
    const fn = (async (url: string) => {
      urls.push(url);
      if (r instanceof Error) throw r;
      return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.body };
    }) as unknown as typeof fetch;
    return { fn, urls };
  };

  it("peekAdsb: one read answers both the raw count and up/down", async () => {
    const { fn, urls } = reply({ ok: true, body: { aircraft: [{}, {}, {}] } });
    expect(await peekAdsb("http://adsb/data/aircraft.json", fn)).toEqual({ up: "up", rawCount: 3 });
    expect(urls).toEqual(["http://adsb/data/aircraft.json"]);
    expect(await peekAdsb("x", reply({ ok: true, body: { nope: 1 } }).fn)).toEqual({ up: "up", rawCount: null });
    expect(await peekAdsb("x", reply({ ok: false }).fn)).toEqual({ up: "down", rawCount: null });
    expect(await peekAdsb("x", reply(new Error("ECONNREFUSED")).fn)).toEqual({ up: "down", rawCount: null });
  });

  it("probeHttp: 2xx is up, anything else (status or throw) is down", async () => {
    expect(await probeHttp("x", reply({ ok: true }).fn)).toBe("up");
    expect(await probeHttp("x", reply({ ok: false }).fn)).toBe("down");
    expect(await probeHttp("x", reply(new Error("timeout")).fn)).toBe("down");
  });

  it("mediamtxProbeUrl is the control API's paths list", () => {
    expect(mediamtxProbeUrl({ cameraMediamtxControlUrl: "http://127.0.0.1:9997/" } as Config))
      .toBe("http://127.0.0.1:9997/v3/paths/list");
  });

  it("deriveServices: mcp + agentArmed from get_agent_armed (null when MCP is down), head from the direct read", () => {
    expect(deriveServices({ ok: true, value: true }, "up", "down", { ok: true, value: { connected: true } }))
      .toEqual({ mcp: "up", agentArmed: true, mediamtx: "up", adsb: "down", head: "up" });
    expect(deriveServices({ ok: false, error: "fetch failed" }, "down", "up", { ok: true, value: { connected: false } }))
      .toEqual({ mcp: "down", agentArmed: null, mediamtx: "down", adsb: "up", head: "down" });
    expect(deriveServices({ ok: true, value: false }, "up", "up", { ok: false, error: "x" }).head).toBe("down");
  });
});
