// The head's at-a-glance status: pure HTML/class builders for the bottom
// bar's chips and the services row, split out of cockpit.js so the mapping
// from DashboardState to "what the operator sees" is testable on its own.
//
// Chips (only the ones that apply are drawn, except the two link chips,
// which are always present so a dead link is visible rather than absent):
//   E-STOP LATCHED          rig.estop -- the head's latch, wherever it came
//                           from (this page, the MCP estop tool, another
//                           browser). Prominent; Clear is in the banner.
//   PAN UNREFERENCED        rig.panRef === "none": the head does not know
//                           where pan's origin is; the daemon refuses all
//                           automated motion until it does.
//   CALIBRATION UNVERIFIED  tracking.calibrationVerified === false: pan was
//                           re-referenced by an unknown offset; automation
//                           is refused until re-sighted or confirmed.
//   pico / imu              rig.link.pico / rig.link.imu (null: head unreachable).

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function ledFor(v) {
  return v === true ? "led-active" : v === false ? "led-failed" : "led-unknown";
}

function linkChip(label, v) {
  const state = v === true ? "up" : v === false ? "DOWN" : "unknown";
  return `<span class="head-chip${v === false ? " head-chip-warn" : ""}" title="${escapeHtml(label)} link: ${state}">` +
    `<span class="led ${ledFor(v)}"></span>${escapeHtml(label)}</span>`;
}

export function headChipsHtml(state) {
  const s = state || {};
  const rig = s.rig || {};
  const tracking = s.tracking || {};
  const link = rig.link || null;
  const chips = [];
  if (rig.estop === true) {
    chips.push('<span class="head-chip head-chip-critical" title="the head\'s E-STOP latch is set">E-STOP LATCHED</span>');
  }
  if (rig.panRef === "none") {
    chips.push('<span class="head-chip head-chip-warn" title="pan origin unknown: run Reference pan or Set position (Tools)">PAN UNREFERENCED</span>');
  }
  if (tracking.calibrationVerified === false) {
    chips.push('<span class="head-chip head-chip-warn" title="pan was re-referenced by an unknown offset: re-sight and solve, or confirm the frame">CALIBRATION UNVERIFIED</span>');
  }
  chips.push(linkChip("pico", link ? link.pico : null));
  chips.push(linkChip("imu", link ? link.imu : null));
  return chips.join("");
}

// The services row: every field but agentArmed is "up"/"down" reachability;
// agentArmed is the agent's armed flag (null when the MCP server is down).
// Disarmed is a deliberate, healthy state -- grey, never red.
export function serviceLed(key, value) {
  if (key === "agentArmed") {
    if (value === true) return { cls: "led-active", label: "armed" };
    if (value === false) return { cls: "led-inactive", label: "disarmed" };
    return { cls: "led-unknown", label: "unknown" };
  }
  if (value === "up") return { cls: "led-active", label: "up" };
  if (value === "down") return { cls: "led-failed", label: "down" };
  return { cls: "led-unknown", label: "unknown" };
}

// The single "svc" dot in the health glance: any reachability "down" is red;
// anything not yet known is unknown; otherwise healthy. agentArmed never
// colours it (disarmed is not a fault; unknown already implies mcp down), and
// neither does MediaMTX unless it is the active camera source (the v4l2 path
// does not use it, so its absence is not a fault there).
export function servicesHealthClass(services, cameraSource) {
  const s = services || {};
  const keys = cameraSource === "mediamtx" ? ["mcp", "mediamtx", "adsb", "head"] : ["mcp", "adsb", "head"];
  const vals = keys.map((k) => s[k]);
  if (vals.some((v) => v === "down")) return "led-failed";
  if (vals.some((v) => v !== "up")) return "led-unknown";
  return "led-active";
}
