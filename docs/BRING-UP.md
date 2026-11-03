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
