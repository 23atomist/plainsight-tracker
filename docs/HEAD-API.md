# plainsight head API

Reference for the HTTP and WebSocket API served by the `head/` service.
The code is the authority. The JSON Schemas in `docs/head-api/schemas/` are
validated against the live code by `head/tests/test_contract.py`, and every
example tagged with a schema name below is validated against that schema.

## Overview

The head is a Python asyncio service beside the stepper pan/tilt head. It owns
the serial link to the Pico motor controller and the BNO055 IMU. It exposes
one JSON API.

- Port: `8780` (`HEAD_PORT`). HTTP and WebSocket on the same port.
- No authentication. LAN appliance.
- JSON everywhere. Angles in degrees, rates in degrees per second.
- Axes are `pan`, `tilt`, `zoom`, `focus`.
- Commands are HTTP only. The WebSocket is read-only telemetry.

## Frame contract

- **pan**: azimuth, clockwise from true north viewed from above. The head
  reports the Pico position unchanged: no re-wrapping, no re-signing. The
  Pico's pan limits define the travel. Read them from `GET /api/config`.
- **tilt**: elevation. 0 at the lower endstop (roughly horizontal), positive
  up, range 0..90 (Pico limits). No upper switch; the top is self-limiting.
- **zoom, focus**: output-shaft degrees as the Pico reports them. No frame
  promise. No motors attached today (drivers report open-load).

`ref.pan` in the tick says where pan's zero came from:

| Value | Meaning |
|---|---|
| `none` | Pan is not homed and nothing has set it. |
| `imu` | Set from the IMU north reference at boot or by `POST /api/reference`. |
| `host` | Set by `POST /api/setpos` with a `pan` value. |

## Telemetry

`GET ws://head:8780/ws`

On connect the head sends the current tick immediately. After that it sends
every tick and every event as they happen.

- A tick is sent for each Pico status line (the head streams at 10 Hz).
- While the Pico link is down, no status arrives. The head then publishes an
  IMU-only tick at 2 Hz with `axes`, `enabled` and `moving` omitted. A client
  can tell "head alive, motors unreachable" from "head gone". Treat a tick
  without `axes` as having no motion telemetry.
- Each client has a queue of 50 messages. If it falls behind, the oldest
  message is dropped. Use `seq` to spot gaps. Events do not advance `seq`.
- Messages sent to the socket are ignored. There is no command path.
- On shutdown the head closes the socket with code 1001.

Tick with the Pico link up (schema: [tick.json](head-api/schemas/tick.json)):

```json tick
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
  "ref": {"pan": "imu", "persisted": true, "ageS": 812.4},
  "link": {"pico": true, "imu": true}
}
```

Tick with the Pico link down and the IMU still reading:

```json tick
{
  "type": "tick",
  "t": 1762150000623,
  "seq": 41900,
  "estop": false,
  "imu": {"ok": true, "heading": 124.0, "pitch": 31.5, "roll": -0.4,
          "cal": {"sys": 3, "gyr": 3, "acc": 3, "mag": 2}, "tempC": 28},
  "tiltDisagreeDeg": null,
  "ref": {"pan": "imu", "persisted": true, "ageS": 812.9},
  "link": {"pico": false, "imu": true}
}
```

Tick fields:

| Field | Type | Notes |
|---|---|---|
| `type` | `"tick"` | |
| `t` | integer | Head clock, milliseconds since the Unix epoch. |
| `seq` | integer | Count of ticks published, including IMU-only ticks. |
| `axes` | object | Optional. Keys `pan`, `tilt`, `zoom`, `focus`, all present. Omitted while the Pico link is down. |
| `axes.*.pos`, `vel`, `tgt` | number | Degrees, degrees per second, target degrees. |
| `axes.*.mode` | `I P T V H` | I idle, P position, T tracking, V velocity, H homing. |
| `axes.*.homed` | boolean | |
| `axes.*.endstop` | boolean | Endstop currently active. |
| `axes.*.driver` | boolean | TMC driver online. |
| `enabled` | boolean | Optional, same rule as `axes`. Drivers enabled. |
| `moving` | boolean | Optional, same rule as `axes`. Any axis has non-zero velocity or is homing. |
| `estop` | boolean | The head's E-STOP latch. |
| `imu.ok` | boolean | False when the IMU link is down. Then `heading`, `pitch`, `roll`, `cal` and `tempC` are `null`. |
| `imu.heading`, `pitch`, `roll` | number or null | Degrees. |
| `imu.cal` | object or null | `sys`, `gyr`, `acc`, `mag`, each integer 0..3. |
| `imu.tempC` | number or null | |
| `tiltDisagreeDeg` | number or null | IMU pitch (after the mounting offset and sign) minus Pico tilt. Diagnostic lost-step detector. `null` unless both the IMU and the Pico link are up. |
| `ref.pan` | `none imu host` | See the frame contract. |
| `ref.persisted` | boolean | The current pan reference is stored on the state volume. |
| `ref.ageS` | number or null | Seconds since the reference was set, one decimal. `null` if never set. |
| `link.pico`, `link.imu` | boolean | Link health. |

`GET /api/state` returns the same tick object (schema: tick.json).

## Events

Events share the socket with ticks. They never advance `seq`.

```json event
{"type": "event", "t": 1762150000123, "name": "homed", "axis": "tilt", "detail": null}
```

```json event
{"type": "event", "t": 1762150001000, "name": "pan_reference", "axis": null, "detail": {"source": "imu", "pan": 123.4}}
```

Schema: [event.json](head-api/schemas/event.json). `axis` is a string or
`null`. `detail` is `null`, a string, or an object.

Events from the Pico (`*E` lines). `axis` is the axis named on the line, or
`null`. `detail` is the rest of the line as a string, or `null` if empty.

| Name | Meaning | `detail` |
|---|---|---|
| `homed` | Homing finished. | `null` |
| `home_failed` | Homing failed. | string or `null` |
| `endstop_hit` | An endstop triggered. | string or `null` |
| `track_timeout` | Tracking updates stopped; the axis stopped. | string or `null` |
| `driver_online`, `driver_offline`, `driver_fault`, `driver_config_failed` | TMC driver state changes. | string or `null` |

The names come from the Pico firmware. Any name the Pico sends is forwarded.

Events from the head:

| Name | `axis` | `detail` |
|---|---|---|
| `estop` | `null` | `null`. The latch was set. |
| `estop_cleared` | `null` | `null`. The latch was cleared. |
| `config` | `null` | `{"scope": string, "key": string, "value": number}`. A setting was written through `POST /api/config`. |
| `pico_link` | `null` | `{"up": boolean}`. The Pico serial link went down (`false`) or came up (`true`). |
| `pan_reference` | `null` | `{"source": "imu" or "host" or "none", "pan"?: number, "previous"?: number or null, "reason"?: string}`. See below. |

```json event
{"type": "event", "t": 1762150002000, "name": "pico_link", "axis": null, "detail": {"up": false}}
```

`pan_reference` detail by case:

- `{"source": "imu", "pan": n}`: IMU north reference succeeded.
- `{"source": "host", "pan": n, "previous": m}`: `POST /api/setpos` set pan. `m` is `null` if no Pico status was known.
- `{"source": "none", "reason": text}`: no reference. For example
  `"pan unhomed"`, `"pico: <reason>"`, or an IMU failure reason.

## Commands

All POST bodies are JSON objects. A success is `{"ok": true}`. A failure is
the [error envelope](#error-envelope).

Motion routes (`goto`, `track`, `jog`, `home`, `setpos`, `reference`, and
`config` writes) are refused with **423** while the E-STOP latch is set, and
with **503** while the Pico link is down. `stop`, `estop`, `enable` and the
read-only routes are not guarded.

Numbers must be finite. The head rejects `NaN`, `Infinity` and overflowing
values with 400 (Python's JSON parser would otherwise accept the literals).
Booleans are not numbers.

Common error statuses for any command that reaches the Pico:

| Status | Cause |
|---|---|
| 400 | The Pico refused the command, or the body is invalid. |
| 503 | `pico link down`. |
| 504 | The Pico did not reply in time. The command may still have been applied. |
| 502 | The Pico sent a reply the head could not parse. |

### POST /api/goto

Pico line: `MOVE`. Body schema: [goto.json](head-api/schemas/goto.json).
Any subset of the four axes, at least one. Accepted while moving; the Pico
retargets. Returns **202**.

```json goto
{"pan": 123.4, "tilt": 31.2}
```

Guards: 423 (E-STOP), 503 (link down). 400 for an unknown axis, an empty
body, or a non-number.

### POST /api/track

Pico line: `TRACK`. Body schema: [track.json](head-api/schemas/track.json).
`pan` and `tilt` only. Each needs both `pos` and `vel`. The Pico extrapolates
and servos. Send at 2..10 Hz. The Pico stops the axis if updates stop. Returns
**200**.

```json track
{"pan": {"pos": 123.4, "vel": 0.8}, "tilt": {"pos": 31.2, "vel": 0.1}}
```

Guards: 423, 503. 400 for `zoom`/`focus`, a missing `pos` or `vel`, or extra
keys in an axis object.

### POST /api/jog

Pico line: `JOG`. Body schema: [jog.json](head-api/schemas/jog.json).
Constant rate in degrees per second. Returns **200**.

```json jog
{"pan": 5.0, "tilt": 0}
```

A non-zero rate arms a dead-man timer for that axis. If the host does not
refresh it within `jog_deadman_ms` (default 500), the head sends `STOP` for the
axis. A zero rate stops the axis and clears its timer. If the Pico times out,
the timers stay armed.

Guards: 423, 503.

### POST /api/stop

Pico line: `STOP [axes...]`. Body optional: `{"axes": ["pan", "tilt"]}`. No
body, or `{"axes": []}`, means all axes. Duplicates are dropped. Clears the matching jog
dead-man timers. Returns **200**. 400 for an unknown axis or key. Not guarded:
a stop works under E-STOP and is attempted when the link is down (it then
fails with 503).

### POST /api/estop

Pico line: `ESTOP`. No body. The head latches E-STOP **before** the round
trip, clears all jog timers, and publishes an `estop` event. Then it sends
`ESTOP`. The latch stays set even if the send fails (503, 504, 400). Drivers
stay enabled. Every motion route returns 423 until cleared. Returns **200**.

### POST /api/estop/clear

No body, no Pico line. Clears the latch and publishes `estop_cleared`.
Returns **200**. Safe to call when not latched.

### POST /api/enable

Pico line: `ENABLE 0` or `ENABLE 1`. Body: `{"on": true}`. `on` must be a
boolean; it is required. Returns **200**. Disabling clears the Pico's homed
flags, so the head marks `ref.pan` as `none` until re-referenced. This
happens even when the `ENABLE 0` fails or times out.

### POST /api/home

Pico line: `HOME [axes...]`. Body optional: `{"axes": ["tilt"]}`. Only axes
with `home_dir` set can home (tilt). Returns **202**. Completion arrives as
a `homed` or `home_failed` event. Guards: 423, 503.

### POST /api/setpos

Pico line: `SETPOS` (non-pan axes). Body schema:
[setpos.json](head-api/schemas/setpos.json). Declares the current position.

```json setpos
{"pan": 0}
```

Pan is set through the head's reference logic: it sets the Pico position,
marks `ref.pan` as `host`, persists it, and publishes a `pan_reference` event.
Returns **200**.

Guards: 423, 503. Also:

- **409** `reference busy`: an IMU reference run is in progress.
- **409** `<axis> is moving; stop it first`: the axis has non-zero velocity or
  is in mode `H` or `V`.
- **409** if the Pico itself refuses because the axis is moving or stopped.

### POST /api/reference

Re-runs the IMU north reference in the background. Body optional:
`{"timeoutS": 30}`. `timeoutS` must be a positive finite number; it defaults
to the head's `ref_timeout_s`. Returns **202** at once. The result arrives as
a `pan_reference` event. Guards: 423, 503. **409** `reference busy` if a
reference run is already in progress. 400 for unknown keys or a bad
`timeoutS`.

### GET /api/config

Pico line: `CFG`. Returns the Pico settings as `{scope: {key: number}}`, plus
the head's own settings under `head`:

```json
{"pan": {"max_vel": 90.0}, "tilt": {"max_vel": 60.0}, "head": {"port": 8780}}
```

(Abbreviated. The Pico scopes and the head keys are the full sets.)

### POST /api/config

Pico lines: `CFG <scope> <key> <value>`, then `SAVE` if `save` is true.
Body schema: [config-set.json](head-api/schemas/config-set.json). Returns
**200** and publishes a `config` event.

```json config-set
{"scope": "pan", "key": "max_vel", "value": 90, "save": true}
```

`scope` and `key` must match `[A-Za-z0-9_]+`. `value` must be a finite
number. `save` must be a boolean if present. `save` writes flash; the Pico
requires all axes stopped. Guards: 403 (see [Config guard](#config-guard)),
423, 503.

### GET /api/drivers

Pico line: `DRV`. Returns TMC2209 diagnostics parsed per axis:
`{"drivers": {"<axis>": {"<field>": "<value>"}}}`. Values are strings.

### GET /api/imu?n=100

No Pico line. Returns a burst of `n` raw IMU samples at the sensor rate.
Schema: [imu-burst.json](head-api/schemas/imu-burst.json). `n` defaults to 100
and is clamped to 1..1000. The response `n` is the clamped value.

```json imu-burst
{
  "n": 1,
  "samples": [
    {"t": 12.5, "heading": 124.0, "roll": -0.4, "pitch": 31.5,
     "quat": [1.0, 0.0, 0.0, 0.0], "gravity": [0.0, 0.0, 9.81],
     "linacc": [0.0, 0.0, 0.0],
     "cal": {"sys": 3, "gyr": 3, "acc": 3, "mag": 2}, "tempC": 28}
  ]
}
```

400 if `n` is not an integer. **503** `imu not ok` if the IMU is down, or
`imu read failed: <reason>` if the burst fails.

## Error envelope

Every error is JSON, with the right HTTP status:

```json
{"ok": false, "error": "pico link down"}
```

This includes 404 (unknown route), 405 (wrong method, with an `Allow`
header), 413 (body too large), 500 (`internal error: ...`) and 502 (bad Pico
reply). Status codes used:

| Status | Meaning |
|---|---|
| 400 | Invalid body or query, or the Pico refused the command. |
| 403 | Guarded config setting without `?force=1`. |
| 404, 405, 413 | Unknown route, wrong method, body too large. |
| 409 | Axis moving, or reference busy. |
| 423 | E-STOP latched. |
| 500 | Unhandled error in the head. |
| 502 | Unparseable Pico reply. |
| 503 | Pico link down, or IMU not ok. |
| 504 | Pico timeout. |

## Health and version

`GET /healthz` always returns 200 while the process is up:

```json
{"ok": true, "pico": true, "imu": true, "estop": false, "wsClients": 1, "wsDroppedTotal": 0, "version": "0.1.0"}
```

`GET /api/version` returns the head and Pico firmware versions:

```json
{"head": "0.1.0", "pico": "plainsight-ptz 0.1.0"}
```

`pico` is an empty string until the head has read the Pico's version.

## Config guard

`POST /api/config` returns 403 `guarded setting; add ?force=1` unless the
request URL has `?force=1`. A setting is guarded when:

- `key` is `socket` or `host_baud`, or
- `scope` is `global`.

The match is case-insensitive. These settings can take the controller off the
air.

## Differences from the design spec

The code wins. Where it differs from section 4 of the design spec:

- `POST /api/track` returns 200, not 202.
- `POST /api/estop` latches before the Pico round trip, and the latch stays
  set if the send fails.
- `POST /api/setpos` and `POST /api/reference` return 409 `reference busy`
  while a reference run is in progress.
- `POST /api/reference` accepts an optional `timeoutS`.
- `GET /api/imu` returns 503 when the IMU is not ok.
- Config `scope` and `key` must match `[A-Za-z0-9_]+`. The guard is
  case-insensitive.
- 404, 405 and 413 use the JSON error envelope too.
- While the Pico link is down, a tick without `axes` is published at 2 Hz.
- `pan_reference` events carry `{"source", "pan"?, "previous"?, "reason"?}`.
- The `config` event carries `{"scope", "key", "value"}`.
- `estop` and `estop_cleared` events carry no detail.
- `GET /healthz` always returns 200; read `pico` and `imu` for link health.

## Schemas

JSON Schema draft 2020-12. Every object is closed
(`additionalProperties: false`).

| File | Describes |
|---|---|
| [tick.json](head-api/schemas/tick.json) | WebSocket tick and `GET /api/state`. |
| [event.json](head-api/schemas/event.json) | WebSocket event. |
| [goto.json](head-api/schemas/goto.json) | `POST /api/goto` body. |
| [track.json](head-api/schemas/track.json) | `POST /api/track` body. |
| [jog.json](head-api/schemas/jog.json) | `POST /api/jog` body. |
| [setpos.json](head-api/schemas/setpos.json) | `POST /api/setpos` body. |
| [config-set.json](head-api/schemas/config-set.json) | `POST /api/config` body. |
| [imu-burst.json](head-api/schemas/imu-burst.json) | `GET /api/imu` response. |
