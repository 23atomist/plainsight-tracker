import { AircraftBrief, ChooseInput, Decision, RuleOrderEntry } from "./llm.js";
import { Action, decideAction, failSafeAction } from "./decide.js";

// Mirrors SunSupervisor's IdleParkResult (src/track/supervisor.ts) at the
// agent's own client boundary -- not imported directly, since RigMcpClient is
// the agent's entire contract with the rig and must stay decoupled from
// track/ internals, but the shape must match what park_idle actually reports.
export interface ParkIdleResult {
  readonly parked: boolean;
  readonly reason: string;
}

export interface RigStatus {
  readonly state: string;
  readonly label: string | null;
  readonly pointingErrorDeg: number | null;
  readonly panReferenced: boolean;
  // False while the calibration's pan frame is unverified (a reference of
  // unknown offset from the solve's frame); the daemon refuses automation.
  readonly calibrationVerified: boolean;
}

export interface RigMcpClient {
  // The operator's armed flag (get_agent_armed, spec 6.4). The agent process
  // always runs; while this is false it does nothing at all.
  getAgentArmed(): Promise<boolean>;
  scanAircraft(p: { maxRangeKm: number; onlyTrackable: boolean; onlyEligible: boolean; limit: number }): Promise<AircraftBrief[]>;
  getTracked(): Promise<{ hex: string | null }>;
  // panReferenced: false while the head reports pan's origin unknown (spec
  // 6.8 rule 2); the daemon refuses all automated motion then.
  getStatus(): Promise<RigStatus>;
  track(hex: string): Promise<void>;
  stop(): Promise<void>;
  // Point the rig up between passes so a genuinely idle autonomous rig does
  // not sit wherever the last pass ended -- often the horizon, and the
  // neighbours' houses. Idempotent and guarded server-side (sun-lock,
  // tracking-active, dwell): safe to call on every idle tick. The result is
  // NOT decorative -- runOnce logs a refusal below, since a silent failure to
  // park is exactly the outcome ("pointing at my neighbours for minutes")
  // this feature exists to prevent.
  parkIdle(): Promise<ParkIdleResult>;
}

// Reduces this tick's already-annotated candidates (tier/rule/canPreempt --
// see AircraftBrief) down to one entry per rule that actually produced a
// live candidate, tier-ascending -- see RuleOrderEntry's doc in llm.ts for
// why this is what buildSystemPrompt needs, and why "only rules with a
// current match" is the correct scope (not the full ruleset).
// Number.MAX_SAFE_INTEGER (not a small fixed sentinel like 9) is the
// unknown-tier fallback: this feature's whole point is an arbitrary,
// operator-sized rule count, and a fixed cap silently mis-sorts past it.
function deriveRuleOrder(trackable: AircraftBrief[]): RuleOrderEntry[] {
  const byTier = new Map<number, RuleOrderEntry>();
  for (const a of trackable) {
    if (a.tier === null || a.rule === null) continue;
    if (!byTier.has(a.tier)) byTier.set(a.tier, { tier: a.tier, rule: a.rule, canPreempt: a.canPreempt });
  }
  return [...byTier.values()].sort((x, y) => x.tier - y.tier);
}

export interface LoopState { lastSwitchMs: number; }

export interface LoopDeps {
  client: RigMcpClient;
  choose: (input: ChooseInput) => Promise<Decision>;
  cfg: { maxRangeKm: number; minDwellMs: number };
  now: () => number;
}

export async function runOnce(deps: LoopDeps, state: LoopState): Promise<{ action: Action; state: LoopState }> {
  // Spec 6.4: disarmed means do nothing -- no scan, no model call, no stop,
  // no idle park. Checked first so a disarmed agent costs one cheap MCP call
  // per tick. A pass the operator started by hand is theirs; the agent must
  // not end it just because it is disarmed.
  if (!(await deps.client.getAgentArmed())) {
    return { action: { kind: "keep", reason: "disarmed" }, state };
  }

  // The policy gate still runs BEFORE the model sees anything -- it now runs in
  // the daemon (only_eligible), so the dashboard and the agent share one
  // implementation instead of two that can drift.
  const scanned = await deps.client.scanAircraft({
    maxRangeKm: deps.cfg.maxRangeKm, onlyTrackable: true, onlyEligible: true, limit: 20,
  });
  const trackable = [...scanned].sort((a, b) => (a.tier ?? Number.MAX_SAFE_INTEGER) - (b.tier ?? Number.MAX_SAFE_INTEGER));
  const tracked = await deps.client.getTracked();
  const status = await deps.client.getStatus();

  // Rig-state gates, ahead of the model: with pan's origin unknown (or of
  // unknown offset from the calibration's frame) the daemon
  // refuses tracking and idle park anyway, so there is nothing to decide --
  // and a stop would only churn the follower binding the session is holding
  // for when the reference comes back.
  if (!status.panReferenced) {
    return { action: { kind: "keep", reason: "pan_unreferenced" }, state };
  }
  if (!status.calibrationVerified) {
    return { action: { kind: "keep", reason: "calibration_unverified" }, state };
  }

  const trackableHexes = new Set(trackable.map((a) => a.hex.toLowerCase()));
  const currentHex = tracked.hex ? tracked.hex.toLowerCase() : null;
  const currentHealthy = currentHex !== null && trackableHexes.has(currentHex);

  let action: Action;
  try {
    const decision = await deps.choose({
      trackable,
      current: { hex: currentHex, label: status.label, state: status.state, pointingErrorDeg: status.pointingErrorDeg },
      ruleOrder: deriveRuleOrder(trackable),
    });
    action = decideAction({
      decision, trackableHexes, currentHex, currentHealthy,
      msSinceLastSwitch: deps.now() - state.lastSwitchMs, minDwellMs: deps.cfg.minDwellMs,
      candidateCanPreempt:
        trackable.find((a) => a.hex.toLowerCase() === (decision.hex ?? "").toLowerCase())?.canPreempt ?? false,
    });
  } catch {
    action = failSafeAction(currentHex, currentHealthy);
  }

  // Re-checked immediately before anything that moves the rig: the model
  // call above can take seconds, and an operator turning Auto off in that
  // window must win over the decision made before it.
  const DISARMED: Action = { kind: "keep", reason: "disarmed" };
  let lastSwitchMs = state.lastSwitchMs;
  if (action.kind === "track" || action.kind === "stop") {
    if (!(await deps.client.getAgentArmed())) return { action: DISARMED, state };
    if (action.kind === "track") { await deps.client.track(action.hex); lastSwitchMs = deps.now(); }
    else { await deps.client.stop(); }
  }

  // Nothing being tracked and nothing to track: park up rather than leave the
  // rig wherever the last pass ended. Covers both "just stopped" and "was
  // already idle, still nothing eligible" -- the latter is exactly the
  // multi-minute idle-gap symptom this task exists to fix.
  if (action.kind === "stop" || (action.kind === "keep" && currentHex === null && trackable.length === 0)) {
    // A stop that already happened is still reported as the stop.
    if (!(await deps.client.getAgentArmed())) {
      return { action: action.kind === "stop" ? action : DISARMED, state: { lastSwitchMs } };
    }
    const park = await deps.client.parkIdle();
    // A silent failure to park is exactly the outcome that started this
    // work ("it's been pointing at my neighbours for the last few minutes")
    // -- surface every refusal except the normal steady-state no-op
    // ("already_parked", expected on every idle tick once actually parked).
    if (!park.parked && park.reason !== "already_parked") {
      console.error(`[agent] idle park did not happen: ${park.reason}`);
    }
  }

  return { action, state: { lastSwitchMs } };
}
