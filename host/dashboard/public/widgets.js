// The left-centre widget stack (RIG / TRIM / TRACKING cards) and its rail of
// show/hide toggles. Visibility is per browser (localStorage); the pure
// parts (load/save/apply/toggle) are pinned by test/widgets.test.ts with fake
// storage/DOM, same pattern as the other public/ modules.

export const WIDGET_IDS = ["rig", "trim", "tracking"];
const KEY = "tb3.widgets";

function allVisible() { return { rig: true, trim: true, tracking: true }; }

export function loadVisibility(storage) {
  const vis = allVisible();
  try {
    const raw = storage && storage.getItem(KEY);
    if (!raw) return vis;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return vis;
    for (const id of WIDGET_IDS) if (typeof parsed[id] === "boolean") vis[id] = parsed[id];
  } catch {
    // Unreadable/absent storage (private mode, junk): everything visible.
  }
  return vis;
}

export function saveVisibility(storage, vis) {
  try { storage && storage.setItem(KEY, JSON.stringify(vis)); } catch { /* best effort */ }
}

export function toggleVisibility(vis, id) {
  return { ...vis, [id]: !vis[id] };
}

// root holds the cards ([data-widget="id"]); rail holds the toggles
// ([data-widget-toggle="id"]).
export function applyVisibility(root, rail, vis) {
  for (const id of WIDGET_IDS) {
    const card = root && root.querySelector(`[data-widget="${id}"]`);
    if (card) card.hidden = !vis[id];
    const btn = rail && rail.querySelector(`[data-widget-toggle="${id}"]`);
    if (btn) {
      btn.setAttribute("aria-pressed", vis[id] ? "true" : "false");
      btn.classList.toggle("rail-on", !!vis[id]);
    }
  }
}

export function wireWidgetRail({ root, rail, storage }) {
  let vis = loadVisibility(storage);
  applyVisibility(root, rail, vis);
  if (rail && typeof rail.addEventListener === "function") {
    rail.addEventListener("click", (evt) => {
      const btn = evt.target.closest("[data-widget-toggle]");
      if (!btn) return;
      vis = toggleVisibility(vis, btn.dataset.widgetToggle);
      saveVisibility(storage, vis);
      applyVisibility(root, rail, vis);
    });
  }
  return () => vis;
}
