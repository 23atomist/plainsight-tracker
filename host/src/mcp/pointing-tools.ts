import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Device } from "../shared/device.js";
import { Config } from "../shared/config.js";
import { CalibrationStore } from "../shared/calibration.js";
import { boresightEnu } from "../shared/track/control.js";
import { rad2deg, Vec3 } from "../shared/geo/vec3.js";
import { applySign } from "../shared/angles.js";
import { text } from "./tool-helpers.js";

// ENU unit vector -> compass azimuth (0 = north, 90 = east) and elevation.
// Same convention as enrich.ts's azElOfUnit (kept private there).
export function azElOfEnu(unit: Vec3): { azDeg: number; elDeg: number } {
  let azDeg = rad2deg(Math.atan2(unit[0], unit[1]));
  if (azDeg < 0) azDeg += 360;
  const elDeg = rad2deg(Math.asin(Math.max(-1, Math.min(1, unit[2]))));
  return { azDeg, elDeg };
}

// get_pointing: where the camera boresight points right now, in the world
// frame. Read-only. The dashboard's aircraft overlay draws from this; the
// sun guard's own separation readout (get_sun) uses the identical offset
// model (R, cHead, geoPanSign), so the two can never disagree about where
// the rig is looking.
export function registerPointingTools(server: McpServer, device: Device, cfg: Config, store: CalibrationStore): void {
  server.registerTool(
    "get_pointing",
    {
      description: "Report the camera boresight's azimuth/elevation now (world frame), from the solved or provisional " +
        "orientation and the current pan/tilt. Nulls when no orientation exists. Read-only.",
      inputSchema: {},
    },
    async () => {
      const d = device.getState();
      const panDeg = applySign(d.panDeg, cfg.panSign);
      const tiltDeg = applySign(d.tiltDeg, cfg.tiltSign);
      const R = store.getOrientation();
      let azimuth_deg: number | null = null;
      let elevation_deg: number | null = null;
      let source: "calibration" | "provisional" | null = null;
      if (R) {
        const cHead: Vec3 = store.getCHead() ?? [0, 1, 0];
        const { azDeg, elDeg } = azElOfEnu(boresightEnu(R, panDeg, tiltDeg, cHead, cfg.geoPanSign));
        azimuth_deg = Number(azDeg.toFixed(3));
        elevation_deg = Number(elDeg.toFixed(3));
        source = store.isProvisional() ? "provisional" : "calibration";
      }
      return text(JSON.stringify({
        azimuth_deg, elevation_deg, source,
        pan_deg: Number(panDeg.toFixed(3)), tilt_deg: Number(tiltDeg.toFixed(3)),
      }, null, 2));
    },
  );
}
