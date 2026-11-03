# plainsight-tracker: design

Date: 2026-11-03. Status: draft for review.

## 1. Intent

Resume the ADS-B aircraft tracking project on new hardware, as a clean set of
separately deployable components that run only in Docker.

The previous system (`TB3-ESP32`) drove an eMotimo TB3 pan/tilt head through
custom ESP32 firmware, with a TypeScript host stack (`tb3-mcp`) installed as
five systemd units on a GPU workstation. The firmware and the host stack grew
up in one repo and the deployment was hand-installed. Both the head and the
host are now being replaced:

- **New head:** a stepper pan/tilt head driven by a BIGTREETECH SKR Pico
  (RP2040, 4x TMC2209) running the custom `plainsight-ptz` firmware (repo
  `plainsight/`, stays separate). An Orange Pi Zero 2W sits beside it,
  connected to the Pico over USB serial, and carries a BNO055 absolute
  orientation IMU on the tilting camera bracket. Today it has only test
  scripts (`plainsight/host/ptz.py`, `imu.py`).
- **New application host:** a small x86 box (Celeron G6900, 2 cores, 15 GB,
  3.6 TB NVMe, Intel UHD 710) with Docker 29 and Compose v5 already installed.
  The USB camera plugs in here.

The months of field-hardened logic above the device boundary (ADS-B
following, geometry, calibration fit, sun guard, limits, policy rules, the
LLM agent, the ops dashboard, capture) carry over. The device boundary itself
is redrawn.

## 2. Goals, non-goals, anti-goals

### Goals

1. One new repo, `plainsight-tracker`, with the components broken out:
   `head/` (Zero 2W controller), `host/` (MCP server, agent, dashboard,
   MediaMTX config), `docs/`.
2. Docker-only deployment on both machines. The only things installed on an
   OS are Docker itself and device passthrough. No systemd units, no polkit
   rules, no binaries copied into `/usr/local/bin`, no `/opt`.
3. A clean, degree-based device API between head and host (the "head API",
   section 4), replacing the ESP32's step units and WebSocket keep-alive jog.
4. The head owns level and coarse north: it boots into a frame where tilt 0
   is horizontal and pan 0 is approximately true north, and the host's fine
   calibration refines from there.
5. Everything above the device boundary keeps its behaviour and its tests.
6. Zoom and focus axes pass through the head API so the host can use them
   later.

### Non-goals (explicitly later)

- The YOLO vision detector sidecar. The compose file carries a disabled slot
  for it; nothing else is built.
- Host-side tooling for zoom and focus (no MCP tools, no dashboard controls).
- Any change to the Pico firmware. It stays in `plainsight/firmware`.
- Reworking the dashboard UI.
- Porting the old rig's calibration data. The new head gets a fresh
  calibration.
- Using the bracket-mounted IMU to replace the host's calibration pipeline.
  The head reports IMU orientation in telemetry and uses it for its own
  north reference; deeper use by the host is future work.

### Anti-goals (failure even if it "works")

- Any component that needs a host-OS install beyond Docker and a device node.
- Step units, `STEPS_PER_DEG`, or the keep-alive jog scheme reappearing in
  the host code.
- Losing a safety behaviour the old system had: E-STOP, sun guard, soft
  limits, idle park, telemetry-freshness gates, jog dead-man, the agent's
  min-dwell and policy gates.
- The head moving on its own at boot without an explicit, documented,
  configurable reason (homing tilt is the only sanctioned boot motion).

## 3. Topology

```
                 LAN 192.168.4.0/22
                          |
  +-----------------------+-----------------------------+
  |                                                     |
  plainsight head (Orange Pi Zero 2W, 192.168.4.96)     application host (192.168.4.92)
  Armbian trixie, arm64, Python 3.13, Docker (to add)   Debian 13, x86_64, Docker 29 + Compose v5
  |                                                     |
  |  head/compose.yaml                                  |  compose.yaml (network_mode: host)
  |   +-- head  (Python, port 8780 HTTP+WS)             |   +-- mcp        :8770   MCP server + tracking + capture
  |        |-- /dev/ttyACM0  -> SKR Pico (plainsight-ptz 0.1.0)   +-- agent             LLM target chooser (MCP client)
  |        +-- /dev/i2c-3    -> BNO055 @0x29             |   +-- dashboard  :8788   ops UI, camera ingest (ffmpeg -> MediaMTX)
  |                                                     |   +-- mediamtx   :8189/udp WebRTC; api/rtsp/whep on 127.0.0.1
  |                                                     |   +-- detector   (profile "vision", disabled)
  |                                                     |
  |                                                     |  /dev/video*  USB camera
  |                                                     |  /dev/dri/renderD128  Intel VAAPI
  |                                                     |  /srv/plainsight/{config,state,recordings,snapshots}
  |
  external: ADS-B tar1090 at http://192.168.4.11:8088/data/aircraft.json (unchanged)
            LLM endpoint: OpenAI-compatible chat completions, location TBD (section 9)
```

The host stack talks to the head only through the head API over the LAN.
The head never talks to the host; it serves.

Service naming is `plainsight-*` for images, containers, and docs. The
`TB3_*` environment-variable prefix and the MediaMTX path name `tb3` are
kept internally to avoid churn across 18 source files; this is a cosmetic
rename that can come later.

## 4. The head API (v2)

Served by the `head` container on port 8780. JSON everywhere. All angles in
degrees, all rates in degrees per second. No authentication (LAN appliance,
same as before; the dashboard's token gate is the only user-facing auth).

### 4.1 Frame contract

- **pan**: azimuth, clockwise from true north viewed from above. The head
  reports the Pico's position unchanged (no re-wrapping, no re-signing); the
  Pico's pan limits define the travel, and today they are -180..180 with
  `period 360` and `invert 1` already set so that increasing pan is
  clockwise. The host reads the limits from `GET /api/config` (6.1) rather
  than assuming them. Widening pan travel beyond one turn (the Pico supports
  +-270 or continuous with a slip ring) is out of scope: the host's limit
  guard and through-north behaviour assume at most one turn.
- **tilt**: elevation, 0 at the lower endstop which sits at roughly
  horizontal, positive up, range 0..90 (Pico limits). The upper end is
  mechanically self-limiting (gear runs out and clicks), so no upper switch.
- **zoom, focus**: output-shaft degrees as the Pico reports them, no frame
  promise. Currently no motors attached (drivers report open-load).
- The host's `panSign`/`tiltSign` config keys stay and default to 1.

### 4.2 Telemetry: `GET ws://head:8780/ws`

The head subscribes to the Pico with `STREAM 100` (10 Hz) and fans every
status line out to all WebSocket clients as one JSON tick, merged with the
latest IMU reading and head-level state. A tick is published only when a
real Pico status line arrived; the head never synthesizes ticks from a
timer (the old telemetry-freeze bug came from exactly that confusion).

```json
{
  "type": "tick",
  "t": 1762150000123,
  "seq": 41877,
  "axes": {
    "pan":   {"pos": 123.4, "vel": 0.8, "tgt": 123.9, "mode": "T", "homed": true,  "endstop": false, "driver": true},
    "tilt":  {"pos": 31.2,  "vel": 0.1, "tgt": 31.3,  "mode": "T", "homed": true,  "endstop": false, "driver": true},
    "zoom":  {"pos": 0, "vel": 0, "tgt": 0, "mode": "I", "homed": false, "endstop": false, "driver": true},
    "focus": {"pos": 0, "vel": 0, "tgt": 0, "mode": "I", "homed": false, "endstop": false, "driver": true}
  },
  "enabled": true,
  "moving": true,
  "estop": false,
  "imu": {"ok": true, "heading": 124.0, "pitch": 31.5, "roll": -0.4,
          "cal": {"sys": 3, "gyr": 3, "acc": 3, "mag": 2}, "tempC": 28},
  "tiltDisagreeDeg": 0.3,
  "ref": {"pan": "imu", "persisted": true, "ageS": 812},
  "link": {"pico": true, "imu": true}
}
```

- `mode` is the Pico's per-axis letter: I idle, P position, T tracking,
  V velocity, H homing.
- `moving` is true if any axis has non-zero velocity or is homing.
- `tiltDisagreeDeg` = IMU pitch (after the configured mounting offset) minus
  Pico tilt. It is diagnostic only: the previous head had worn gears and this
  is the cheapest lost-step detector available. Null when the IMU is not ok.
- `ref.pan` is where pan's zero came from: `none` (Pico reports pan not
  homed and nothing has set it), `imu` (boot north reference, section 5),
  `host` (`POST /api/setpos`). `persisted` says the current pan reference
  has been written to the state volume.
- `link.pico` false means the serial link is down; the head keeps publishing
  IMU-only ticks at 2 Hz with `axes` omitted so a client can tell "head
  alive, motors unreachable" from "head gone". The host's freshness gates
  must treat a tick without `axes` as no motion telemetry.

Events from the Pico's `*E` lines are forwarded on the same socket:

```json
{"type": "event", "t": 1762150000123, "name": "homed", "axis": "tilt", "detail": null}
```

Names are the Pico's: `homed`, `home_failed`, `endstop_hit`,
`track_timeout`, `driver_online`, `driver_offline`, `driver_fault`,
`driver_config_failed`; plus head-level `estop`, `estop_cleared`,
`pan_reference` (detail: source and value), `pico_link` (detail: up/down).

### 4.3 Commands (HTTP)

All POSTs take JSON and return `{ "ok": true }` or
`{ "ok": false, "error": "<text>" }` with a 4xx/5xx status. Motion commands
are refused with 423 while the E-STOP latch is set, and with 503 while the
Pico link is down.

| Route | Body | Pico | Notes |
|---|---|---|---|
| `GET /healthz` | | | 200 when the process is up; body has `pico` and `imu` link booleans. |
| `GET /api/version` | | `VER` | head version, Pico firmware version string. |
| `GET /api/state` | | | the latest tick (same shape as the WS tick). |
| `POST /api/goto` | `{pan?, tilt?, zoom?, focus?}` | `MOVE` | accepted at any time, including while moving (the Pico retargets). Returns 202. Host waits for arrival on telemetry as before. |
| `POST /api/track` | `{pan?: {pos, vel}, tilt?: {pos, vel}}` | `TRACK` | position-now plus rate; the Pico extrapolates and servos. Send at 2..10 Hz. The Pico's `track_timeout_ms` stops the axis if updates stop; the head sets it to 1000 ms at startup (section 5). |
| `POST /api/jog` | `{pan?: dps, tilt?: dps, zoom?: dps, focus?: dps}` | `JOG` | constant rate. Dead-man: the head stops any jogged axis not refreshed within `jogDeadmanMs` (default 500). Zero stops. |
| `POST /api/stop` | `{axes?: [..]}` | `STOP` | decelerate to a stop; all axes if none given. Also clears any jog dead-man timers. |
| `POST /api/estop` | | `ESTOP` | immediate zero velocity, then sets the head's E-STOP latch: every motion route returns 423 until cleared. Drivers stay enabled (holding torque). |
| `POST /api/estop/clear` | | | clears the latch. |
| `POST /api/enable` | `{on: bool}` | `ENABLE` | driver enable. Disabling clears the Pico's homed flags; the head then marks `ref.pan` `none` until re-referenced. |
| `POST /api/home` | `{axes?: [..]}` | `HOME` | only axes with `home_dir` set (tilt). Returns 202; completion arrives as a `homed`/`home_failed` event. |
| `POST /api/setpos` | `{pan?, tilt?, zoom?, focus?}` | `SETPOS` | declares the current position. Axis must be stopped (Pico rule, surfaced as 409). Setting pan marks `ref.pan` `host` and persists it. |
| `POST /api/reference` | `{timeoutS?}` | `SETPOS pan` | re-runs the IMU north reference (section 5.3) on demand. 202; result as a `pan_reference` event. |
| `GET /api/imu?n=100` | | | burst of `n` raw IMU samples at the sensor rate: per sample gravity vector, linear acceleration, quaternion, Euler, calibration status. Replaces the old `/api/imu` burst used by the host's IMU characterization tools. |
| `GET /api/config` | | `CFG` | the Pico's full settings as `{scope: {key: value}}`, plus the head's own settings under `head`. |
| `POST /api/config` | `{scope, key, value, save?: bool}` | `CFG`, `SAVE` | one Pico setting; `save` writes flash (Pico requires all axes stopped). The head refuses `socket`, `host_baud`, and anything under `global` unless `?force=1`, because those can take the controller off the air. |
| `GET /api/drivers` | | `DRV` | TMC2209 diagnostics, parsed to JSON. |

There is no command path over the WebSocket. Jog refreshes at 10 Hz over
HTTP keep-alive connections are fine on a LAN and keep one API surface.

### 4.4 What the head does NOT expose

No motion programs, no camera trigger, no OTA, no battery, no station IP.
Those were ESP32 features and the host tools built on them are removed in
the port (section 6.3).

## 5. The head controller (`head/`)

Python 3.13, asyncio, `aiohttp` for HTTP + WebSocket, `pyserial` for the
Pico. The IMU driver is the existing raw-ioctl `/dev/i2c` code from
`plainsight/host/imu.py` (no extra dependency). Package `plainsight_head`.
Pico serial handling starts from `plainsight/host/ptz.py` (threaded reader,
request/response queue, async `*` lines routed aside) and is adapted to feed
the asyncio loop.

### 5.1 Startup sequence

1. Open the serial port (default `/dev/ttyACM0`, which the compose file maps
   from `/dev/serial/by-id/usb-Raspberry_Pi_Pico_*-if00`). `VER`, full
   `CFG` dump (logged), `CFG global track_timeout_ms 1000` (RAM only, every
   boot, so the Pico's own fail-safe matches the host's 10 Hz track cadence
   with headroom), `STREAM 100`.
2. Open the IMU on the header bus (auto-detected like `imu.py` does). Load
   BNO055 calibration offsets from the state volume if present and write
   them to the sensor. The IMU is optional: failure logs and continues with
   `imu.ok=false`.
3. Start the HTTP/WS server. From here the head is usable for manual
   control even if the rest of boot fails.
4. If `HEAD_AUTO_HOME=1` (default) and tilt reports not homed: `HOME tilt`.
   Wait for the event (timeout 60 s, then log and continue).
5. Pan reference (5.3).
6. Enter steady state: fan out ticks, run the persistence writer (5.4), run
   the jog dead-man.

### 5.2 Steady-state responsibilities

- Parse every `S`/`*S` line into a tick, merge the latest IMU sample
  (read at 20 Hz in its own task), publish to WS clients.
- Jog dead-man per axis.
- E-STOP latch.
- Serial-link supervision: on read error or 2 s without a status line, mark
  `link.pico=false`, close, retry open every 1 s, and on reconnect re-run
  step 1 (not homing, not referencing). Pan reference survives if the Pico
  kept power (its `homed` flag says so); if the Pico rebooted, `ref.pan`
  goes to `none` and 5.3's restore rule applies.
- IMU-link supervision: same pattern, `link.imu`.

### 5.3 Pan reference

Pan has no endstop. Its zero comes from one of:

1. **Pico already homed.** The Pico kept power and still knows where pan is.
   Trust it; `ref.pan` keeps its previous source (restored from the state
   file's `source` field).
2. **Persisted position.** The state file holds the last pan position and a
   timestamp. If `HEAD_PAN_RESTORE=persisted` (default) and the file is
   younger than `HEAD_PAN_RESTORE_MAX_AGE_S` (default 7 days), `SETPOS pan
   <value>` and `ref.pan = host|imu` as recorded. This assumes nobody turned
   the head by hand while it was unpowered; the stepper's detent and the
   gearing make that a fair default, and the host's calibration catches it.
3. **IMU north.** Otherwise, or on `POST /api/reference`: require tilt
   homed; move tilt to `HEAD_REF_TILT_DEG` (default 0) and wait idle; wait
   until the BNO055 reports `mag >= 2` and `sys >= 2` (timeout
   `HEAD_REF_TIMEOUT_S`, default 120; on timeout log, emit
   `pan_reference` with `source: none`, leave pan unreferenced); average
   heading over 2 s (circular mean); `SETPOS pan` to
   `wrap(heading - HEAD_IMU_HEADING_OFFSET_DEG)`; `ref.pan = imu`; persist.

   The magnetometer next to four steppers and a steel head will be rough.
   The goal is only to land inside the host calibration's capture range.
   `HEAD_IMU_HEADING_OFFSET_DEG` is the measured difference between the
   IMU's heading and the camera's true azimuth; it is set during bring-up by
   pointing at a known landmark and read back from `GET /api/config`.

   Because the BNO055's magnetometer calibration is lost on power cycle
   unless offsets are restored, the head writes the sensor's offsets to the
   state volume whenever all four calibration levels reach 3, and restores
   them at boot (step 2).

The head never moves pan on its own. Referencing only renames where it is.

### 5.4 Persistence

One directory, mounted at `/data`:

- `pan-reference.json`: `{pos, source, t}`; rewritten at most every 5 s when
  pan is idle and changed, and on SIGTERM.
- `bno055-offsets.json`: the 22-byte offset block, written when fully
  calibrated.

Nothing else. Pico settings live in the Pico's flash.

### 5.5 Configuration

Environment variables, prefix `HEAD_`, all with defaults:
`HEAD_PORT=8780`, `HEAD_SERIAL=/dev/ttyACM0`, `HEAD_I2C_BUS` (auto),
`HEAD_AUTO_HOME=1`, `HEAD_PAN_RESTORE=persisted|imu|none`,
`HEAD_PAN_RESTORE_MAX_AGE_S`, `HEAD_REF_TILT_DEG`, `HEAD_REF_TIMEOUT_S`,
`HEAD_IMU_HEADING_OFFSET_DEG=0`, `HEAD_IMU_PITCH_OFFSET_DEG=0`,
`HEAD_JOG_DEADMAN_MS=500`, `HEAD_LOG_LEVEL`.

### 5.6 Container

`python:3.13-slim` on arm64. `head/compose.yaml`:
`devices: [/dev/serial/by-id/usb-Raspberry_Pi_Pico_*-if00:/dev/ttyACM0,
/dev/i2c-3]` (the by-id path and bus number are in `.env`),
`group_add: [dialout gid, i2c gid]`, `ports: ["8780:8780"]`,
volume `./data:/data`, `restart: unless-stopped`, `stop_grace_period: 5s`,
`init: true`. Image is built on the Zero 2W itself (`docker compose up -d
--build`); no registry.

### 5.7 Tests

pytest. A **fake Pico**: a scripted serial transcript object that implements
the protocol in `plainsight/docs/PROTOCOL.md` well enough to answer `VER`,
`STATUS`, `CFG`, `MOVE`, `TRACK`, `JOG`, `STOP`, `ESTOP`, `HOME` (emits
`*E homed` after N ticks), `SETPOS`, `STREAM` (emits `*S` lines on a
controllable clock). A **fake IMU** with settable heading/pitch/roll/cal.
Coverage targets: tick parsing and fan-out, every route's happy path and
refusals (423, 503, 409), jog dead-man, E-STOP latch, the three pan
reference paths, persistence writes, link loss and recovery. A
**contract test** validates example ticks and command bodies against
`docs/HEAD-API.md`'s JSON Schemas, which the host's tests also load.

## 6. The host stack (`host/`)

The existing `tb3-mcp` TypeScript project moves over largely intact (it is a
working project with ~150 test files), reorganized as
`src/{mcp,agent,dashboard,shared}` with the existing modules sorted under
the process that owns them and shared code (`adsb/`, `geo/`, `track/`,
`policy/`, stores, config) under `shared/`. One Node image, three
entrypoints. `npm test` stays vitest.

### 6.1 Device client (`shared/device.ts`), rewritten

- `DeviceState` becomes degree-based: `panDeg`, `tiltDeg`, `zoomDeg`,
  `focusDeg`, per-axis `mode`/`homed`/`driver`, `moving`, `enabled`,
  `estop`, `imu` (heading, pitch, roll, cal, tempC), `tiltDisagreeDeg`,
  `ref`, `link`, `lastUpdateMs`, `connected`. `panSteps`, `tiltSteps`,
  `auxSteps`, `batteryV`, `staIp`, `programEngaged` are deleted along with
  `STEPS_PER_DEG`, `stepsToDeg`, `degToSteps`, and the `nan` JSON
  sanitizer.
- Methods: `gotoAngle`, `track`, `jog`, `stop`, `estop`, `clearEstop`,
  `home`, `setPos`, `reference`, `getGravityBurst`, `getState`,
  `onTelemetry`, `start`, `close`. `setJogVector`/`clearJog`/`lockJog`/
  `unlockJog` survive as the manual-jog keep-alive owner (the dashboard
  joystick and the `jog` tool still need a host-side dead-man and the
  sun-guard lock), but send `POST /api/jog` in dps instead of a deflection
  over WS. `rateToDeflection` and its cubic curve are deleted.
- `waitForArrival` compares degrees with a 0.25° tolerance.
- A tick without `axes` (Pico link down) updates `link` and `imu` only and
  does not refresh `lastUpdateMs`, so every existing staleness gate fires.
- On connect, and whenever the head emits a `config` event (the head emits
  one after every successful `POST /api/config`), the client fetches
  `GET /api/config` and caches pan/tilt `min`, `max`, `vmax`, `amax`. The
  limit guard's stopping horizon is derived from the Pico's `amax` for that
  axis (the old constant came from ESP32 accumulator behaviour and is
  deleted). The host's own `panMin`/`panMax`/`tiltMin`/`tiltMax` config keys
  remain as the operator ceiling and are clamped to the Pico's limits at
  load, with a startup warning if they were wider.
- Pan reference changes (6.8) are handled here: the client watches `ref`
  and `pan_reference` events and raises a `referenceChanged` notification
  with the old and new pan value when both are known.

### 6.2 Tracking loop (`shared/track/session.ts`)

The session keeps its estimator, offset, reach/range resolution, limit
guard, sun guard, floor, sector, reacquire and wait logic. What changes is
the last step: instead of computing a commanded rate through a P-controller
and slew limiter and sending a jog deflection, each tick sends
`device.track({pan: {pos: reach.pan, vel: aim.ratePanDps}, tilt: {pos:
reach.tilt, vel: aim.rateTiltDps}})` and the Pico does the servo. The
limit guard's `blocked` verdict maps to sending that axis `stop` (not a
clamped track). `trackKp`, `trackRateSlewDps`, `maxJogDps`-as-deflection,
`jogVectorTtlMs` are removed from config; `trackTickHz` stays (10). Tests
that asserted on commanded rates are rewritten to assert on the track
setpoints and on stop-on-block. The acquisition "device_busy" dance that
waited for `moving` to clear before a goto is deleted (gotos retarget).

The Pico's `TRACK` has not yet been run against the real mechanics. The
decision is still to port to it directly rather than carry the old
host-side rate servo behind a switch: two servos in the hardest code is the
worse outcome, and the Pico firmware is ours to fix. Bring-up (section 8)
gets a bench step that drives `TRACK` with a synthetic moving target from a
script and checks following error before the host tracking port is
accepted. If that step fails, the firmware is fixed first.

### 6.3 Removed MCP tools and dashboard bits

Program list/select, camera trigger (ESP32 shutter output), battery and
station-IP displays, OTA helpers, `deviceIpFallback`. The `set_home` tool is
replaced by `home` (tilt) and `set_position`/`reference` (pan) tools that
front the new routes. `characterize_imu` and friends keep working against
`GET /api/imu` bursts.

### 6.4 Agent enable without systemd

The dashboard's Auto toggle and the E-STOP agent leg used `systemctl
start/stop tb3-agent`. Replacement: the MCP server holds an **agent armed**
flag (persisted in `/data/state/agent.json`, default off), exposed as MCP
tools `get_agent_armed`/`set_agent_armed` and in `/api/state`. The agent
container always runs; each tick it reads the flag and does nothing while
disarmed. E-STOP clears the flag before stopping motion. `services.ts` and
its polkit requirement are deleted.

### 6.5 Camera and encoding

The dashboard container includes ffmpeg (Debian package) and Intel's VAAPI
driver, gets `/dev/dri/renderD128` and the configured `/dev/v4l/by-id/...`
device, and `group_add` video/render. `cameraEncoder` gains `vaapi`
(`-vaapi_device /dev/dri/renderD128`, `hwupload`, `h264_vaapi`) and it
becomes the default; `nvenc` and `vulkan` stay selectable; `x264` is the
software fallback and is documented as "720p at most on this CPU".
`cameraFfmpegBin` defaults to `/usr/bin/ffmpeg` inside the image, so the
asdf-shim trap from the old host disappears.

### 6.6 MediaMTX

Official `bluenviron/mediamtx` image, config mounted from
`host/mediamtx/mediamtx.yml`, recordings to `/srv/plainsight/recordings`.
With host networking (6.7) the existing bind addresses (api/rtsp/whep on
127.0.0.1, ICE UDP 8189 on all interfaces) and the existing
`cameraMediamtx*Url` defaults keep working unchanged.

### 6.7 Compose (`compose.yaml` at the repo root)

All four services use `network_mode: host`. Reasons: the config defaults
all assume `127.0.0.1` between the processes; WebRTC ICE from a bridged
container needs extra candidate configuration that has cost time before;
this is a single-purpose LAN appliance where isolation between its own
processes buys nothing. The dashboard's token gate remains the only
exposure control, as before.

- `mcp`: `node dist/mcp/server.js`, reads `/config/config.json`, state in
  `/data/state`, snapshots in `/data/snapshots`.
- `agent`: `node dist/agent/agent.js`, `depends_on: mcp`.
- `dashboard`: `node dist/dashboard/server.js`, devices as in 6.5.
- `mediamtx`: as in 6.6.
- `detector`: `profiles: ["vision"]`, image left as a placeholder with a
  comment pointing at `TB3-ESP32/services/detector`; never started by
  default.

Bind mounts, one root: `${PLAINSIGHT_DATA:-/srv/plainsight}` with
`config/`, `state/`, `recordings/`, `snapshots/`. Bind mounts rather than
named volumes so the operator can read recordings and edit config with
normal tools. `.env.example` lists `PLAINSIGHT_DATA`, `HEAD_HOST`
(default `192.168.4.96`), `CAMERA_DEVICE` (by-id path), `TB3_ADSB_URL`,
`TB3_LLM_URL`, `TB3_LLM_MODEL`, `TB3_LLM_API_KEY`, `TB3_DASHBOARD_AUTH`,
`TB3_MCP_TOKEN`.
`deviceHost` in config becomes `headUrl` (`http://192.168.4.96:8780`).

One `Dockerfile` (multi-stage: `npm ci` + `tsc`, then a slim runtime stage
with ffmpeg and the VAAPI driver). All three Node services run the same
image with different commands. Images are built on the host
(`docker compose up -d --build`); no registry.

### 6.8 Pan reference changes and automated motion

The head can rename pan: at boot (IMU north), on `POST /api/reference`, on
`POST /api/setpos`, and it drops `ref.pan` to `none` after a Pico reboot or
`ENABLE 0`. The host's calibration solution, taught limits, sector, floor
and aim trims are all expressed against pan's zero, so a rename with a
stale solution points every exclusion cone at the wrong sky. Rules:

1. **Known delta (setpos, reference, boot restore from file):** the head
   reports old and new pan for the same physical position. The host shifts
   its calibration solution, taught limits, sector and trims by that delta
   and keeps them. The sun guard stays calibrated. This is what the old
   `feat/reboot-rezero` branch did for the ESP32's lost step origin; it is
   reimplemented here against the head's `pan_reference` event, not ported.
2. **Unknown origin (`ref.pan = none`):** the host refuses all automated
   motion (tracking, agent target selection, sun park, idle park) and the
   dashboard shows "pan unreferenced". Manual jog and goto stay available
   so the operator can re-reference. The policy layer gets one new
   predicate, `pan_referenced`, and the agent's gates include it.
3. The owner's answer to the open item in section 9 may change rule 1 to
   "invalidate instead of shift".

### 6.9 Sun park on a head that cannot look down

Tilt 0 is the floor, so the old `parkTiltDeg` default of -20 ("down and
away from the sun") is unreachable; `planPark`'s clamp to `tiltMin` would
turn it into "horizontal at the current pan", which is exactly where the
neighbours' windows are. New defaults: `tiltMin` 0, `parkTiltDeg` +60,
with the pan leg of the park unchanged (away from the sun's azimuth). The
idle park (`idleParkTiltDeg` 45) already points up. Both remain config
keys.

### 6.10 Source of the port

The port starts from `TB3-ESP32` branch `feat/ops-rework` (d7c1e3c,
2026-08-30), which is the branch the last field sessions ran on and
already contains the dashboard redesign, MediaMTX/WebRTC, N-sighting
calibration, the recordings index and vision lock. `main` is 225 commits
behind it and is not used. The side branches `feat/reboot-rezero` and
`feat/calib-fixes-tuning` are not ported; the one idea from them this
design needs is restated in 6.8.

### 6.11 LLM: Ollama Cloud

The agent's only LLM call is `chooseTarget()`. It goes to Ollama Cloud's
OpenAI-compatible endpoint (`https://ollama.com/v1/chat/completions`) with
a bearer token. Consequences, from the August 2026 evaluation:

- The LLM client gains an `llmApiKey` config key (`TB3_LLM_API_KEY`), sent
  as `Authorization: Bearer`. It is a secret: never in `config.json`, only
  in the host's `.env`, which is gitignored. The deploy doc fetches it from
  1Password with the CLI (`op read`) into `.env`; the item is referenced
  by UUID in `docs/DEPLOY.md`, the value is not.
- Ollama Cloud accepts `response_format: json_schema` and ignores it, so
  the hard structured-output guarantee the local server gave is gone. The
  prompt already instructs JSON; the client keeps sending `response_format`
  (harmless where ignored, enforced where honoured) and the loop's existing
  fail-safe on an unparseable reply (`loop.ts`, "keep" action) is the
  safety net. A test covers a prose reply producing "keep".
- Call volume: one call per agent tick (`agentTickSec` 5) while armed, so
  up to ~720 calls/hour. The agent only calls when there is at least one
  eligible target, as today. `agentTickSec` is the cost knob.
- `TB3_LLM_MODEL` is an `.env` choice; the deploy doc suggests starting
  with a mid-size instruct model and lists how to switch.

## 7. Repo layout

```
plainsight-tracker/
  README.md                       what this is, the two-machine picture, quick start
  compose.yaml                    application host stack
  .env.example
  head/
    compose.yaml                  head stack (Zero 2W)
    Dockerfile
    pyproject.toml
    plainsight_head/              serial.py imu.py ticks.py api.py reference.py persist.py main.py
    tests/
  host/
    Dockerfile
    package.json  tsconfig*.json  vitest.config.ts
    src/mcp/  src/agent/  src/dashboard/  src/shared/
    dashboard/public/
    mediamtx/mediamtx.yml
    test/
  docs/
    DEPLOY.md                     the only install doc: Docker on both machines, .env, first run, verification
    HEAD-API.md                   section 4 as a reference, with JSON Schemas
    BRING-UP.md                   first-light checklist (section 8)
    superpowers/specs/            this document and later ones
```

## 8. Bring-up order (documented in `docs/BRING-UP.md`)

1. Install Docker on the Zero 2W. Give both machines DHCP reservations.
2. `head/`: `docker compose up -d --build`; `curl :8780/healthz`; watch
   `/ws`; `home`; jog each axis 5°; confirm pan increases clockwise and tilt
   increases upward; set `HEAD_IMU_PITCH_OFFSET_DEG` so `tiltDisagreeDeg` is
   ~0 at tilt 0 and 45.
3. Bench `TRACK`: a script in `head/tools/` feeds the head a synthetic
   target (constant angular rate, then a sinusoid) over `POST /api/track`
   at 10 Hz for a minute per axis and reports following error from the
   ticks. Accept when the error stays under 0.5 deg at rates the ADS-B
   tracker needs (2 deg/s pan, 1 deg/s tilt). Also stop sending mid-run and
   confirm the axis stops on `track_timeout` within 1 s.
4. BNO055 calibration dance until all four read 3; confirm
   `bno055-offsets.json` appears; `POST /api/reference`; point at a known
   landmark and set `HEAD_IMU_HEADING_OFFSET_DEG`.
5. Host: plug the camera, fill `.env`, `docker compose up -d --build`; open
   the dashboard; telemetry, joystick, E-STOP, camera tile.
6. Host calibration as before (sightings, boresight, trims) from the
   dashboard procedures.
7. Raise Pico `vmax`/`amax` from the current 5/10 via `POST /api/config`
   until the head misses steps, back off 30%, `save`.
8. ADS-B on, manual track, then arm the agent.

## 9. Open items for the owner

- **Pan reference policy.** Whether rule 1 in 6.8 (shift the calibration by
  the known delta) is acceptable, or whether every reference change should
  invalidate the calibration and force a re-sighting.
- **Camera.** Which USB camera, and whether it outputs H.264 natively or
  only MJPEG/YUYV. Native H.264 means the `copy` path and no encoding;
  MJPEG at 1080p means decode + VAAPI encode is the CPU hot path and sets
  the default size and frame rate. Also decides whether the image needs
  `intel-media-va-driver-non-free` (Debian non-free).
- ~~LLM endpoint~~ Decided 2026-11-03: **Ollama Cloud** for now. See 6.11.

## 10. Left to the builder

Internal module boundaries inside the limits above; exact zod and JSON
Schemas; the fake Pico's implementation; Dockerfile details and base image
pins; the precise ffmpeg VAAPI argument set; the order in which the host
files are ported; how the vitest suite is migrated file by file. The
builder should keep the old repo's module-level comments where the logic
survives; they record field lessons.

## 11. Risks

- **Magnetometer north** may be too disturbed to reach `mag>=2` on the
  head. Mitigation is already in: referencing is optional, persisted pan is
  the default restore path, and the host's calibration never depended on it.
- **VAAPI on UHD 710 inside a container** is well-trodden but has
  driver-package traps (`intel-media-va-driver-non-free` vs the free one).
  Bring-up step 4 verifies `h264_vaapi` before anything depends on it.
- **Two CPU cores** for ffmpeg, MediaMTX, three Node processes. VAAPI keeps
  ffmpeg cheap; the agent is idle most of the time. If it is tight, the
  dashboard's capture FPS is the knob.
- **Tracking behaviour changes** with the move from host-side rate servo to
  Pico-side `TRACK`. It should be strictly better (feed-forward in the
  controller, 1 kHz planner), but the first on-roof sessions will re-tune
  nothing in the host; tuning lives in Pico `vmax`/`amax`.
