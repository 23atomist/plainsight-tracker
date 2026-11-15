// The RIG widget's instruments: a pan compass, a tilt quadrant and two
// arc gauges (IMU pitch / roll). Pure angle mapping here (vitest, no DOM --
// test/rig-gauges.test.ts); paintRigGauges only sets SVG attributes on the
// elements app.js hands it, so a missing element is a no-op, never a throw.

// Arc gauges sweep 240 degrees (-120..+120 about straight up), the usual
// instrument-cluster look: the needle reads at a glance against the arc.
export const GAUGE_SWEEP_DEG = 240;

function finite(v) { return typeof v === "number" && Number.isFinite(v); }

// Linear map of [min, max] onto [-sweep/2, +sweep/2], clamped. A missing or
// non-finite value parks the needle at the low end -- "no reading" must look
// different from "reads zero".
export function gaugeAngle(value, min, max, sweepDeg = GAUGE_SWEEP_DEG) {
  const half = sweepDeg / 2;
  if (!finite(value) || !(max > min)) return -half;
  const f = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return -half + f * sweepDeg;
}

// Compass needle: pan degrees, clockwise about the 100x100 dial's centre,
// normalised to 0..360 and rounded to a tenth so the DOM attribute does not
// churn on sub-resolution noise.
export function compassTransform(panDeg) {
  const d = finite(panDeg) ? ((panDeg % 360) + 360) % 360 : 0;
  return `rotate(${Number(d.toFixed(1))} 50 50)`;
}

// Tilt quadrant: the pivot sits at (20,80) of a 100x100 box; 0 deg lies along
// +x (horizon) and the needle swings counter-clockwise (negative SVG rotate)
// up to 90 (zenith). Clamped to the quadrant: the rig cannot tilt past it.
export function tiltTransform(tiltDeg) {
  const d = finite(tiltDeg) ? Math.max(0, Math.min(90, tiltDeg)) : 0;
  return `rotate(${-Number(d.toFixed(1))} 20 80)`;
}

export function fmtDeg(v, digits = 1) {
  return finite(v) ? `${v.toFixed(digits)}°` : "—";
}

// Gauge ranges. Pitch follows the tilt axis on this rig (HEAD_IMU_TILT_AXIS=
// pitch), so it spans the tilt travel; roll is a levelness check.
export const PITCH_RANGE = { min: -10, max: 100 };
export const ROLL_RANGE = { min: -20, max: 20 };

// Constant SVG markup for the four instruments. Ticks/labels are static;
// only the needle (and the readout text beside it) move. 100x100 viewBoxes
// so one CSS size rule fits all four.
function arcPath(cx, cy, r, a0, a1) {
  const p = (a) => { const t = ((a - 90) * Math.PI) / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
  const [x0, y0] = p(a0); const [x1, y1] = p(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function gaugeMarkup(id, label) {
  const half = GAUGE_SWEEP_DEG / 2;
  const ticks = [];
  for (let a = -half; a <= half; a += 30) {
    ticks.push(`<line class="g-tick" x1="50" y1="8" x2="50" y2="${a % 60 === 0 ? 15 : 12}" transform="rotate(${a} 50 50)"/>`);
  }
  return `<svg class="gauge" viewBox="0 0 100 100" aria-label="${label}">
    <path class="g-arc" d="${arcPath(50, 50, 42, -half, half)}"/>
    ${ticks.join("")}
    <line class="g-needle" id="${id}-needle" x1="50" y1="52" x2="50" y2="12" transform="rotate(${-half} 50 50)"/>
    <circle class="g-hub" cx="50" cy="50" r="3"/>
    <text class="g-label" x="50" y="78" text-anchor="middle">${label}</text>
    <text class="g-value" id="${id}-value" x="50" y="93" text-anchor="middle">—</text>
  </svg>`;
}

export function compassMarkup(id) {
  const ticks = [];
  for (let a = 0; a < 360; a += 30) {
    ticks.push(`<line class="g-tick" x1="50" y1="6" x2="50" y2="${a % 90 === 0 ? 14 : 10}" transform="rotate(${a} 50 50)"/>`);
  }
  return `<svg class="gauge compass" viewBox="0 0 100 100" aria-label="pan">
    <circle class="g-arc" cx="50" cy="50" r="44"/>
    ${ticks.join("")}
    <text class="g-card" x="50" y="24" text-anchor="middle">0</text>
    <text class="g-card" x="80" y="53" text-anchor="middle">90</text>
    <text class="g-card" x="50" y="83" text-anchor="middle">180</text>
    <text class="g-card" x="19" y="53" text-anchor="middle">270</text>
    <polygon class="g-needle-pan" id="${id}-needle" points="50,14 46,52 54,52" transform="rotate(0 50 50)"/>
    <circle class="g-hub" cx="50" cy="50" r="3"/>
    <text class="g-label" x="50" y="64" text-anchor="middle">PAN</text>
    <text class="g-value" id="${id}-value" x="50" y="96" text-anchor="middle">—</text>
  </svg>`;
}

export function tiltMarkup(id) {
  const ticks = [0, 30, 60, 90].map((a) =>
    `<line class="g-tick" x1="86" y1="80" x2="80" y2="80" transform="rotate(${-a} 20 80)"/>`).join("");
  return `<svg class="gauge tilt" viewBox="0 0 100 100" aria-label="tilt">
    <path class="g-arc" d="${arcPath(20, 80, 66, 0, 90)}"/>
    <line class="g-horizon" x1="20" y1="80" x2="92" y2="80"/>
    ${ticks}
    <line class="g-needle" id="${id}-needle" x1="20" y1="80" x2="82" y2="80" transform="rotate(0 20 80)"/>
    <circle class="g-hub" cx="20" cy="80" r="3"/>
    <text class="g-label" x="62" y="97" text-anchor="middle">TILT</text>
    <text class="g-value" id="${id}-value" x="70" y="40" text-anchor="middle">—</text>
  </svg>`;
}

// Paints all four from a DashboardState.rig. `q` resolves ids inside the
// widget root; every lookup is optional.
export function paintRigGauges(root, rig) {
  if (!root || typeof root.querySelector !== "function") return;
  const q = (id) => root.querySelector("#" + id);
  const r = rig || {};
  const imu = r.imu && r.imu.ok ? r.imu : null;
  const set = (id, attr, val) => { const n = q(id); if (n) n.setAttribute(attr, val); };
  const txt = (id, val) => { const n = q(id); if (n) n.textContent = val; };
  set("rg-pan-needle", "transform", compassTransform(r.panDeg));
  txt("rg-pan-value", fmtDeg(r.panDeg));
  set("rg-tilt-needle", "transform", tiltTransform(r.tiltDeg));
  txt("rg-tilt-value", fmtDeg(r.tiltDeg));
  const pitch = imu ? imu.pitch : null;
  const roll = imu ? imu.roll : null;
  set("rg-pitch-needle", "transform", `rotate(${gaugeAngle(pitch, PITCH_RANGE.min, PITCH_RANGE.max).toFixed(1)} 50 50)`);
  txt("rg-pitch-value", fmtDeg(pitch));
  set("rg-roll-needle", "transform", `rotate(${gaugeAngle(roll, ROLL_RANGE.min, ROLL_RANGE.max).toFixed(1)} 50 50)`);
  txt("rg-roll-value", fmtDeg(roll));
}
