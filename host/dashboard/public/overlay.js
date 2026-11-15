// The aircraft overlay: lines from the strip's aircraft cards to where each
// aircraft sits in the camera picture, plus an edge marker when it is out of
// frame. Geometry is overlay-geometry.js (pure, tested); this module only
// measures the DOM and writes SVG. Toggled by a button; the choice and the
// operator-set field of view persist per browser.
import { fitContain, hfovFromState, overlayTargets, boresightFromState } from "./overlay-geometry.js";

const ENABLED_KEY = "tb3.overlay";
const HFOV_KEY = "tb3.overlayHfovDeg";
export const DEFAULT_HFOV_DEG = 60;
const SVG_NS = "http://www.w3.org/2000/svg";

export function loadHfov(storage) {
  try {
    const v = Number(storage && storage.getItem(HFOV_KEY));
    return Number.isFinite(v) && v >= 10 && v <= 150 ? v : DEFAULT_HFOV_DEG;
  } catch { return DEFAULT_HFOV_DEG; }
}
export function saveHfov(storage, v) {
  try { storage && storage.setItem(HFOV_KEY, String(v)); } catch { /* best effort */ }
}
function loadEnabled(storage) {
  try { return (storage && storage.getItem(ENABLED_KEY)) === "1"; } catch { return false; }
}
function saveEnabled(storage, on) {
  try { storage && storage.setItem(ENABLED_KEY, on ? "1" : "0"); } catch { /* best effort */ }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The picture box in page pixels: the frame's rect, shrunk to the live
// surface's aspect (object-fit: contain). Unknown source size -> the frame.
function pictureRect(frame, video, img) {
  const fr = frame.getBoundingClientRect();
  let sw = 0, sh = 0;
  if (video && !video.hidden && video.videoWidth > 0) { sw = video.videoWidth; sh = video.videoHeight; }
  else if (img && !img.hidden && img.naturalWidth > 0) { sw = img.naturalWidth; sh = img.naturalHeight; }
  const r = fitContain(fr.width, fr.height, sw, sh);
  return { x: fr.left + r.x, y: fr.top + r.y, w: r.w, h: r.h };
}

export function createOverlay({ svg, strip, frame, video, img, toggleBtn, storage }) {
  let enabled = loadEnabled(storage);
  let hfovDeg = loadHfov(storage);
  let lastState = null;

  function paintToggle() {
    if (!toggleBtn) return;
    toggleBtn.textContent = "Overlay: " + (enabled ? "ON" : "OFF");
    toggleBtn.classList.toggle("toggle-on", enabled);
  }

  function render(state) {
    if (state) lastState = state;
    if (!svg) return;
    // SVGElement has no `hidden` IDL property (that is HTMLElement's), so the
    // attribute itself is toggled -- assigning svg.hidden would only set a
    // JS expando and leave the element display:none.
    if (!enabled) { svg.setAttribute("hidden", ""); return; }
    svg.removeAttribute("hidden");
    const W = window.innerWidth, H = window.innerHeight;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const s = lastState || {};
    const parts = [];
    const bore = boresightFromState(s);
    if (!bore) {
      parts.push(`<text class="ar-hint" x="${W / 2}" y="${Math.round(H * 0.12)}" text-anchor="middle">overlay: no boresight yet (set north zero / calibrate, or wait for the IMU)</text>`);
      svg.innerHTML = parts.join("");
      return;
    }
    const rect = pictureRect(frame, video, img);
    const targets = overlayTargets(s, { hfovDeg: hfovFromState(s, hfovDeg), rect });
    const stripRect = strip.getBoundingClientRect();
    const trackedHex = s.tracking && typeof s.tracking.hex === "string" ? s.tracking.hex.toLowerCase() : null;
    for (const t of targets) {
      const card = strip.querySelector(`.adsb-row[data-hex="${CSS.escape(t.hex)}"]`);
      let x0 = null, y0 = null;
      if (card) {
        const cr = card.getBoundingClientRect();
        // Only cards actually visible in the strip get a line; a card scrolled
        // out of view would draw from off-screen into the picture.
        if (cr.right > stripRect.left && cr.left < stripRect.right) { x0 = cr.left + cr.width / 2; y0 = cr.bottom; }
      }
      const tracked = trackedHex !== null && String(t.hex).toLowerCase() === trackedHex ? " ar-tracked" : "";
      const out = t.inView ? "" : " ar-out";
      if (x0 !== null) {
        parts.push(`<line class="ar-line${out}${tracked}" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${t.x.toFixed(1)}" y2="${t.y.toFixed(1)}"/>`);
      }
      if (t.inView) {
        parts.push(`<circle class="ar-mark${tracked}" cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="11"/>`);
        parts.push(`<text class="ar-label" x="${(t.x + 15).toFixed(1)}" y="${(t.y + 4).toFixed(1)}">${esc(t.label)}</text>`);
      } else {
        // Edge marker: a small triangle pointing outward along the ray.
        const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
        const ang = Math.atan2(t.y - cy, t.x - cx) * 180 / Math.PI;
        parts.push(`<polygon class="ar-edge" points="8,0 -5,-5 -5,5" transform="translate(${t.x.toFixed(1)} ${t.y.toFixed(1)}) rotate(${ang.toFixed(1)})"/>`);
        const lx = t.x < cx ? t.x + 10 : t.x - 10;
        parts.push(`<text class="ar-label" x="${lx.toFixed(1)}" y="${(t.y + 4).toFixed(1)}" text-anchor="${t.x < cx ? "start" : "end"}">${esc(t.label)} ${Math.round(Math.abs(t.dAz))}°</text>`);
      }
    }
    svg.innerHTML = parts.join("");
  }

  function setEnabled(on) {
    enabled = !!on;
    saveEnabled(storage, enabled);
    paintToggle();
    render();
  }

  if (toggleBtn) toggleBtn.addEventListener("click", () => setEnabled(!enabled));
  if (strip) strip.addEventListener("scroll", () => render(), { passive: true });
  window.addEventListener("resize", () => render());
  paintToggle();

  return {
    render,
    setEnabled,
    isEnabled: () => enabled,
    getHfov: () => hfovDeg,
    setHfov: (v) => { if (Number.isFinite(v) && v >= 10 && v <= 150) { hfovDeg = v; saveHfov(storage, v); render(); } },
  };
}
