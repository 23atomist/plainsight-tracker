# Cockpit HUD rework (2026-11-15)

Owner request (verbatim intent, numbered as given):

1. One bottom line, bottom-left, flush: `TB3` `UNCALIBRATED` `RIG` `SUN` `SVC`
   `pico` `imu` `head` `mcp` `agent armed` `mediamtx` `adsb` as button-style
   chips, green/red backgrounds.
2. `Fine` `Normal` `Coarse` `Stop tracking` on the same line, bottom-centre.
3. `Camera` `Auto` `Sun guard` `Capture` `Snap` `Record` `Auto capture`
   `Joystick` on the same line, bottom-right.
4. Radar leaves the HUD (lives in Tools).
5. RIG widget: Connected / Telemetry age / IMU temp / Moving stay text; pan as
   a compass, tilt as a visual indicator.
6. IMU pitch and roll as two gauges.
7. TRIM widget: pan/tilt +/- , Save from aim, Clear -- small widget.
8. TRACKING widget: the values, widget style.
   All widgets hidable, on the left-centre side.
9. Joystick centred, 3/4 down the screen, not flush to the bottom.
10. Toggle for an aircraft overlay: lines from the strip cards to where each
    aircraft is in the picture, from ADS-B geometry.

## Decisions (mine, flagged to the owner)

- E-STOP, Tools, the MODE chip, the Recordings link, the JOG/TRIM label and
  the new Overlay toggle form a cluster at the **top-right of the stage**,
  under the aircraft strip. The owner's three bottom clusters did not list
  them and the bottom line has no room left.
- Radar moves into a new Tools entry **"Radar"** (the owner believes Tools has
  it already; it did not). The radar panel is permanent DOM, moved into the
  drawer on open so its canvas wiring survives (same reason joystick-panel
  mounts rather than re-renders). The track-range slider goes with it, plus
  the overlay's field-of-view slider.
- Widgets: a slim rail of three toggles (RIG / TRIM / TRK) on the left edge,
  vertically centred, with the three cards stacked beside it. Visibility is
  persisted per browser (localStorage).
- Overlay geometry: boresight az/el comes from a new read-only MCP tool
  `get_pointing` (calibrated or provisional orientation + current pan/tilt),
  surfaced as `state.pointing`; when null the client falls back to the IMU's
  fused heading/pitch; when neither exists the overlay shows a hint instead
  of lines. Horizontal FOV comes from `vision.focalPx` when the vision scale
  has been calibrated, else an operator-set value (default 60 deg) in the
  Radar entry. The picture rectangle is the object-fit:contain box of the
  live video.
- Toasts move below the top-right cluster so they never cover E-STOP.
- The bottom line is one row at >= 1200 px; narrower viewports wrap it.

## Files

- `host/src/mcp/pointing-tools.ts` (new), registered in `src/mcp/server.ts`;
  `src/dashboard/client.ts` getPointing; `src/dashboard/state.ts`
  `pointing`; `src/dashboard/server.ts` collect leg.
- `host/dashboard/public/`: `index.html`, `hud.css` (new, imported by
  style.css), `cockpit.css` (pruned), `rig-gauges.js`, `overlay-geometry.js`,
  `overlay.js`, `widgets.js`, `radar-entry.js` (new), `drawer.js` (+radar
  entry), `cockpit.js` (health chips, gauges), `app.js` (glue).
- Tests: `test/pointing-tools.test.ts`, `test/dashboard-state.test.ts`,
  `test/rig-gauges.test.ts`, `test/overlay-geometry.test.ts`,
  `test/widgets.test.ts`, `test/cockpit.test.ts` (health chips).
- Verification: `npm test`, `scripts/dashboard-smoke.mjs`, Playwright
  screenshots against the live dashboard at 1440x900 and 1024x768.
