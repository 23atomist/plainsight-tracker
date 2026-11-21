// Lens focus buttons (bottom bar): tap for one step, hold to keep turning.
//
// Each press sends `focus/nudge` (the server adds the delta to the focus
// axis's TARGET on the head, so taps add up). Held past HOLD_DELAY_MS, it
// keeps sending HOLD_STEP_DEG every HOLD_INTERVAL_MS -- at or under the
// Pico's default focus vmax (30 deg/s), so the target stays just ahead of the
// motor -- and on release sends `focus/stop`, so the motor halts where the
// operator let go instead of running out the queued steps. A plain tap sends
// no stop: its one step is meant to complete.
//
// Angles are output-shaft (motor) degrees; with the 136:20 belt, 2 deg at
// the motor is about 0.3 deg on the lens ring. Fine by default (focus is
// found by small moves); Shift for coarse: COARSE x the step and the hold
// speed, which at the hold pace below is the Pico's focus vmax (30 deg/s).

export const TAP_STEP_DEG = 2;
export const HOLD_DELAY_MS = 350;
export const HOLD_INTERVAL_MS = 200;
export const HOLD_STEP_DEG = 1.2;   // 6 deg/s
export const COARSE = 5;

/**
 * One press-and-hold controller per direction.
 * @param {{
 *   post: (path: string, body: object, opts?: object) => unknown,
 *   setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout,
 *   setInterval?: typeof setInterval, clearInterval?: typeof clearInterval,
 * }} deps
 * @param {1 | -1} sign
 */
export function createFocusHold(deps, sign) {
  const st = deps.setTimeout ?? setTimeout;
  const ct = deps.clearTimeout ?? clearTimeout;
  const si = deps.setInterval ?? setInterval;
  const ci = deps.clearInterval ?? clearInterval;
  let delay = null;
  let repeat = null;
  let pressed = false;

  /** @param {boolean} [coarse] Shift held: COARSE x the step and the hold speed. */
  function press(coarse = false) {
    if (pressed) return;
    pressed = true;
    const k = coarse ? COARSE : 1;
    deps.post("focus/nudge", { delta_deg: sign * TAP_STEP_DEG * k }, { quiet: true });
    delay = st(() => {
      delay = null;
      repeat = si(() => deps.post("focus/nudge", { delta_deg: sign * HOLD_STEP_DEG * k }, { quiet: true }), HOLD_INTERVAL_MS);
    }, HOLD_DELAY_MS);
  }

  function release() {
    if (!pressed) return;
    pressed = false;
    if (delay !== null) { ct(delay); delay = null; }
    if (repeat !== null) {
      ci(repeat); repeat = null;
      deps.post("focus/stop", {}, { quiet: true });
    }
  }

  return { press, release, isPressed: () => pressed };
}

/** "123.4°" for a focus position, an em dash when unknown. */
export function formatFocus(deg) {
  return typeof deg === "number" && Number.isFinite(deg) ? `${deg.toFixed(1)}°` : "—";
}

/**
 * Wire the two buttons (pointer + keyboard "[" / "]") and return a render
 * hook for the per-tick state.
 * @param {{ minus: HTMLButtonElement, plus: HTMLButtonElement, readout: HTMLElement,
 *           post: (path: string, body: object, opts?: object) => unknown,
 *           isTextEntryFocused: () => boolean }} opts
 */
export function mountFocusControl(opts) {
  const holds = new Map([[opts.minus, createFocusHold(opts, -1)], [opts.plus, createFocusHold(opts, 1)]]);
  for (const [btn, hold] of holds) {
    btn.addEventListener("pointerdown", (e) => {
      if (btn.disabled) return;
      e.preventDefault();
      btn.setPointerCapture?.(e.pointerId);
      hold.press(e.shiftKey);
    });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) btn.addEventListener(ev, () => hold.release());
    // Keyboard activation (Enter/Space on a focused button) is one tap.
    btn.addEventListener("click", (e) => { if (e.detail === 0 && !btn.disabled) { hold.press(e.shiftKey); hold.release(); } });
  }
  // "{" / "}" are Shift+[ / Shift+] on US layouts: coarse.
  const keyHold = { "[": holds.get(opts.minus), "]": holds.get(opts.plus), "{": holds.get(opts.minus), "}": holds.get(opts.plus) };
  const keyBtn = { "[": opts.minus, "]": opts.plus, "{": opts.minus, "}": opts.plus };
  document.addEventListener("keydown", (e) => {
    const hold = keyHold[e.key];
    if (!hold || e.repeat || opts.isTextEntryFocused() || keyBtn[e.key].disabled) return;
    e.preventDefault();
    hold.press(e.shiftKey);
  });
  document.addEventListener("keyup", (e) => { keyHold[e.key]?.release(); });
  // A focus hold must never outlive the page's attention.
  window.addEventListener("blur", () => { for (const h of holds.values()) h.release(); });

  return {
    /** @param {{ focusDeg?: number | null } | null | undefined} rig @param {boolean} locked */
    render(rig, locked) {
      opts.readout.textContent = formatFocus(rig?.focusDeg);
      for (const [btn, hold] of holds) {
        btn.disabled = locked;
        if (locked) hold.release();
      }
    },
  };
}
