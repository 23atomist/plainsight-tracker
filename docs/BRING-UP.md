# Head bring-up

Spec section 8, steps 1 to 4, for the `head/` service on the Orange Pi Zero 2W
(`plainsight`, `atomist@192.168.4.100`). Each step lists the exact commands and
the result measured at first light on 2026-11-03 (head 0.1.0, Pico firmware
`plainsight-ptz 0.1.0`, Pico `vmax`/`amax` 5/10, BNO055 uncalibrated).

**First-light status: incomplete.** Steps 1 to 3 passed. In step 4 the pan bench
reported PASS, but the IMU shows the head most likely **stalled on pan** during
the 2 deg/s TRACK run and is now physically about 60 deg counter-clockwise of
where the Pico thinks it is. The tilt bench and the stop test were not run. E-STOP
was left latched. See [Anomalies](#anomalies).

Safety before any motion: confirm the API answers and keep the E-STOP ready:

```bash
curl -s http://192.168.4.100:8780/healthz
curl -s -XPOST http://192.168.4.100:8780/api/estop        # E-STOP
curl -s -XPOST http://192.168.4.100:8780/api/estop/clear  # clear the latch
```

## 1. Install Docker, sync and build

- [x] Docker 29.9.2 and Compose v5.7.0 on the Pi; `atomist` in `docker`,
      `dialout` (20) and `i2c` (989), matching `.env.example`.
- [x] Sync and build (from the repo root on the workstation):

```bash
ssh atomist@192.168.4.100 'mkdir -p ~/plainsight-tracker/head'
rsync -a --exclude .venv --exclude data --exclude __pycache__ --exclude .pytest_cache \
  --exclude .ruff_cache --exclude '*.egg-info' head/ atomist@192.168.4.100:~/plainsight-tracker/head/
ssh atomist@192.168.4.100 'cd ~/plainsight-tracker/head && cp -n .env.example .env && mkdir -p data && docker compose up -d --build'
```

Result: the arm64 image built on the Pi in 1 min 39 s. The container is
`head-head-1` (compose project `head`) and reports `(healthy)`.

## 2. Verify boot

- [x] Commands:

```bash
curl -s http://192.168.4.100:8780/healthz
curl -s http://192.168.4.100:8780/api/version
ssh atomist@192.168.4.100 'cd ~/plainsight-tracker/head && docker compose logs --tail 40 head'
```

Results:

```
{"ok": true, "pico": true, "imu": true, "estop": false, "wsClients": 0, "wsDroppedTotal": 0, "version": "0.1.0"}
{"head": "0.1.0", "pico": "plainsight-ptz 0.1.0"}
```

First boot log (the `pico CFG` lines are abridged):

```
21:45:11,831 INFO startup 1/6: Pico link on /dev/ttyACM0
21:45:12,063 INFO pico: version plainsight-ptz 0.1.0
21:45:12,176 INFO pico CFG pan: ... gear=6.44 ... invert=1 vmax=5 amax=10 min=-180 max=180 period=360 run_current=0.6 hold_current=0.3 ... home_dir=0 ...
21:45:12,176 INFO pico CFG tilt: ... gear=10.7 ... invert=1 vmax=5 amax=10 min=0 max=90 ... home_dir=-1 ... home_speed=2 home_backoff=5 home_pos=0 ...
21:45:12,177 INFO pico CFG global: track_timeout_ms=3000 host_baud=115200 enable_on_boot=1
21:45:12,376 INFO pico: initialised, streaming every 100 ms
21:45:12,377 INFO startup 2/6: IMU reader
21:45:12,377 INFO startup 3/6: HTTP server on 0.0.0.0:8780
21:45:12,381 INFO boot: tilt not homed; HOME tilt
21:45:12,456 WARNING /data/bno055-offsets.json: not found
21:45:19,318 INFO boot: tilt homed
21:45:19,319 INFO boot: restoring the pan reference
21:45:19,320 WARNING /data/pan-reference.json: not found
21:47:21,734 WARNING pan reference from IMU failed: imu calibration timeout
21:47:21,735 INFO boot: pan reference none (imu calibration timeout)
21:47:21,735 INFO boot complete
```

- Tilt homed in 7 s, although the switch was already closed at power-up.
  Afterwards: tilt `pos 0.0`, `homed true`, `endstop true`.
- Pan reference: `none` (imu calibration timeout after 120 s), as expected
  with an uncalibrated BNO055. Manual goto still works.
- The `pico CFG global` dump on first boot shows the Pico's stored
  `track_timeout_ms=3000`, read before the head applies its own value. On the
  next boot it read 1000.
- All four axes report `endstop: true`. Pan, zoom and focus have no switch
  (pulled-up inputs), so only tilt's flag means anything.

### Pico settings

- [x] The gear ratios match the printed head (`the-pan-v4` `config.scad`):
  pan ring 76T / pinion 12T = `gear 6.3333`, tilt sector 120T / 12T =
  `gear 10`. Set in session 2 with `save: true`, replacing 6.44 / 10.7:

```bash
curl -s -XPOST http://192.168.4.100:8780/api/config -H 'Content-Type: application/json' \
  -d '{"scope": "pan", "key": "gear", "value": 6.3333, "save": true}'
curl -s -XPOST http://192.168.4.100:8780/api/config -H 'Content-Type: application/json' \
  -d '{"scope": "tilt", "key": "gear", "value": 10, "save": true}'
curl -s -XPOST http://192.168.4.100:8780/api/home -H 'Content-Type: application/json' \
  -d '{"axes": ["tilt"]}'   # a gear change clears homed; re-home (about 20 s)
```

  These two values now live in Pico flash. **If the board is ever reset with
  `DEFAULTS` (or reflashed with default settings), re-apply both and re-home
  tilt.** Check them in the boot log's `pico CFG pan` / `pico CFG tilt` lines.

## 3. Telemetry and direction

- [x] Telemetry: `/ws` sends 10 ticks/s (the `seq` step is 10 per second).
      `websocat` is not installed. Read the socket with an aiohttp client from
      `head/.venv` instead.
- [x] Pan direction:

```bash
curl -s -XPOST -H 'Content-Type: application/json' -d '{"pan": 5}' http://192.168.4.100:8780/api/goto
curl -s -XPOST -H 'Content-Type: application/json' -d '{"pan": 0}' http://192.168.4.100:8780/api/goto
```

`pan 0 -> 4.996`: IMU heading 359.69 -> 4.44 (+4.75 deg). Pan increases
**clockwise** seen from above (BNO055 heading is clockwise), as the frame
contract says. `tiltDisagreeDeg` stayed at -2.38 to -2.44 (steady). Back to
`pan 0.0`: heading 0.06.

- [x] Tilt direction and IMU axis:

```bash
curl -s -XPOST -H 'Content-Type: application/json' -d '{"tilt": 10}' http://192.168.4.100:8780/api/goto
curl -s -XPOST -H 'Content-Type: application/json' -d '{"tilt": 0.5}' http://192.168.4.100:8780/api/goto
```

The camera rises. The BNO055 **pitch does not move** (-2.38 -> -2.31). Its
**roll** moves the opposite way:

| Pico tilt | IMU roll | IMU pitch |
|---|---|---|
| 0.0 (after homing) | -1.25 | -2.38 |
| 10.0 | -12.125 | -2.31 |
| 0.0105 (returned to 0) | -1.5625 | -2.25 |
| 9.9988 | -12.0 | -2.25 |
| 0.5047 | -2.25 | -2.31 |

The scale is 1.03 to 1.09 IMU deg per Pico deg. Set in the Pi's `.env`, then
`docker compose up -d`:

```
HEAD_IMU_TILT_AXIS=roll
HEAD_IMU_TILT_SIGN=-1
HEAD_IMU_PITCH_OFFSET_DEG=-1.7
```

`-1.7` is the midrange of `-roll - tilt` over the five points (1.25 to 2.125).
After the restart, `tiltDisagreeDeg` read:

| Pico tilt | tiltDisagreeDeg |
|---|---|
| 0.0105 | -0.148 |
| 9.9988 | +0.176 |
| 0.5047 | +0.045 |

All within +/-0.5. Spec step 2's check at tilt 45 is **not done**; this task
capped tilt at 10. With the 3 to 9 % scale excess, expect `tiltDisagreeDeg` to
reach roughly +1 to +4 deg at tilt 45. Check whether the tilt `gear=10.7` is
right before relying on the disagree detector at high elevation.

Returning tilt to exactly 0 drives onto the switch. The Pico emits
`endstop_hit` (tilt) and stops at 0.0105. Command 0.5, not 0. The boot
pan-reference routine also moves tilt to `HEAD_REF_TILT_DEG` (default 0.0), so
every boot where tilt is above 0 ends on the switch with an `endstop_hit`.

## 4. Bench TRACK

- [ ] Pan, 2 deg/s, 30 s. Reported PASS, but **not accepted**; see Anomalies:

```bash
head/.venv/bin/python head/tools/track_bench.py --head http://192.168.4.100:8780 --axis pan --rate 2 --seconds 30
```

```
start pan = 0.000 deg
following error over 299 ticks: max 0.391 deg, rms 0.154 deg, p95 0.230 deg
PASS
```

After the last update the Pico extrapolated until `track_timeout` (1 s):
pan 60.37 -> 62.03 deg, then idle.

- [ ] Tilt, 1 deg/s, 30 s: **not run** (stopped after the pan anomaly).
      `--axis tilt --rate 1 --seconds 30`
- [ ] Stop test: **not run**. `--axis pan --rate 2 --seconds 15 --stop-test`.
      Note that the spec asks for a stop within 1 s, but the tool's limit is 2 s.

## Anomalies

1. **Pan most likely stalled during the 2 deg/s TRACK bench (open-loop position lost).**
   The IMU rotates with the pan stage. While Pico pan ran 0 -> 10.4, IMU
   heading followed (0 -> 7.19). From Pico pan ~12 to 60 (25 s), heading, roll
   and pitch stayed **exactly constant** (7.1875 / -1.9375), which is what the
   IMU reads at rest. When the track stopped (drive drops to hold current
   0.3 A), heading sprang back 7.2 -> 2.3. Roll also moved back towards its
   pan-0 value, matching the springback of a stalled head against tension.
   The `goto pan 0` that followed (Pico 62 -> 0, 5 deg/s) moved heading by
   -61 deg, to 301.25. Gravity (accelerometer, `linacc` about 0) at Pico pan 0 /
   tilt 0.5 is now roll -3.0 / pitch -1.94, against -2.25 / -2.31 before the
   bench. A pure IMU artefact cannot change gravity. A repeat `pan 0 -> 5`
   gave a gravity change that fits a physical pan of about -55 to -60 deg
   better than 0.
   **Owner to check visually:** where the camera points now compared with the
   start, and whether a cable or the mount binds near +7 deg clockwise of the
   start orientation. Low-speed StealthChop at 0.6 A run current is the other
   suspect. The pan bench numbers above come from the Pico's open-loop
   position and do not prove following.
2. A move to tilt 0, and the boot pan-reference move with `HEAD_REF_TILT_DEG=0`,
   lands on the switch and raises `endstop_hit`.
3. The IMU tilt scale is 3 to 9 % above the Pico's tilt (gear 10.7?).
4. Pico events (`endstop_hit`, `track_timeout`) appear only on `/ws`. The head
   does not log them. Every `POST /api/track` (10 Hz) is logged at INFO.
5. The BNO055 stayed at `sys 0 / acc 0-1 / mag 0`. Spec step 4 (calibration
   dance, `POST /api/reference`) is still to do.
6. Hot-plug / Pico re-enumeration (final-fix report I6) was not tested. No
   route reboots the Pico, and nothing was unplugged. Left to the owner.

State left on the Pi: container `head-head-1` running (healthy), **E-STOP
latched**, `ref.pan none`, Pico pan 0.0 (physically about -59 deg, see 1), tilt 0.5047.

## Follow-ups

Software, fixed after first light (head commit "log Pico events, quiet
track/jog request logs, boot reference tilt 2°"):

- Anomaly 2: `HEAD_REF_TILT_DEG` now defaults to 2.0. The boot reference stops
  just above the tilt switch instead of on it.
- Anomaly 4: the head logs every Pico event. `home_failed` and `driver_fault`
  are logged at WARNING. `track_timeout` and `endstop_hit` are logged at most
  once per 10 s per name, with a count of the repeats in between. The access
  log for `/api/track` and `/api/jog` is at DEBUG; other routes stay at INFO.

Hardware:

- **RESOLVED: suspected pan stall at about 7° into the 2 deg/s bench**
  (anomaly 1). Session 2 (below) showed it was a compass artefact, not a
  stall. With the owner watching, pan swept smoothly both ways and returned to
  its start, and the hardware pan TRACK bench passed. The drivetrain is fine.
- **RESOLVED (gear ratio): the IMU reported 3 to 9 % more tilt than the Pico**
  (anomaly 3). The Pico had `tilt gear 10.7`, but the CAD gives 120T / 12T =
  10.0, so tilt over-rotated by about 7 %. Pan was also off: 6.44 against
  76T / 12T = 6.3333. Both are fixed in Pico flash (see
  [Pico settings](#pico-settings) and session 2 below). The IMU still reads a
  few % low (28.6° for 30°). That is the sensor (acc calibration 0, roll only
  approximately the tilt axis), not the gears. Possible refinements:
  - re-fit `HEAD_IMU_PITCH_OFFSET_DEG` to -2.06 (the roll read at tilt 0);
  - the tilt cross-check has no scale term, so a scale error is not modelled.
- **Open, for the owner: `tiltDisagreeDeg` read -1.2 at tilt 2 after the
  session-2 tilt sweep** (it was about 0 before), while the IMU acc
  calibration had fallen back to 0. The leading explanation is IMU drift, not
  lost steps. After the gear fix it read 0.36 / -1.02 / 0.30 at tilt
  0 / 30 / 2. Keep watching it once the IMU has some accelerometer calibration.

## First light, session 2 (2026-11-03 afternoon, owner present)

### Deploy and boot

- Deployed build 06a1f22 to the Pi at 192.168.4.100
  (`docker compose up -d --build`).
- Boot homed tilt and moved it to the 2° reference tilt.
- The compass reference timed out as expected (mag cal 0), so `ref.pan` is
  `none`.

### Pan mechanics, with the owner watching

- `goto pan 10`: compass 315.3 -> 323.9, that is 8.6° for 10°
  (magnetometer uncalibrated).
- `goto pan 60` then `goto pan 0`: pan swept smoothly both ways and returned
  to the start.
- Mid-sweep, the compass heading **froze at 330° for about 6 s**, then ended
  30° off (315 -> 285). The compass is unreliable, not the mechanics.

**Verdict:** the session-1 "stall" was a compass artefact; the drivetrain is
fine.

**Cables:** they route through the centre of the head. The owner states that
several full pan turns are safe, but not unlimited: "10-20 turns" before it
becomes a problem. The ±180 soft limits stay for now; the cabling leaves
headroom beyond them.

### TRACK benches on hardware: all PASS

| Bench | Result |
|---|---|
| Pan 2°/s, 30 s | max 0.417°, rms 0.145°, p95 0.230° (301 ticks) |
| Stop test | vel 0 after 1.210 s (limit 2.0) |
| Tilt 1°/s, 30 s | max 0.248°, rms 0.074°, p95 0.116° |

### Tilt check after the sweep

After the tilt sweep, `tiltDisagreeDeg` read -1.2 at tilt 2 (it was about 0
before), and the IMU acc calibration was back at 0. IMU drift, not lost steps,
is the leading explanation. This stays under Follow-ups, together with the
3 to 9 % tilt scale discrepancy.

### Pan north

The BNO055 mag/acc calibration cannot be done on a mounted sensor, because the
head cannot be turned through a figure-8. So pan north will come from the
host's landmark sightings (`set_position` / calibration), not from the compass.
Once a reference exists, `HEAD_PAN_RESTORE=persisted` is the path that keeps
it.

### Clock

The Pi's clock is NTP-synchronised and correct (2026-11-03 MST). The earlier
remark in the session that it was "two days behind" was wrong.

### Gear ratios corrected from the CAD

The head's design files (`hardware/`,
`config.scad` and its README) give the printed gearing:

| Axis | Teeth | Ratio | Pico had |
|---|---|---|---|
| pan | ring 76T / pinion 12T | 6.3333 | 6.44 |
| tilt | sector 120T / pinion 12T | 10.0 | 10.7 |

With 10.7, tilt over-rotated by about 7 %. That explains the "IMU reads 3 to
9 % more tilt" item. Both ratios were fixed live with `POST /api/config` and
`save: true` (`pan gear 6.3333`, `tilt gear 10`), followed by `HOME tilt` to
resync. Homing took about 20 s.

Verification against the IMU after the fix:

| Tilt (Pico) | IMU roll | `tiltDisagreeDeg` |
|---|---|---|
| 0 | -2.06 | 0.36 |
| 30 | -30.69 | -1.02 |
| 2 | -4.00 | 0.30 |

The IMU saw 28.6° for a 30° move (-4.6 %). Its accelerometer calibration is 0,
and its roll axis is only approximately the tilt axis. So a few % of scale error
is the sensor, not the gears; the tooth counts from the CAD are authoritative.
