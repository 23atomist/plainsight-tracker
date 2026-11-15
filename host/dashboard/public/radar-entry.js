// Tools -> Radar: the PPI radar (radar.js, permanent DOM parked in
// #radar-stash) plus the aircraft overlay's field-of-view setting.
//
// renderRadarEntry returns a CONSTANT html string (the Drawer re-renders
// entries by string comparison, see drawer.js); mountRadarEntry then moves
// the real #minimap-panel node into the placeholder so the canvas and its
// listeners are the same objects every time -- the same reason
// joystick-panel.js mounts rather than re-renders.

export function renderRadarEntry() {
  return `
    <div class="radar-entry">
      <div id="radar-mount"></div>
      <div class="overlay-fov-row">
        <label for="overlay-fov">Overlay field of view</label>
        <input id="overlay-fov" type="range" min="20" max="120" step="1" title="horizontal field of view the aircraft overlay assumes for the camera">
        <span id="overlay-fov-label" class="range-label">&mdash;</span>
      </div>
      <p class="muted">The overlay projects ADS-B positions onto the picture through this horizontal field of view; a calibrated vision scale (focal length) overrides it. Widen it if marks land inside the real aircraft, narrow it if they land outside.</p>
    </div>`;
}

export function mountRadarEntry(root, panelNode, overlay) {
  if (!root || typeof root.querySelector !== "function") return;
  const mount = root.querySelector("#radar-mount");
  if (mount && panelNode && panelNode.parentNode !== mount) mount.appendChild(panelNode);
  const slider = root.querySelector("#overlay-fov");
  const label = root.querySelector("#overlay-fov-label");
  if (!slider || !overlay) return;
  const paint = (v) => { if (label) label.textContent = `${Math.round(v)}°`; };
  slider.value = String(overlay.getHfov());
  paint(overlay.getHfov());
  slider.addEventListener("input", () => { const v = Number(slider.value); overlay.setHfov(v); paint(v); });
}
