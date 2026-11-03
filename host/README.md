# tb3-mcp

Always-on MCP daemon that lets any LLM control the eMotimo TB3 over the network.

## Run

```bash
cd tb3-mcp
npm install
cp config.example.json config.json   # edit deviceHost + limits for your rig
npm run build
npm start                             # serves MCP at http://<host>:8770/mcp
```

Dev mode (no build): `npm run dev`. Tests: `npm test`.

## Configuration

`config.json` (all keys overridable by env, e.g. `TB3_DEVICE_HOST`, `TB3_MCP_PORT`,
`TB3_MCP_TOKEN`, `TB3_MAX_SPEED_DPS`, `TB3_PAN_SIGN`):

| key | default | meaning |
|---|---|---|
| deviceHost | `tb3.local` | TB3 host or `ip:port` |
| mcpPort | `8770` | MCP HTTP/SSE listen port |
| mcpToken | (unset) | if set, clients must send `Authorization: Bearer <token>` |
| panMin/panMax | `-180/180` | pan soft limits (degrees) |
| tiltMin/tiltMax | `-90/90` | tilt soft limits (degrees) |
| maxSpeedDps | `22` | max goto speed (°/s); the firmware caps point-to-point moves at ~22.5°/s (10000 steps/s) |
| maxJogDps | `19` | the manual-jog ceiling (°/s, per axis): `jog` clamps each axis to it, and tracking caps its TRACK feed-forward to it until the head's own `vmax` (`GET /api/config`) has been read (env `TB3_MAX_JOG_DPS`) |
| panSign/tiltSign | `1` | per-axis sign flip (`1` or `-1`) |
| calibrationFile | `~/.tb3-mcp/calibration.json` | where the calibration profile is persisted (env `TB3_CALIBRATION_FILE`) |
| limitsFile | `~/.tb3-mcp/limits.json` | where operator-taught travel limits are persisted — see "Operator-taught travel limits" below (env `TB3_LIMITS_FILE`) |
| trackTickHz | `10` | target-tracking control loop rate (env `TB3_TRACK_TICK_HZ`) |
| trackLeadMs | `150` | how far ahead the tracker aims the servo, to cover command + rig latency (env `TB3_TRACK_LEAD_MS`) |
| trackMaxTargetAgeMs | `12000` | coast budget: how long the servo keeps driving on the estimator's prediction after the newest accepted fix, before it stops and waits (env `TB3_TRACK_MAX_TARGET_AGE_MS`) |
| trackStaleTelemetryMs | `1000` | device telemetry older than this → tracking stops and waits (env `TB3_TRACK_STALE_TELEMETRY_MS`) |
| trackDeadmanMs | `120000` | total silence (no `update_target`/activity) before a tracking session ends outright (env `TB3_TRACK_DEADMAN_MS`) |
| trackReacquireDeg | `10` | pointing error above which tracking stops sending TRACK and re-acquires with a goto (env `TB3_TRACK_REACQUIRE_DEG`) |
| trackFallbackAmaxDps2 | `10` | the acceleration (°/s²) the soft-limit guard assumes for its stopping time until the head's per-axis `amax` (`GET /api/config`) has been read; lower is the safe direction (env `TB3_TRACK_FALLBACK_AMAX_DPS2`) |

**Soft limits refuse out-of-range moves** — there are no endstops. Set them to your rig's real reachable range.

## Tools

`get_status`, `goto_angle`, `jog`, `stop`, `set_home`, `trigger_camera`, `list_programs`, `select_program`.

`goto_angle` is the soft-limit-enforced primitive — out-of-range targets are refused. `jog` takes
`pan_dps`/`tilt_dps` in °/s (user frame, each capped at `maxJogDps`) and `duration_ms`, replies
`jogged for Nms (pan X°/s tilt Y°/s)` with the rates actually sent, and predicts where those rates
would take each axis over the command's own duration, zeroing an axis before it would cross the
effective pan/tilt limit — see "Rate-jog limit enforcement" below. (There are no endstops, so this prediction is the only thing standing between a held-down
jog and the mechanical stop.)

### Web motion is mode-gated on the rig — use "Track (Web)"

The rig only wires the web joystick into actual motor output on screens whose input loop runs
`NunChuckQuerywithEC()` and `updateMotorVelocities2()` with the step ISR armed. On any other
screen the same input drives menu navigation instead, so **`goto_angle`, `jog`, and tracking will
report success but the rig will not move — no error, no hint, just silence.** In Dragonframe slave
mode the firmware runs a separate blocking loop that doesn't pump the web input path at all, so
`jog`, `goto_angle`, and even `stop` are all dead. **If a command stops moving the rig, check the
rig's own LCD screen first.**

**This is why a dedicated "Track (Web)" mode exists** — program index **8**, the last entry in the
rig's program menu (`select_program` with `index: 8, commit: true`, or pick it on the LCD). It
runs the velocity engine on a screen of its own, so tracking motion just works and stays working.
Use it for anything driven by layer 3.

> ✅ **Hardware-verified 2026-07-16** (camera removed). Selected purely over HTTP
> (`POST /api/program {"type":8,"select":true}`); LCD showed `Track (Web)` + the STA IP; jog moved
> the rig at 2.05 °/s at deflection 50 against a cubic-model prediction of 2.02; **a `goto`
> followed by a jog still moved** (the step ISR is correctly re-asserted — this was the mode's
> main design risk); and C+Z exited to the menu without bouncing back in. Two behaviours to know:
> `/api/stop` does **not** halt a jog (see below), and the exit is deferred while a `goto` is
> in flight, so send it once the rig is idle. Tracking a real moving target end-to-end has still
> not been done.

The gating detail is still worth knowing for diagnosing "the rig silently doesn't move" on the
other screens. The point-setting screens do pump the web input path: **"Move to Start Pt"** /
**"Move to End Pt."** (`Move_to_Startpoint()` / `Move_to_Endpoint()`, `src/_TB3_LCD_Buttons.ino`),
**"Move to Point"** (`Move_to_Point_X()`, `src/_TB3_LCD_Buttons.ino:452-506` — reached from
3-point moves, the panorama corner point, and the portrait-pano subject point), and **"Set Angle
o'View"** (`Set_angle_of_view()`, `src/TB3_PANO.ino:69-113`). They are not, however, a substitute
for Track (Web): a stray C press advances the program and silently kills tracking. (Note these
screens do not each call `DFSetup()` themselves — "Move to End Pt." only calls `startISR1()` and
inherits the rest of the motion setup from the "Move to Start Pt" screen that always precedes it.)

## Geo-pointing (layer 2)

Azimuth/elevation pointing requires a **calibration** that solves the mount's orientation from two sightings of known landmarks. Once calibrated, use `point_at` (geographic target) or `point_at_azel` (absolute azimuth/elevation).

### Calibration Workflow

1. **`set_rig_location`** — Set the rig's fixed WGS84 location (lat/lon/height). Clears any prior sightings and solution.
2. **Aim and sight** — Using the camera feed and `jog` to fine-tune, aim at a well-known landmark (e.g., a distant building or mountain), then call **`sight_landmark`** with its lat/lon/height and optional label. Capture the *current* pan/tilt as a sighting.
3. **Repeat** — Aim at a second landmark well-separated in azimuth (ideally >15° apart) and call `sight_landmark` again. Two sightings are required.
4. **`solve_calibration`** — Solves the mount's 3D orientation (heading and level) from the two sightings using TRIAD. Reports landmark separation (warn if <15°), heading, and base tilt. The solution is persisted to disk.
5. **`point_at`** or **`point_at_azel`** — Once calibrated, point at any geographic target or absolute azimuth/elevation. Blocks until arrival.

### Tools

| Tool | Purpose |
|---|---|
| `set_rig_location` | Set the rig's WGS84 position (lat, lon, height_m); clears sightings. |
| `sight_landmark` | Record the *current* pan/tilt as a sighting of a landmark (aim first via live feed + jog). Returns sighting slot (1/2 or 2/2). Warns if rig was moving. |
| `solve_calibration` | TRIAD-solve the mount orientation from two sightings. Reports heading (°), base tilt (°), and landmark separation (°). Persists solution. |
| `point_at` | Point at a geographic target (lat, lon, height_m). Requires calibration. Returns azimuth, elevation, range, and final pan/tilt. |
| `point_at_azel` | Point at absolute azimuth/elevation. Requires calibration. Returns final pan/tilt. |
| `get_calibration` | Report the full calibration profile: rig location, sightings, solved orientation, timestamp. |
| `clear_calibration` | Erase the calibration profile. |

### Documented Assumptions

- **Height datum**: Rig height and target heights *must* share the same vertical datum (both WGS84 ellipsoidal or both orthometric MSL). Mixing datums introduces a constant bias. The code does not model geoid separation because it cancels locally.
- **Out of scope**: Atmospheric refraction and lever-arm offset (distance from mount zero to camera). Both are small for typical applications (<0.5° refraction near horizon, <0.1° lever-arm error on distant targets).

## Target tracking (layer 3)

Continuously follow a **moving** geographic target. Requires a solved layer-2 calibration.

Unlike every other tool here, the tracking tools **return immediately** — tracking runs in the
background (a control loop at `trackTickHz`) and outlives the call. Poll `get_tracking_status` to
see how it's doing.

The servo itself runs on the head: every tick the session sends one `POST /api/track` with, per
axis, the **setpoint** (`pos`: the target's pan/tilt at `trackLeadMs` ahead, plus the standing aim
offset, resolved into the reachable range) and the **feed-forward** (`vel`: the target's angular
rate, capped at the head's `vmax`). The Pico extrapolates the setpoint at that rate and servos the
axis onto it between ticks; if the TRACK updates stop, the Pico stops the axis on its own
(`track_timeout`). The host keeps everything that decides *whether* and *where* to point —
estimator, offset, sector, floor, soft-limit guard, sun guard, reacquire — and the head does the
following.

### Workflow

1. **Calibrate** (layer 2) — `set_rig_location`, two `sight_landmark`s, `solve_calibration`.
2. **`start_tracking`** with the target's lat/lon/height, ideally plus `speed_mps` + `heading_deg`
   (+ `climb_mps`). The rig slews to acquire (a `goto`), then the head follows it (a
   TRACK every tick). A `speed_mps` given without `heading_deg` drops the *entire* stated velocity for that
   call, `climb_mps` included; `climb_mps` alone is a valid pure-vertical velocity only when
   `speed_mps` is omitted entirely.
3. **`update_target`** with each new fix; this refreshes the deadman. **A stated velocity is not
   remembered across calls** — every `start_tracking`/`update_target` call replaces the stated
   velocity outright, including replacing it with "none" if that call omits `speed_mps`/
   `heading_deg`. Whenever no velocity is stated on a given call, the estimator silently falls back
   to a least-squares fit over the recent fix window instead, which is noisier. To keep tracking
   running on a stated velocity, resend `speed_mps` + `heading_deg` (and `climb_mps`, if used) on
   *every* `update_target` call, not just the first.
4. **`get_tracking_status`** to read state, target az/el/range, rig pan/tilt, the **measured**
   pointing error, and whether the servo is currently riding prediction (`coasting`).
5. **`stop_tracking`** when done. The layer-1 `stop` tool also ends tracking before halting the
   device — `stop` always wins.

### Tools

| Tool | Purpose |
|---|---|
| `start_tracking` | Begin following a target: `lat`, `lon`, `height_m` (required), optional `speed_mps`, `heading_deg`, `climb_mps`, `label`. Returns immediately. |
| `update_target` | Feed a new fix for the target being tracked (same fields as `start_tracking` minus `label`). Refreshes the deadman. |
| `get_tracking_status` | State, wait reason (if any), label, target az/el/range, target & rig pan/tilt, measured pointing error, commanded pan/tilt rates (plus `pan_limited`/`tilt_limited` if the soft-limit guard is holding that axis at zero), target/telemetry data age, and `coasting` (the aim is riding prediction — see below). |
| `stop_tracking` | End the session and halt tracking motion. |

### States

`acquiring` (slewing onto the target) → `tracking` (the head's TRACK servo) ⇄ `waiting` (motion stopped,
still estimating) → `stopped`. It auto-reacquires (drops back to `acquiring`) once the target is
reachable and fresh again, or once pointing error exceeds `trackReacquireDeg` while tracking.

A `waiting` status carries a `reason`:

| reason | meaning |
|---|---|
| `below_tilt_limit` / `pan_limit` | the target is outside the configured soft limits |
| `target_stale` | no *accepted* fix newer than the coast budget (`trackMaxTargetAgeMs`, default 12s) — send `update_target` |
| `telemetry_stale` | the *rig* has gone quiet for `trackStaleTelemetryMs`; a real fault — check the link |
| `estop` | the head's E-STOP is latched (`get_status.estop`); tracking holds until it is cleared |
| `not_calibrated` | no solved layer-2 orientation |
| `goto_failed` | the acquire goto failed — arrival timeout, transport error, or a device rejection. The head accepts a goto while moving and retargets, so a reacquire never has to wait for the rig to come to rest first |

`goto_failed` and `telemetry_stale` are deliberately separate: a failed goto is reported as itself,
never blamed on a perfectly healthy link.

Entering `waiting` (or `stop_tracking`) stops the head **once** — the stop is edge-triggered, not
repeated every waiting tick — and no TRACK is sent while waiting or acquiring.

### Prediction, coasting, and smoothing

ADS-B position reports are quantized, late (`seen_pos` is typically 2-3s on this feed), and stop
decoding entirely for seconds at a time — and a tracker that only moves when a report lands
stutters, stalls on re-served stale positions, and freezes mid-pass whenever messages drop out.
The estimator (`src/track/estimator.ts`) sits between the feed and the servo to fix exactly that:

- **Smoothed anchor**: raw fixes nudge the extrapolation origin by a fixed fraction
  (`ANCHOR_ALPHA`, 0.35) of their innovation rather than resetting it, so report-to-report noise
  and `seen_pos` jitter become small aim corrections instead of jumps. A correction that arrives
  within one poll interval of the last fix is adopted outright — it restates where the aircraft is
  *now* (and it is what the sector/floor/limit gates evaluate).
- **Velocity**: the stated ADS-B velocity when present; otherwise a least-squares fit over the
  recent fix window (≈8s / 8 fixes), which averages position noise instead of amplifying whatever
  the two nearest samples say.
- **Repeat rejection**: decoders keep re-serving the LAST position with a growing `seen_pos`
  whenever position messages stop. Repeats carry no new information — they are ignored for state
  (so they can neither flatten the estimated velocity nor manufacture freshness) but a stated
  velocity arriving alongside one is still admitted.
- **Turn-aware coasting**: the fitted turn rate bends the prediction along an arc while coasting,
  capped at 6°/s and zeroed below ~5 m/s groundspeed where heading differences are noise.
- **Outlier gate**: a fix farther from the prediction than real flight could explain (≥500m beyond
  what speed × gap + capped-turn geometry allows) is rejected, so one bad decode cannot yank the
  rig.

Coasting keeps the rig moving through dropouts: `get_tracking_status` reports `coasting: true`
once the newest accepted fix ages past ~two poll intervals, and the servo keeps driving on the
prediction until the coast budget (`trackMaxTargetAgeMs`) expires — all safety gates (sector,
floor, soft limits, sun guard) keep running every tick regardless. Smoothing between ticks is the head's: the
Pico extrapolates each TRACK setpoint at its feed-forward rate, so a 10 Hz host loop does not
reach the glass as 10 Hz steps.

### Arbitration

Tracking and manual control cannot fight over the rig: while a tracking session is active,
`goto_angle`, `jog`, `set_home`, `point_at`, and `point_at_azel` all refuse with `"tracking
active; stop_tracking first"`. `stop` is deliberately **not** guarded — it is the escape hatch and
always wins, stopping tracking and halting the device in one call.

### Safety

Tracking is the only thing here that commands sustained motion with **no human in the loop**, and
the rig has **no endstops**, so several independent layers back it up:

- **Soft-limit prediction**: the tracking session checks the *predicted* position ahead of the
  rig and stops that axis before it would cross a limit. The lookahead is **computed, not
  fixed**, per axis: how stale the telemetry is, plus one tick period, plus the head's stopping
  time for the feed-forward rate (`|rate| / amax`, with `amax` from the head's `GET /api/config`,
  or `trackFallbackAmaxDps2` until that has been read). The prediction runs at the full rate for
  the whole horizon, deliberately over-estimating. A blocked axis is sent a `STOP` for that axis
  (once, when the hold begins) and left out of the TRACK until the guard releases it — never a
  clamped TRACK, which the Pico would keep extrapolating toward the limit. The guard reports which
  axis (if any) it is holding via `pan_limited`/`tilt_limited` in `get_tracking_status`
  (`commanded_*_dps` reads `0` for it), so a held axis is diagnosable instead of looking
  identical to "the servo is happy". The manual `jog` tool uses the same predict-then-zero idea
  over the command's own duration — see "Rate-jog limit enforcement" below.
- **Command ordering**: two HTTP requests can reach the head in either order. A stop sent while a
  TRACK is still unanswered is sent again once that TRACK has been answered (unless the session
  has commanded motion again since), so a late TRACK cannot restart a stopped axis; and an acquire
  goto waits for any unanswered TRACK or stop, so neither can replace or cancel it.
- **Stale-data gates**: stale device telemetry (`trackStaleTelemetryMs`; a tick without axes,
  which the head publishes while its Pico link is down, does not count as fresh), a stale target
  fix (`trackMaxTargetAgeMs`), or the head's E-STOP all move the session to `waiting` and stop
  motion.
- **Deadman**: `trackDeadmanMs` of total silence (no `update_target`/activity) ends the session
  outright.
- **Head-side track timeout**: independently of the host, the Pico stops an axis whose TRACK
  updates stop (`track_timeout_ms`, default 1000) — the backstop for a stalled or dead host
  process, and for a stop the head refused (a refused stop is retried on the next waiting tick).

### Rate-jog limit enforcement

The `jog` tool is the one motion path both the dashboard's press-and-hold control and the USB
joystick drive — there is no third way to command a rate (both post to `/api/control/jog`, which
calls this exact MCP tool). Each axis's rate is first capped at `maxJogDps`. Before commanding the device, `jog` predicts where that rate
would take each axis over the command's own `duration_ms` and, per axis independently, zeroes the
rate if that prediction would cross the *effective* pan/tilt limit (see "Operator-taught travel
limits" below) — the same predict-then-zero pattern the tracking session's soft-limit guard uses,
just with the command's own duration standing in for the tracking guard's computed ramp-down
horizon.

Two things this deliberately preserves:

- **Motion away from a limit is always allowed.** The prediction only blocks a rate that would
  leave the effective range — moving back toward center, even starting exactly at the limit,
  predicts a position that's still in range and is never blocked. An operator sitting at a limit
  is never trapped with no way back.
- **Only the offending axis is held.** Pan and tilt are checked independently; jogging diagonally
  away from one axis's limit while approaching the other's holds just the one that's actually
  at risk.

A held axis is **surfaced, not silent**: the tool's response text names which axis was held (e.g.
`... — held at travel limit: pan`), so "I've stopped because I'm at the limit" reads differently
from "the control is broken" instead of the operator pushing harder into a stop that will never
give.

### Operator-taught travel limits

`panMin`/`panMax`/`tiltMin`/`tiltMax` in `config.json` are a **ceiling**, not necessarily the rig's
real reachable range — gyro wiring and the tilt-axis stepper wiring can constrain real travel
tighter and asymmetrically, in a way that's only discoverable by feel. Three tools let an operator
narrow that ceiling per edge, independently, without touching `config.json`:

- **`teach_limit`** — jog carefully to where a cable just begins to tension, then call this with
  `edge: "pan_min" | "pan_max" | "tilt_min" | "tilt_max"` to capture the CURRENT position as that
  edge. A captured position outside the configured ceiling is **clamped** to it (reported via
  `clamped: true`) — a taught limit can only ever be *tighter* than config, never wider.
- **`get_taught_limits`** — reports what has been taught (`null` per edge if never taught), the
  config ceiling, and the resulting `effective` range: whichever is tighter, per edge.
- **`clear_taught_limits`** — erases every taught edge, reverting the effective range to the
  config ceiling.

Taught limits persist to `limitsFile` (default `~/.tb3-mcp/limits.json`, see Configuration above)
and survive a daemon restart. **Every** enforcement path — `jog`, `goto_angle`, tracking's
soft-limit guard, and `point_at`/`point_at_azel` — resolves and uses this same effective
(taught-or-config) range; a limit enforced against only the config ceiling in one of those paths
and the taught value in another would just be this section's bug moved somewhere else.

Because a taught limit is a captured position relative to the software zero, **`set_home` clears
every taught edge** the same way it already clears layer-2 calibration (`R` was tied to the old
zero) — re-teach the edges (and re-calibrate) after re-homing.

The dashboard's 3D rig view (see Operations Dashboard below) renders the effective envelope
directly: a thin arc for each axis's permitted sweep, colored green/amber/red as the current pose
nears or reaches an edge, and the boresight arrow itself turns red at a limit.

### Accuracy

v1 does not promise a pointing-accuracy figure — the stance here is "measure and report,
best-effort." `get_tracking_status` reports the measured `pointing_error_deg` every tick; use it
to judge how well tracking is doing for your rig and calibration. A closed-loop **simulation**
(`test/tracking-sim.test.ts`, not hardware) holds pointing error near 0.03° on a crossing
pass, but it flatters the head in known ways:

- **The fake head's TRACK servo is a first-order stand-in** (feed-forward plus a 5/s catch-up,
  capped at its goto speed, `test/fake-head.ts`), not the Pico's real servo, and it accelerates
  instantly. **The Pico's TRACK has not yet been run against the real mechanics** (design spec
  §6.2): bring-up has a bench step that drives TRACK with a synthetic moving target and checks
  following error before the host tracking port is accepted.
- **Telemetry is fast and fresh.** The fake publishes at 20 Hz over loopback; the soft-limit
  guard's horizon accounts for older readings, but the following error on hardware will reflect
  the real link.

Real-hardware error should therefore be expected to run higher than the simulation.
**No accuracy claim has been validated on the physical rig.** If tracking looks off, check
layer-2 calibration quality first, then the head's TRACK following on the bench.

## Sun position and the shadow test

The rig has no light-block guard yet (Phase 2 of the sun-avoidance work); for now, safety around
the sun is a **pre-flight check plus a manual bench test**, not an enforced lockout.

**`get_sun`** is the pre-flight readout: it reports the sun's current azimuth/elevation, the
daemon's `assumed_utc`, and — once calibrated — the boresight→sun separation. Read it before any
session where the rig might swing near the sun. `above_horizon` tells you whether there's a sun to
avoid at all; `boresight_separation_deg` is only populated once layer 2 is calibrated, since it
needs the solved orientation to know where the boresight is actually pointing.

### The shadow test (bench, camera removed)

The shadow test measures the one number that actually matters for a sun guard: your calibration's
orientation error (`R`) combined with any clock error, in degrees. It validates both at once — a
1-hour clock error moves the computed sun by ~15° of azimuth, with no other symptom, so this is
also how you catch a wrong clock before it ever matters.

Run `scripts/sun-guard-probe.mjs` (build first — it imports the compiled `dist/geo/sun.js` so the
solar math is never duplicated between the probe and the daemon):

```bash
npm run build
node scripts/sun-guard-probe.mjs <LAT> <LON> [HEIGHT_M=0]
# e.g. node scripts/sun-guard-probe.mjs 33.4484 -112.074
```

It prints the sun's current az/el and the procedure:

1. **Confirm the daemon's clock** — the assumed UTC must match the real world. This is the step
   that's easy to skip and the one the whole test exists to catch.
2. **REMOVE THE CAMERA.** The rig is about to point directly at the sun; a lens there burns.
3. Point the rig at the printed azimuth/elevation with **`point_at_azel`**.
4. Aim a straight rod or edge along the boresight and read its shadow. Dead-on the sun, the shadow
   collapses to a point.
5. **Any offset from a point IS your combined `R` + clock error, in degrees.**
6. Size the exclusion cone from that measurement:
   `R_error + FOV/2 + ~0.5° tracking + 0.27° sun radius + margin`. Phase 2 will consume this as
   `set_sun_guard cone_deg=<that>`.

Run this on the first clear day before trusting the rig anywhere near the sun, and re-run it
whenever calibration is redone or the daemon's clock is suspect.

## Sun guard

Phase 2 of the sun-avoidance work: an **always-on supervisor**, active whenever layer 2 is
calibrated *and* the sun is above the horizon, that parks the rig away from the sun before it
gets there. It is not a hold — because the sun moves, the correct response to a trip is an
**active park to a safe attitude**. The daemon starts it
unconditionally (`supervisor.start()` in `server.ts`); `enabled` (below) is the runtime on/off
switch, checked every tick, so disabling it doesn't stop the supervisor from running — it stops it
from acting. It ticks at `sunGuardTickHz`.

### Tools

| Tool | Purpose |
|---|---|
| `get_sun` | Now also reports guard state: `guard_state`, `guard_reason`, `guard_enabled`, `cone_deg`, `park_tilt_deg`, `locked`. |
| `set_sun_guard` | `enabled` (bool, master on/off), `cone_deg` (exclusion half-angle, degrees), `park_tilt_deg` (tilt to park at on trip), `clear_lock` (bool, releases a standing lockout). All optional; call with just `clear_lock: true` to clear a fault without touching the other settings. |

`get_sun`'s `guard_state` is one of `disabled` (uncalibrated, sun below horizon, or manually
disabled — check `guard_reason`), `monitoring`, `parking`, `parked`, or `fault`.

### Sizing the cone

`cone_deg` should be sized from the shadow test above, not guessed:

```
R_error + FOV/2 + ~0.5° tracking + 0.27° sun radius + margin
```

`R_error` (and any clock error) is exactly what the shadow test measures. Relevant config keys
(`config.json`, all env-overridable):

| key | default | meaning |
|---|---|---|
| sunGuardEnabled | `true` | master enable (env `TB3_SUN_GUARD_ENABLED`) |
| sunConeDeg | `25` | exclusion half-angle around the sun, degrees (env `TB3_SUN_CONE_DEG`) |
| parkTiltDeg | `-20` | tilt to park at when the guard trips (env `TB3_PARK_TILT_DEG`) |
| sunGuardTickHz | `10` | supervisor tick rate (env `TB3_SUN_GUARD_TICK_HZ`) |

The shipped default `sunConeDeg = 25` is a conservative placeholder, not a validated figure for
any particular rig/lens — run the shadow test and set `cone_deg` from your own measured `R_error`
before relying on it.

### Guarded tools

While the guard is locked, every tool that moves the rig or changes the calibration/program it
depends on refuses with:

```
sun guard active; blocked to protect the camera — clear it with set_sun_guard
```

That covers **motion** — `goto_angle`, `jog`, `set_home`, `point_at`, `point_at_azel`,
`start_tracking`, `update_target` — and the **state-change** tools that would otherwise silently
release the lock by dropping calibration or engaging a rig program: `set_rig_location`,
`sight_landmark`, `solve_calibration`, `clear_calibration`, and `select_program`. The supervisor
also re-stops any tracking session every tick while locked, so a track started in a race with the
gate is halted within one tick rather than slewing the rig on the goto path (which the jog latch
does not cover).

`stop` and `stop_tracking` are deliberately **not** guarded — they're the escape hatches and must
always work; `get_sun`/`get_tracking_status`/`get_calibration` are read-only. `set_home`, once you
clear the lock and run it, still clears layer-2 calibration (`R` was tied to the old zero), which
drops the guard to `disabled`/`uncalibrated` until you re-calibrate — **the rig is unprotected in
that window**, so re-calibrate before relying on the guard again.

### Park behavior

On a trip the supervisor stops any tracking session, clears any manual jog, locks out the guarded
tools (above), and plans a path with `planPark` (`src/track/sunguard.ts`):

1. **Direct**: tilt straight down to `park_tilt_deg` at the current pan, if that sweep stays clear
   of the exclusion cone. (The bar is per-leg `min(cone, separation-at-leg-start)`: a normal
   outside-the-cone trip only requires the sweep to stay outside the cone — it may approach as
   close as the cone edge — while an already-in-cone start gets the looser "never closer than the
   start" bar described below.)
2. **Pan detour (an L)**: if not, swing pan clear of the sun's azimuth first, *then* tilt down —
   two waypoints flown in that order, each checked as its own sweep.
3. **No safe path**: if neither clears the sun, the supervisor does **not** guess a move — it
   faults (`no_safe_park_path`) and holds where it is.

A position that starts *inside* the cone (the case the guard exists for — the sun drifted onto the
boresight) is held to a looser bar on its first leg: it only has to move away without getting
closer, not clear the full cone immediately, since demanding that would leave the rig frozen on
the sun. Every waypoint is flown as its own `goto`; if one is rejected (e.g. `select_program`
racing the guard's move, see below) the supervisor retries the same waypoint next tick, and gives
up — faulting with `park_unreachable` — after 50 consecutive rejections (~5s at the default 10Hz
tick).

### Fail-closed

Stale device telemetry or a failed sun-position calculation means the supervisor doesn't reliably
know where the boresight or the sun is — it stops and locks (`telemetry_stale` /
`sun_calc_failed`) rather than compute a park from an unknown position. A fault is **sticky**: the
supervisor will not silently re-evaluate and resume once the triggering condition clears (a flaky
telemetry link would otherwise bounce fault → park → fault with no durable, operator-visible
alarm). Only `set_sun_guard` with `clear_lock: true` — a human decision — leaves `fault`, `parked`,
or `parking`.

### The jog latch

Locking doesn't just clear the rig's current jog vector once — it latches. While locked, the
daemon's jog keep-alive (which re-sends the vector every ~100ms for the duration of a `jog` call)
becomes a no-op, so a jog that was already in flight when the trip happened is actually stopped,
not momentarily cleared and then re-armed by the next keep-alive frame.

### Explicitly NOT protected against

This is the most important part of this section — know what the guard does *not* cover:

- **A stopped daemon.** The supervisor is a loop inside the daemon process; if the daemon isn't
  running, nothing is watching the sun. Park the rig down manually before ending a session.
- **A program engaged *before* a trip.** A client can no longer *start* a program while the guard
  is locked (`select_program` is gated). But if a rig program was already engaged when the guard
  trips, the daemon can't reliably interrupt it: the firmware rejects (409) the guard's park move
  repeatedly until it gives up and faults, while the program keeps driving the rig with no sun
  awareness. The fix — having the guard call `/api/stop` to break a running program out — **is
  deferred to the hardware session**, because whether `/api/stop` actually interrupts a *running
  firmware program* is unverified on this rig (the bench already found `/api/stop` had surprising,
  mechanism-specific behavior against a streaming jog). Until then: don't leave a rig program
  engaged while relying on the sun guard. (On a fault the guard does now fire `/api/stop`, but its
  effect on a running program is exactly the unverified piece.)
- **The physical nunchuck.** The supervisor reacts to whatever telemetry shows the boresight
  doing — including motion driven by the physical joystick — and will park against it, but it has
  no way to gate the rig's own hardware joystick input at the source.
- **Clouds.** Not modeled. This is intentionally conservative: the guard protects the sun's
  computed true position regardless of whether it's currently visible, so an overcast sky doesn't
  relax the exclusion.
- **The clock.** A wrong UTC moves the computed sun with no other symptom. `get_sun` reports the
  `assumed_utc` it's using; the shadow test (above) is what actually validates it against reality.
- **Hardware.** The entire guard — trip detection, park planning, the jog latch, the fail-closed
  paths — is built and unit-tested against the mock device only. It has never run against the
  physical rig. Treat it as unverified until it has been exercised on hardware, ideally alongside
  a repeat of the shadow test.

## Operations Dashboard

A web-based control and monitoring interface for the TB3 rig, accessible from any LAN browser. The dashboard aggregates real-time status, telemetry, and camera video from the daemon, provides manual motion controls, and includes a direct **E-STOP** button that halts all motion and disables autonomous tracking.

### Run the Dashboard

```bash
npm run dashboard
```

The dashboard server binds to the address and port in `config.json` (`dashboardBind` and `dashboardPort`; defaults are `0.0.0.0:8788`). Open your browser to:

```
http://<host-lan-ip>:8788
```

Example: `http://192.168.4.104:8788`

### Features

- **Service LEDs** — real-time status of the MCP daemon and (if enabled) the autonomous agent (`tb3-agent`)
- **Telemetry display** — current pan/tilt, movement state, program mode
- **3D rig view** — a schematic pose of the rig plus the effective pan/tilt travel envelope (see
  "Operator-taught travel limits" above), colored green/amber/red as the current pose nears or
  reaches an edge
- **Camera panel** — live video stream from the D5000 (or fallback still frames if streaming is unavailable)
- **Manual controls** — jog and goto (point-to-point) motion
- **Tracking from ADS-B** — browse and manually track aircraft from the ADS-B source (if enabled)
- **Calibration panel** — set location, record landmark sightings, solve and view the geo-pointing calibration
- **Auto toggle** — start/stop the autonomous agent (`tb3-agent`); requires `systemctl` permission (see HOST-SETUP.md)

### E-STOP Behavior

The **E-STOP** button is a hard stop that:

1. **Direct to firmware** — sends `/api/stop` directly to the rig, halting all motion immediately
2. **Stops tracking** — if a tracking session is active, it terminates the session
3. **Stops the agent** — if the Auto toggle is on, the button also stops `tb3-agent` (the autonomous control daemon)

The E-STOP **latches** (remains "pressed") until the **Clear** button is clicked, preventing accidental re-engagement while motion is still settling.

### On-Host Setup

Camera access and `systemctl` permissions require one-time setup on the host. See **`deploy/HOST-SETUP.md`** for:

- Releasing the D5000 from gvfs (`gvfs-gphoto2-volume-monitor`)
- Installing `ffmpeg` for video transcoding
- Setting up `systemctl` permission for the Auto toggle
- Auth configuration (`dashboardAuth` + `mcpToken`)
- Network and service installation

## Layer 4 — ADS-B target source

An optional ADS-B poller that feeds live aircraft into layer 3 tracking, gated entirely by
`adsbEnabled` (default **off**). With it off the daemon behaves exactly as before — the source is
constructed but never started, and the three tools below simply report nothing to scan or track.

`AdsbSource` polls a `dump1090`/`readsb`-style `aircraft.json` endpoint at `adsbUrl` (`adsbPollHz`
times per second) and enriches each aircraft with rig-relative azimuth/elevation/range plus the
objective trackable flags (`reachable`, `sun_safe`, `slew_ok`) computed against the current
layer-2 calibration and sun guard state. `AdsbFollower` binds to one aircraft's ICAO hex and pushes
each fix into the layer-3 `TrackingSession` (`start`/`updateTarget`), releasing the bind after
`adsbLostSec` with no usable fix.

### Tools

| Tool | Purpose |
|---|---|
| `scan_aircraft` | List currently-seen aircraft, enriched with azimuth/elevation/range and trackability flags. Defaults to only the trackable ones, nearest-first. |
| `track_aircraft` | Begin tracking one aircraft by ICAO hex (must currently be trackable per `scan_aircraft`). Binds the follower and pushes the first fix into the tracking session. |
| `get_tracked_aircraft` | Report which hex (if any) the follower is bound to, how long since its last usable fix, and the last follower error. |

### Configuration

| key | default | meaning |
|---|---|---|
| adsbEnabled | `false` | master on/off for the poller (env `TB3_ADSB_ENABLED`) |
| adsbUrl | `http://127.0.0.1/data/aircraft.json` | source `aircraft.json` endpoint (env `TB3_ADSB_URL`) |
| adsbPollHz | `1` | poll rate, Hz (env `TB3_ADSB_POLL_HZ`) |
| adsbMaxRangeKm | `100` | default max slant range for `scan_aircraft` (env `TB3_ADSB_MAX_RANGE_KM`) |
| adsbLostSec | `15` | seconds without a usable fix before the follower releases the tracked hex (env `TB3_ADSB_LOST_SEC`) |
| adsbAltSource | `auto` | which altitude field to prefer: `auto` (geometric, falling back to barometric), `geom`, or `baro` (env `TB3_ADSB_ALT_SOURCE`) |

Layer 4 also includes a **host agent** — a separate process that talks to a local LLM and drives
these tools autonomously (`npm run agent`, added in Task 12) — plus its own config keys (`llmUrl`,
`llmModel`, `agentTickSec`, `agentMinDwellSec`, `agentMcpUrl`) already present in
`config.example.json`. It is not part of the always-on daemon started by `npm start`.

## Vision-lock (camera-assisted aim correction)

A small correction loop that refines ADS-B-driven tracking against what the camera actually
sees: a YOLO sidecar (`services/detector/`, a separate FastAPI/CUDA process — see its own
README for setup) finds the aircraft in each captured frame, and the loop nudges the aim
through the same bounded path as `nudge_aim_offset` when the detection lands near where ADS-B
predicted it would. **Off and read-only by default** — both must be switched on deliberately
(`set_vision_enabled`), and the daemon boots with neither enabled, no matter what the last
session left it at.

### Tools

| Tool | Purpose |
|---|---|
| `get_vision_status` | Enabled/read-only, the last tick's outcome and correction, the measured focalPx/latencyMs scale, the frame size vision believes the camera delivers, and whether the detector sidecar is reachable. Also surfaced on the dashboard cockpit's Tracking panel (`Vision:` row). |
| `set_vision_enabled` | Turn the loop on/off, and independently switch read-only vs. active. Refuses to enable when the current `cameraSource`'s frame size spec doesn't parse (see `resolveVisionFrameSizePx` in `src/vision-tools.ts`). |
| `calibrate_vision_scale` | Command a small pan step and recover `focalPx`/`latencyMs` from the detector's tracked displacement. Requires tracking to be stopped and a reachable detector. Persists across a daemon restart; re-run after any zoom change. |

### Configuration

| key | default | meaning |
|---|---|---|
| visionEnabled | `false` | master on/off (env `TB3_VISION_ENABLED`) |
| visionReadOnly | `true` | observe-and-log vs. apply corrections (env `TB3_VISION_READ_ONLY`) |
| visionDetectorUrl | `http://127.0.0.1:8001/detect` | the sidecar's `/detect` endpoint (env `TB3_VISION_DETECTOR_URL`) |
| visionDetectorTimeoutMs | `2000` | per-call timeout against the sidecar (env `TB3_VISION_DETECTOR_TIMEOUT_MS`) |
| visionTickHz | `1` | correction loop rate, Hz (env `TB3_VISION_TICK_HZ`) |
| visionGain | `0.3` | fraction of the measured error applied per tick, capped at 1 (env `TB3_VISION_GAIN`) |
| visionGateRadiusPx | `120` | how far (px) a detection may sit from the ADS-B-predicted pixel and still be accepted (env `TB3_VISION_GATE_RADIUS_PX`) |
| visionMinConf | `0.25` | minimum detector confidence to accept (env `TB3_VISION_MIN_CONF`) |

These four are still plain config (not yet routed through a hot-reloadable `TuningStore` —
no such store exists in this tree as of this writing); changing them needs a daemon restart.

### On-rig acceptance procedure

Off-rig tests (this repo's ~1300 unit/integration tests) cannot establish whether the YOLO
sidecar actually detects real aircraft, at real ranges, against real sky and terrain. That
question can only be answered on the roof, and read-only mode exists specifically so it gets
answered *before* the loop has any authority over the rig. **Do not skip steps 3–4.**

1. Install the sidecar venv and systemd unit per `services/detector/README.md`'s own Setup
   section (the operator runs the `sudo`/systemd steps by hand — this host requires a
   password for sudo, and neither step should be attempted by an agent). Confirm
   `curl http://127.0.0.1:8001/health` returns `{"ok": true}`.
2. Run `calibrate_vision_scale` with the rig on a tracked target. Confirm the returned
   `focalPx` and `latencyMs` are recovered (not null/zero) and that the corresponding field of
   view (`fovDegFromFocalPx` on that focal length) is a plausible number for the lens actually
   mounted — not, say, 2x or 0.5x what it should be (see `vision-tools.ts`'s inference-space
   mismatch guard for what a wrong factor there looks like).
3. **Run a full pass with `visionReadOnly: true` (the default) before ever setting it false.**
   Nothing moves in this mode — the loop only observes and logs what it *would* have done.
   Watch `get_vision_status` (or the dashboard's `Vision:` row) through the whole pass and
   collect the logged would-be corrections (`last_correction_pan_deg`/`last_correction_tilt_deg`
   each tick they appear) alongside every outcome, not just the ones where a correction was
   produced.
4. Compare that logged read-only record against the operator's own manual trims over the same
   pass. They must agree in sign, and be within roughly a degree, before the loop is trusted
   with real authority. This comparison — not a clean test suite, not a solo `calibrate_vision_scale`
   run — is the actual acceptance gate for this feature; the two steps above establish that the
   *pipe* works, this step establishes that the *detections* are trustworthy.
5. Only if step 4 agrees, set `visionReadOnly: false` and fly a pass with the loop live.
6. Re-run `calibrate_vision_scale` after any zoom change and confirm `focalPx` moves with it
   and the loop still converges.

**A known bring-up case, not a bug: `no_posture` on most ticks.** The corrector looks up the
rig's *pointing at the camera's exposure time* (not "now") in a short in-memory history fed by
telemetry, which arrives at roughly 5 Hz (~200 ms/sample — see `PostureHistory`'s own doc for
why 5 Hz, not 10 Hz, is the number that matters here). If the sidecar's measured `latencyMs`
(from `calibrate_vision_scale`) comes back **below one telemetry period (200 ms)**, the
requested exposure time can land *after* the newest posture sample recorded so far, and the
lookup correctly refuses (`no_posture`) rather than guess — it fails closed, so it is safe, but
it can make the whole loop look dead when in fact it is behaving exactly as designed. If you
see this on most ticks: check `get_vision_status`'s `latency_ms` before assuming anything is
broken. **This is a deliberate trade-off, not something to loosen on the roof** — relaxing the
posture lookup to tolerate a stale/out-of-range sample would let it hand back a posture from a
meaningfully different pointing direction, and at the dashboard's `maxJogDps` default (19°/s)
one full telemetry period of staleness (200 ms) is up to **3.8° of pointing error** — larger
than the gate radius this whole feature exists to stay inside of. If this needs fixing, it
needs a faster telemetry rate on the firmware side, not a looser lookup here.

## Connect a client

Point any MCP client at `http://<host>:8770/mcp` (streamable HTTP). Example Claude Desktop
config entry:

```json
{ "mcpServers": { "tb3": { "url": "http://localhost:8770/mcp" } } }
```

## Always-on

- macOS: edit paths in `deploy/tb3-mcp.plist`, then `launchctl load -w ~/Library/LaunchAgents/tb3-mcp.plist`.
- Linux/Pi: edit `deploy/tb3-mcp.service`, then `systemctl enable --now tb3-mcp`.
