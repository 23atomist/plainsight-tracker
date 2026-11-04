// An E-STOP disarms the autonomous agent, whoever latched it. The MCP
// `estop` tool and the dashboard's MCP leg disarm on their own, but a latch
// set any other way (the dashboard's MCP leg timed out, MCP was down at the
// time, another client, the head API directly) used to leave the agent
// armed: it would track_aircraft into the latched head and the session would
// start moving the moment the operator cleared it.
//
// So the daemon disarms on the head's own word: on the `estop` event, and on
// every tick that says the latch is set while the agent is armed. The tick
// check is what catches a latch set while MCP was not watching (the event was
// sent before this process connected): the first tick it sees disarms.
import type { Device } from "../shared/device.js";
import type { AgentArmed } from "../shared/agent-store.js";

export interface EstopDisarmDeps {
  readonly device: Pick<Device, "onEvent" | "onRefTick" | "getState">;
  readonly agent: { get(): AgentArmed; set(armed: boolean): void };
  readonly log: (msg: string) => void;
}

export function wireEstopDisarm({ device, agent, log }: EstopDisarmDeps): void {
  // One log line per latch, however many ticks repeat it.
  let loggedThisLatch = false;
  const onLatched = (seenBy: string): void => {
    if (!agent.get().armed) return;
    let failure = "";
    // AgentStore.set(false) flips memory before it writes the file, so a
    // failed write still leaves this process disarmed.
    try { agent.set(false); }
    catch (e) { failure = ` (persisting the disarm failed: ${e instanceof Error ? e.message : String(e)})`; }
    if (loggedThisLatch && failure === "") return;
    loggedThisLatch = true;
    log(`[estop] head E-STOP latched (seen by ${seenBy}); autonomous agent disarmed${failure}. ` +
      "Clearing the latch does not re-arm it.");
  };
  device.onEvent((e) => {
    if (e.name === "estop") onLatched("event");
    else if (e.name === "estop_cleared") loggedThisLatch = false;
  });
  // onRefTick fires for every tick, with or without axes, after the Device
  // has applied the tick's `estop` to its state.
  device.onRefTick(() => {
    if (device.getState().estop) onLatched("tick");
    else loggedThisLatch = false;
  });
}
