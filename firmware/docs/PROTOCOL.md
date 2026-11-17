# plainsight PTZ serial protocol

Plain text, one command per line (`\n` or `\r` terminated), case-insensitive.
Available identically on:

- **USB** (CDC serial, `/dev/cu.usbmodem*` / `/dev/ttyACM*`, baud ignored)
- **Raspberry Pi header UART** on the SKR Pico (GPIO0 = TX, GPIO1 = RX, 3.3 V,
  default 115200 8N1; `CFG global host_baud`, applied at boot)

Arguments may be separated by spaces, tabs or commas.

## Replies

Every command ends with exactly one terminal line:

```
ok
err <reason>
```

Data lines may come before it, each with a one-letter prefix: `S` status,
`C` config, `D` driver, `V` version, `#` help.

Lines starting with `*` are **asynchronous** and can arrive at any time, so a
client must route them aside instead of treating them as replies:

```
*S pos=... (streamed status, see STREAM)
*E <event>
```

Events: `homed <ax>`, `home_failed <ax> <why>`, `endstop_hit <ax>`,
`track_timeout <ax>`, `driver_online <ax>`, `driver_offline <ax>`,
`driver_fault <ax> drv_status=0x…`, `driver_config_failed <ax>`.

## Axes and units

`pan|p|x`, `tilt|t|y`, `zoom|z`, `focus|f|e` map to the X, Y, Z and E driver
sockets. Positions are in output-shaft units. With the default
`units_per_rev 360` those are **degrees**, and velocities are units/s.

## Commands

| Command | Meaning |
|---|---|
| `MOVE <ax> <pos> [<ax> <pos> …]` (`M`) | Absolute move with trapezoidal accel. Axes with a `period` (pan) take the equivalent angle nearest the current target within the limits, so `MOVE pan 359` then `MOVE pan 1` moves 2°. |
| `MOVER <ax> <delta> …` (`MR`) | Relative move. |
| `TRACK <ax> <pos> <vel> …` (`T`) | Follow a moving target: `pos` is where it is *now*, `vel` its rate. The controller extrapolates between updates and corrects within vmax/amax. Send updates at 2–10 Hz. If no update arrives for `track_timeout_ms` (default 3000) the axis decelerates to a stop (`*E track_timeout`). |
| `JOG <ax> <vel> …` (`J`) | Constant velocity, stops at soft limits. `JOG pan 0` stops. |
| `STOP [ax…\|all]` (`S`) | Decelerate to a stop (all axes if none given). |
| `ESTOP` (`X`) | Zero velocity immediately on all axes, no ramp. Drivers stay enabled. |
| `HOME [ax…\|all]` | Endstop homing (seek, back off, slow re-approach). No argument homes every axis that has `home_dir` set. |
| `SETPOS <ax> <pos> …` | Declare the current position (axis must be stopped). Marks the axis homed. |
| `ENABLE [0\|1]` (`EN`) | Driver enable. Any motion command enables automatically. Disabling clears homed flags. |
| `STATUS` (`?`) | One `S` line, see below. |
| `STREAM <ms>` | Send `*S` status lines to this port every `ms` (min 20, 0 = off). |
| `CFG` | List all settings as `C <scope> <key> <value>`. |
| `CFG <ax\|global>` / `CFG <scope> <key>` | List a scope / one key. |
| `CFG <scope> <key> <value>` | Change a setting (RAM only until `SAVE`). |
| `SAVE` / `LOAD` / `DEFAULTS` | Settings ↔ flash. All axes must be stopped (flash writes pause the step core). |
| `DRV [ax…]` | TMC2209 diagnostics read over UART. |
| `VER`, `HELP` | Version, command summary. |
| `REBOOT`, `BOOTSEL` | Restart, or restart into the USB bootloader (RPI-RP2 drive). |

## Status line

```
S pos=12.0000,30.0000,0.0000,0.0000 vel=0.0000,0.0000,0.0000,0.0000 tgt=12.0000,30.0000,0.0000,0.0000 mode=PPII homed=1100 es=0000 en=1 drv=1111
```

Per-axis fields are in pan,tilt,zoom,focus order. `mode` has one character
per axis: `I` idle, `P` position/holding, `T` tracking, `V` velocity
(jog or stopping), `H` homing. `es` is the raw endstop state, `drv` = TMC2209
answering on UART and not faulted.

## Settings

Per axis (`CFG pan vmax 40`):

| Key | Default (pan / tilt / zoom,focus) | Meaning |
|---|---|---|
| `units_per_rev` | 360 | Output units per output revolution |
| `gear` | 1 | Motor revolutions per output revolution (belt/worm ratio) |
| `fullsteps` | 200 | Motor full steps per rev (200 = 1.8°, 400 = 0.9°) |
| `microsteps` | 16 | 1–256, power of two (interpolated to 256 by the driver) |
| `invert` | 0 | Reverse motor direction |
| `vmax`, `amax` | 30,60 / 20,40 / 180,720 | units/s, units/s² |
| `min`, `max` | -180,180 / -10,90 / 0,0 | Soft limits; disabled when `max <= min` |
| `period` | 360 / 0 / 0 | Angle equivalence for target choice; with no limits the axis is continuous (shortest path) |
| `run_current`, `hold_current` | 0.8,0.5 / 0.8,0.5 / 0.3,0.15 | A rms (max 2.0) |
| `stealth` | 1 | 1 = stealthChop (silent), 0 = spreadCycle (more torque at speed) |
| `socket` | 0/1/2/3 | Driver socket the axis uses: 0=XM 1=YM 2=ZM 3=EM. All four must differ; takes effect after `SAVE` + `REBOOT` |
| `sgthrs` | 0 | StallGuard threshold driving DIAG (sensorless homing; needs the board's DIAG jumper) |
| `home_dir` | 0 | -1/+1 direction toward the endstop, 0 = no endstop |
| `endstop_invert` | 0 | Default: input pulled up, triggered = HIGH (NC switch to GND) |
| `home_speed`, `home_backoff` | 10, 3 | units/s, units |
| `home_pos` | 0 | Position assigned at the endstop, e.g. the azimuth the pan switch sits at |
| `backlash` | 0 | Gear slack in units. On each reversal the motor first crosses this much slack before the position counts again, so the reported position stays on the output. Measure it with `host/backlash_test.py` (BNO055 on the head): set it so the hysteresis comes out near 0. Leave 0 on gravity-loaded axes like tilt. |

Global (`CFG global …`): `track_timeout_ms` (3000), `host_baud` (115200,
needs reboot), `enable_on_boot` (0).

Step rate is capped at 20 000 steps/s per axis. At 16 microsteps that is
6.25 motor rev/s, more than enough for a geared camera head.
