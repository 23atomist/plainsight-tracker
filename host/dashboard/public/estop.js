// E-STOP: the single most safety-critical write this dashboard makes.
// Split out of app.js (2026-07-28 dashboard redesign, task 10 fix round 1)
// so this exact logic -- latch immediately on click, before any network
// round trip; clear only on an explicit operator action; always re-apply
// the motion gate and force an immediate cockpit re-render on either edge
// -- has a unit-testable home instead of living inline in a large bootstrap
// file. It is also the module a `scripts/` smoke test can exercise directly
// to guard against the exact regression this task's own history produced:
// a prior draft of the app.js split silently dropped the E-STOP button's
// click listener entirely, and no test or typecheck caught it -- only a
// real browser click did (see scripts/dashboard-smoke.mjs).
//
// Owns the ONE latch boolean the whole dashboard treats as ground truth for
// "can any control move the rig right now" -- every other module (jogHold/
// nudgeHold's isGated, the joystick's isGated/isSightGated, sector.js's drag
// gate, radar.js's click gate, procedure-actions.js's calibration/limits/
// home gates, cockpit.js's aimMode via render()) reads isLatched() rather
// than holding its own copy, so there is exactly one place this can ever be
// true.
//
// Two latches meet here, deliberately kept apart:
//   - this page's own client-side latch (set the instant E-STOP is clicked,
//     before any network round trip), and
//   - the HEAD's latch (POST /api/estop; every motion route refuses with 423
//     until POST /api/estop/clear), reported back on every SSE tick as
//     state.rig.estop.
// syncFromHead() folds the head's latch INTO the client latch (so an E-STOP
// from the MCP estop tool or another browser locks this page too), but never
// the other way: the client latch clears only on an explicit operator Clear,
// and Clear posts clear_estop to release the head's latch as well. The field
// lesson behind all of it: E-STOP is the reliable stop -- the server side
// latches the head DIRECTLY, so this works with the MCP server down.
//
// deps:
//   el                 -- needs el.estopBanner, el.estopBannerDetail.
//   toast               -- (message, ok) => void (app.js's own toast()).
//   applyMotionGate     -- () => void; re-applies the combined E-STOP/sun-
//     lock disabled state to every motion control not owned by cockpit.js.
//   refreshCockpitLock  -- () => void; forces an immediate cockpit
//     re-render with the just-changed latch folded in, so the AIM block
//     doesn't wait up to ~1s for the next SSE tick.
// After a successful Clear, a tick that was already in flight can still
// carry the old estop:true. Ignore the head's latch for this long so that
// stale tick does not re-raise the banner the operator just cleared. The
// head itself refuses motion while latched regardless of what this shows.
export const CLEAR_GRACE_MS = 2500;

export function createEstop({ el, toast, applyMotionGate, refreshCockpitLock, now = () => Date.now() }) {
  let latched = false;
  let clearedAt = -Infinity;
  let clearing = false;

  function isLatched() {
    return latched;
  }

  // Latch immediately on click — this is a client-side safety latch, not a
  // reflection of confirmed server state, so it must not wait on the network.
  function latch() {
    latched = true;
    // Visibility is driven by the "show" class, not the [hidden] attribute:
    // an author-stylesheet `display` rule always beats the UA
    // [hidden]{display:none} rule, so relying on `hidden` here would leave
    // the banner stuck.
    el.estopBanner.classList.add("show");
    applyMotionGate();
    refreshCockpitLock();
  }

  function unlatch() {
    latched = false;
    el.estopBanner.classList.remove("show");
    el.estopBannerDetail.textContent = "";
    applyMotionGate();
    refreshCockpitLock();
  }

  // Called with state.rig.estop on every SSE tick. Latches only; never clears.
  function syncFromHead(headLatched) {
    if (headLatched !== true || latched) return;
    if (now() - clearedAt < CLEAR_GRACE_MS) return;
    latch();
    el.estopBannerDetail.textContent = "the head reports its E-STOP latch is set";
  }

  function renderResult(result) {
    if (!result || typeof result !== "object") {
      el.estopBannerDetail.textContent = "no response from server";
      toast("E-STOP: no response from server — remaining latched", false);
      return;
    }
    // head first: it is the leg that actually stops the rig.
    const legs = ["head", "tracking", "agent"];
    const parts = legs.map((leg) => {
      const r = result[leg];
      if (!r) return `${leg}: —`;
      return `${leg}: ${r.ok ? "ok" : "FAIL"} (${r.message})`;
    });
    el.estopBannerDetail.textContent = parts.join(" · ");
    if (result.allOk) toast("E-STOP: head latched, tracking stopped, agent disarmed", true);
    else if (result.head && result.head.ok) toast("E-STOP: head latched (a daemon leg failed — see banner)", false);
    else toast("E-STOP: the HEAD did not confirm — use the physical stop if the rig is moving", false);
  }

  // The #estop button's click handler: latches synchronously, then posts.
  // The response body carries every leg's result even on a 502 (head leg
  // failed), so it is always rendered rather than branching on the status.
  async function trigger() {
    latch();
    try {
      const res = await fetch("/api/control/estop", { method: "POST" });
      const data = await res.json();
      renderResult(data);
    } catch (e) {
      el.estopBannerDetail.textContent =
        `request failed: ${e instanceof Error ? e.message : String(e)}`;
      toast("E-STOP request failed — remaining latched", false);
    }
  }

  // The Clear E-STOP control: releases the HEAD's latch (POST clear_estop),
  // and only then this page's. A failed clear leaves both latched -- the
  // operator must never be shown "resumed" while the head still refuses.
  // Does not re-arm the agent; that is the Auto toggle's job.
  async function clear() {
    if (clearing) return;
    clearing = true;
    try {
      const res = await fetch("/api/control/clear_estop", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const data = await res.json();
      if (data && data.ok === true) {
        clearedAt = now();
        unlatch();
        toast(typeof data.message === "string" ? data.message : "E-STOP cleared", true);
      } else {
        const why = data && typeof data.message === "string" ? data.message : "no response from server";
        el.estopBannerDetail.textContent = `clear failed: ${why}`;
        toast("E-STOP NOT cleared — remaining latched", false);
      }
    } catch (e) {
      el.estopBannerDetail.textContent =
        `clear request failed: ${e instanceof Error ? e.message : String(e)}`;
      toast("E-STOP NOT cleared — remaining latched", false);
    } finally {
      clearing = false;
    }
  }

  return { isLatched, trigger, clear, syncFromHead };
}
