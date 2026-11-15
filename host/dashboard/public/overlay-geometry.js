// Aircraft overlay geometry: where an ADS-B target lands on the camera
// picture. Pure (vitest, no DOM -- test/overlay-geometry.test.ts); overlay.js
// does the drawing.
//
// Model: a pinhole camera whose optical axis is the rig's boresight
// (az/el from state.pointing, else the IMU), horizontal field of view
// `hfovDeg`, picture rectangle `rect` (the object-fit:contain box of the
// video inside its frame, in page pixels). A target at angular offset
// (dAz, dEl) from the boresight projects to x = cx + f*tan(dAz),
// y = cy - f*tan(dEl) with f = (w/2)/tan(hfov/2). Good to a degree or so
// across a normal lens; roll is ignored (the rig is levelled).

const DEG = Math.PI / 180;

function finite(v) { return typeof v === "number" && Number.isFinite(v); }

// object-fit: contain -- the largest srcW:srcH box that fits frameW x frameH,
// centred. Unknown source size (video not yet decoding) means the whole frame.
export function fitContain(frameW, frameH, srcW, srcH) {
  if (!(srcW > 0 && srcH > 0 && frameW > 0 && frameH > 0)) return { x: 0, y: 0, w: frameW, h: frameH };
  const s = Math.min(frameW / srcW, frameH / srcH);
  const w = srcW * s, h = srcH * s;
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, w, h };
}

export function wrap180(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

export function angularOffset(boreAz, boreEl, az, el) {
  return { dAz: wrap180(az - boreAz), dEl: el - boreEl };
}

// Angular offset -> page point. inView is false outside the picture box or
// anywhere at/behind 90 deg off-axis, where the tangent model breaks.
export function projectOffset(dAzDeg, dElDeg, hfovDeg, rect) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const f = (rect.w / 2) / Math.tan((hfovDeg / 2) * DEG);
  const behind = Math.abs(dAzDeg) >= 89 || Math.abs(dElDeg) >= 89;
  if (behind) {
    // Point far out along the direction, so the clamp still lands on the
    // correct edge instead of producing NaN/Infinity.
    const k = 1e6;
    return { x: cx + Math.sign(dAzDeg || 1) * k * Math.abs(Math.sin(dAzDeg * DEG)), y: cy - Math.sign(dElDeg || 0) * k * Math.abs(Math.sin(dElDeg * DEG)), inView: false };
  }
  const x = cx + f * Math.tan(dAzDeg * DEG);
  const y = cy - f * Math.tan(dElDeg * DEG);
  const inView = x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  return { x, y, inView };
}

// Slide a point onto the rectangle boundary (inset by `pad`) along the ray
// from the rectangle centre -- the edge marker for an out-of-view target.
export function clampToRect(x, y, rect, pad = 0) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const hw = rect.w / 2 - pad, hh = rect.h / 2 - pad;
  const dx = x - cx, dy = y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const t = Math.min(hw / Math.max(Math.abs(dx), 1e-9), hh / Math.max(Math.abs(dy), 1e-9), 1);
  return { x: cx + dx * t, y: cy + dy * t };
}

// The daemon's calibrated/provisional boresight first; the IMU's fused
// heading + pitch as the uncalibrated fallback; null when neither exists.
export function boresightFromState(state) {
  const s = state || {};
  const p = s.pointing;
  if (p && finite(p.azDeg) && finite(p.elDeg)) return { azDeg: p.azDeg, elDeg: p.elDeg, source: p.source || "calibration" };
  const imu = s.rig && s.rig.imu;
  if (imu && imu.ok && finite(imu.heading) && finite(imu.pitch)) return { azDeg: imu.heading, elDeg: imu.pitch, source: "imu" };
  return null;
}

// Horizontal FOV from a calibrated vision scale (focalPx over the frame
// width), else the operator's setting.
export function hfovFromState(state, fallbackDeg) {
  const v = (state || {}).vision;
  const f = v && v.focalPx, w = v && v.frameSizePx && v.frameSizePx.widthPx;
  if (finite(f) && f > 0 && finite(w) && w > 0) return 2 * Math.atan((w / 2) / f) / DEG;
  return fallbackDeg;
}

// One entry per aircraft row with a page point. Out-of-view targets are
// clamped onto the picture boundary so a line can still point the way.
export function overlayTargets(state, { hfovDeg, rect, edgePad = 14 }) {
  const bore = boresightFromState(state);
  if (!bore || !rect || !(rect.w > 0 && rect.h > 0)) return [];
  const rows = (state && state.adsb && Array.isArray(state.adsb.aircraft)) ? state.adsb.aircraft : [];
  const out = [];
  for (const row of rows) {
    if (!row || !finite(row.azimuth_deg) || !finite(row.elevation_deg)) continue;
    const { dAz, dEl } = angularOffset(bore.azDeg, bore.elDeg, row.azimuth_deg, row.elevation_deg);
    const p = projectOffset(dAz, dEl, hfovDeg, rect);
    const pt = p.inView ? { x: p.x, y: p.y } : clampToRect(p.x, p.y, rect, edgePad);
    out.push({ hex: row.hex, label: row.callsign || row.hex, x: pt.x, y: pt.y, inView: p.inView, dAz, dEl, rangeKm: row.range_km });
  }
  return out;
}
