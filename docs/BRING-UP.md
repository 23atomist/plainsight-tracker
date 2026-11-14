# Head bring-up

Steps 5 to 8 (the application host) are under [Host bring-up](#host-bring-up)
at the end. Install instructions for both machines are in [DEPLOY.md](DEPLOY.md).

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

- [x] Tilt zero and pan travel (2026-11-03 PM, after placing and levelling the
  rig), saved to flash:
  - `tilt home_pos -2` and `tilt min -2`: the endstop reads -2, so **tilt 0 is
    level**. This replaces the earlier "tilt 0 = endstop, roughly level".
    *(Superseded 2026-11-05 PM: the endstop is level, so these are 0 / 0 again;
    see the IMU re-mount note.)*
  - `pan min -270`, `pan max 270`: the cabling runs through the centre, which
    allows about a full turn each way. ±270 was chosen; the rest is margin.
  - Then `HOME tilt` (about 25 s) and `goto tilt 0`, which puts tilt at level.

  These values (both gears, tilt `home_pos`/`min`, pan `min`/`max`) now live
  in Pico flash. **If the board is ever reset with
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

> **2026-11-05 — IMU re-mounted inverted.** The board now sits upside down, so
> the head writes the BNO055 axis-remap registers at open
> (`HEAD_IMU_AXIS_MAP_CONFIG=0x24`, `HEAD_IMU_AXIS_MAP_SIGN=0x05`, datasheet
> placement P7). Without the remap the fusion sat on the Euler pitch=180
> singularity (heading flipped 27→203 across a tilt move, pitch compressed
> 47°→44°). With it, gravity reads +Z at level and heading holds ±0.5° across
> tilt 0..90. The tilt mapping became `HEAD_IMU_TILT_AXIS=pitch`,
> `HEAD_IMU_TILT_SIGN=1`, `HEAD_IMU_PITCH_OFFSET_DEG=2.0` (fusion pitch at Pico
> tilt 0 read 1.8–2.5 across three settles; the raw accelerometer said 1.0–1.3).
> The settings above this note are the pre-move values. The IMU reads ~2.5–4.5%
> fewer degrees than the Pico commands on tilt (45→43.0 fusion / 44.1 raw accel;
> 92→88 raw accel), consistently across both mountings — check tilt 90 against
> a plumb line before trusting `gear 10.0`.

> **2026-11-05 PM — tilt zero moved back to the endstop.** The owner confirmed
> the tilt endstop is exactly level, and the re-mounted IMU agreed (fusion pitch
> -0.1, raw accelerometer -0.8 at the switch). So `tilt home_pos 0` and
> `tilt min 0` are saved to flash again (replacing -2 / -2), tilt 0 is the
> endstop, and `HEAD_IMU_PITCH_OFFSET_DEG=0.0`. Checked after re-homing: Pico
> tilt 0 → fusion 0.0 / raw -0.9; 45 → 42.0 / 42.7; 90 → 86.8 / 87.5; back to
> 0 → 0.1 / -0.6. The ~3.5 % shortfall at 90 remains (plumb-line check still
> owed). The "tilt 0 is level, endstop reads -2" passages below are superseded.

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

> **Superseded (2026-11-03 PM).** Tilt 0 is no longer "the endstop, roughly
> level". With `tilt home_pos -2` and `tilt min -2`, the endstop reads -2 and
> tilt 0 is level. See [Pico settings](#pico-settings) and "Placed and
> levelled" below.

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

### Placed and levelled; north registered (2026-11-03 PM)

**Placement.** The owner moved and levelled the rig, then set the camera dead
level and pointing at true north, with the Pico at pan 0 / tilt 2 (the
post-home reference tilt).

**Pico CFG**, saved to flash:

- `tilt home_pos 0` and `tilt min 0` (2026-11-05 PM; they were -2 / -2 from
  2026-11-03 to 2026-11-05): the endstop is level, so tilt 0 is the endstop.
- `pan min -270` and `pan max 270`: the cabling routed through the centre
  allows about a full turn each way. ±270 was chosen; the rest is margin.
- Then `HOME tilt` (about 25 s) and `goto tilt 0`, which put tilt at level.

**North registered.** `POST /api/setpos {"pan": 0}` gave `ref.pan = host`,
persisted. On the next restart the head minted frame `f092f491c67c9900` for
the pre-frame-id file. This is the expected one-time migration.

**Redeploy.** 69926a7 was redeployed (`docker compose up -d --build`) with
these `.env` settings:

- `HEAD_IMU_PITCH_OFFSET_DEG=-1.88`
- `HEAD_IMU_HEADING_OFFSET_DEG=83.3`: the IMU heading read 83.3 while the
  camera pointed north. The magnetometer is uncalibrated, so this value is
  coarse.

The restart kept the Pico homed and restored the pan reference from the file
without motion. `tiltDisagreeDeg` read -0.19 at level.

**Pending:** the owner's visual confirmation that the lens is level and on
north at pan 0 / tilt 0.

# Host bring-up

Spec section 8, steps 5 to 8, for the root `compose.yaml` on the application
host (`ohshit`, `atomist@192.168.4.92`, Debian 13, Celeron G6900, 2 cores,
15 GiB, Docker 29.9.2, Compose v5.7.0). Done 2026-11-03 evening (after sunset)
from branch `feat/host-stack`. The procedure is [DEPLOY.md](DEPLOY.md); this
section records what was measured.

**Status: step 5 passed. Steps 6 to 8 are the owner's (calibration, Pico
`vmax`/`amax`, arming the agent).** Before step 5 the head was referenced,
level, pointing north (pan 0, tilt 0), E-STOP clear.

## 5. Host stack up

Hardware on .92 (all three enumerate on the USB 2.0 root hub, bus 001):

| Device | Path / id |
|---|---|
| USB camera, MJPG | `/dev/v4l/by-id/usb-16MP_Camera_Mamufacture_16MP_USB_Camera_2022050701-video-index0` |
| ADALM-Pluto | `0456:b673`, libiio `usb:` |
| u-blox 7 GPS | `/dev/serial/by-id/usb-u-blox_AG_-_www.u-blox.com_u-blox_7_-_GPS_GNSS_Receiver-if00` |
| Intel iGPU | `/dev/dri/renderD128`, video gid 44, render gid 992 |

- [x] Copy the tree with `tar` over ssh (the host has no `rsync` and no sudo
      to install it), data tree at `/home/atomist/plainsight-data` (no sudo, so
      not `/srv/plainsight`), `.env` from `.env.example` plus the Ollama key
      piped from 1Password, `config.json` from `host/config.example.json`.
- [x] `docker compose up -d --build`: **1 min 17 s** wall for the first build
      and start (readsb `make` about 35 s). Every service started first time,
      0 restarts.

Three defects found and fixed on the way (all in this branch):

1. **tar1090 listened on :80, not :8088.** On .11 ultrafeeder was bridged with
   `8088:80`; under `network_mode: host` its nginx binds 80 and `adsbUrl`
   gets connection refused. Fixed with `TAR1090_NGINX_PORT=8088` in the `adsb`
   service.
2. **A blank `KEY=` in `.env` would crash the Node services.** `num()`/`bool()`
   treated `""` as unset but string keys did not, so the shipped
   `TB3_MCP_TOKEN=` reached `mcpToken: z.string().min(1)`. `loadConfig` now
   treats a blank value as unset for every key (test added).
3. **The camera device inside the container.** `cameraV4l2Device` defaults to
   `/dev/video0`, which compose does not map; `config.example.json` now names
   the by-id path that `CAMERA_DEVICE` maps. Also `adsbEnabled: true` there,
   since the stack ships the local ultrafeeder.

Also: MediaMTX 1.19.3 enables MoQ by default (an unauthenticated listener on
`:8892`, all interfaces, and an `auto.key permission denied` warning as uid
1000). `moq: no` added to `host/mediamtx/mediamtx.yml`.

### Measured

| Check | Result |
|---|---|
| `docker compose ps` | mcp (healthy), agent, dashboard, mediamtx, readsb-pluto, adsb/`ultrafeeder` (healthy), gpsd up; detector absent |
| `curl -s localhost:8770/healthz` | `{"ok":true}` |
| `curl -s localhost:8088/data/aircraft.json` | 9 aircraft (7 with position) 15 s after start; 11 (8 with position) after 4 min |
| ADS-B rate | 3392 messages in the last minute (about 56/s), all via Beast from `readsb-pluto` on 127.0.0.1:29005; max range 23.1 km |
| `readsb-pluto` log | `readsb 3.16.21`, `plutosdr: Context has 5 device(s)`, Beast on 29005. One harmless line: `Unable to create Avahi DNS-SD client` |
| ultrafeeder | feeds connected (adsb.fi, adsb.lol, planespotters, ...), MLAT handshakes complete |
| gpsd (`?WATCH` on 127.0.0.1:2947) | gpsd 3.22, u-blox driver, TPV `mode 3`, `status 2`, hdop 0.90 |
| `curl -s localhost:8788/api/state` | `rig.connected true`, `panRef "host"`, `estop false`, `link {pico:true, imu:true}`, telemetry age 34 to 55 ms |
| `services` | `{mcp: up, agentArmed: false, mediamtx: up, adsb: up, head: up}` |
| `calibration` | `calibrated: false`, no rig location, no sightings (expected; see below) |
| dashboard start line | `listening on http://0.0.0.0:8788 -> daemon :8770, head http://192.168.4.100:8780, camera mediamtx (vaapi)`; no encoder error |
| `docker compose exec dashboard vainfo` | Intel iHD 23.1.1; H264 Main/High/ConstrainedBaseline `VAEntrypointEncSlice` and `EncSliceLP` |
| Camera (Start camera over HTTP, 15 s) | MediaMTX path `tb3` ready, one H264 track, 0 frames in error; about 30 fps at 1280x720 read back over RTSP; ffmpeg about 9 % CPU. Mean luma 21.9 (night), hence only 25 kbit/s. Camera stopped again afterwards |
| agent | connected to the MCP server, Ollama Cloud `gpt-oss:120b`, deciding every 5 s, disarmed |
| SSE `GET /api/stream` from the workstation, 3 s | one state frame per second, `rig.connected true`, telemetry age about 40 ms |

### Controls over HTTP (from the workstation, through the dashboard)

| Action | Result |
|---|---|
| `POST /api/control/jog {"pan_dps":2,"tilt_dps":0,"duration_ms":300}` | 200 `jogged`; head pan 0 -> **0.657°**, then stopped |
| `POST /api/control/estop` | 200, `head E-STOP latched`, `pico_confirmed: true`, agent disarmed, tracking stopped; head `/api/state` `estop: true` |
| jog while latched | refused: `jog: estop latched; POST /api/estop/clear` |
| `POST /api/control/clear_estop` | 200 `E-STOP cleared`; head `estop: false` |

The head was left at pan 0.657°, tilt 0, E-STOP clear. It was not jogged back.

### Expected, not a fault

- **No calibration.** The dashboard shows the pan as referenced (the head
  reports `ref.pan = host`) but there is no calibration frame. Tracking stays
  gated until the operator sets the rig location and sights landmarks (step 6).
- **The dashboard logs `scanTrackable failed` / `scanAircraft failed: not
  calibrated` once a second each** until the rig location is set. Noisy but
  correct. Until then `adsb.rawCount` in `/api/state` is also `null` (see
  follow-ups).

### Left for the owner (needs a browser)

- [ ] Open `http://192.168.4.92:8788`: telemetry moving, the joystick jogs,
      E-STOP latches and clears.
- [ ] Press **Start camera**: video within a few seconds. WebRTC needs UDP
      8189 from the browser to .92; if the tile stays black, check that first.
- [ ] Open `http://192.168.4.92:8088`: tar1090 with aircraft and the
      HeyWhatsThat range rings.

## 6. Calibration (owner)

- [ ] `set_rig_location` from the dashboard. The GPS fix and
      `FEEDER_LAT` agree to about 40 m in latitude.
- [ ] Sight landmarks, solve, trims, as in the dashboard procedures.

### Recovery after a Pico reboot

A Pico reboot drops pan's reference. The head restoring its persisted
position in the frame the host already knows is accepted as is. Any other
reference after the reboot (`reference_pan`, `set_position`, a restore of a
frame the host does not know) arrives with no known offset from the old
frame, so the host flags the calibration frame unverified and, if pan limits
are taught, the taught pan limits too. All automated motion stays blocked
until both are cleared:

- [ ] Calibration: re-sight two landmarks or aircraft and `solve_calibration`
      (the safe path), or `confirm_pan_frame` if the head was not moved.
- [ ] Taught pan limits: re-teach both pan edges with `teach_limit`, or
      `confirm_taught_limits` if the head was not moved. The solve does not
      clear this one; its reply says automation is still blocked, and the
      dashboard shows **PAN LIMITS UNVERIFIED** until it is done.

## 7. Pico `vmax`/`amax` (owner)

- [ ] Raise from 5/10 via the head's `POST /api/config` until steps are lost,
      back off 30 %, `save`.

## 8. ADS-B tracking, then the agent (owner)

- [ ] Manual track of one aircraft from the dashboard.
- [ ] Arm the agent.

## Host follow-ups

- **USB placement.** The camera, Pluto and GPS share the USB 2.0 root hub.
  Fine at 720p MJPG so far; if frames drop or readsb loses samples, move the
  camera to a USB 3.0 port.
- **ADS-B range 23 km** with the Pluto and no LNA or filter. An LNA + 1090 MHz
  filter is the remedy (the Pluto has no bias-tee).
- **`adsb.rawCount` is lost when both daemon scans fail.** `getAdsb` returns
  an error before calibration, so the raw count from `peekAdsb` is dropped
  although the comment says it should survive. Cosmetic; it goes away once the
  rig location is set.
- **DHCP reservations** for .92 and .100 (see DEPLOY.md).
- **Time is GPS-disciplined since 2026-11-13 PM.** A `chrony` service (profile
  `gps`) reads gpsd's NTP shared-memory unit 0 (both containers `ipc: host`),
  steers the host clock with `CAP_SYS_TIME` and serves NTP on :123 to the LAN,
  replacing 192.168.4.11 as the house time source. Trigger: readsb logged one
  `ppm: -897` warning the night the WAN was down, which was systemd-timesyncd
  stepping the clock when the link came back, not the Pluto's crystal (the
  check runs every 30 s and fired once in 16 h). Findings at first start:
  GPS NMEA time arrives ~+90 ms late (serial latency, to be calibrated via
  `CHRONY_GPS_OFFSET`), the u-blox 7 USB dongle emits **no PPS** (gpsd sends
  TOFF but never PPS; the `PPS` refclock line stays at reach 0), pool anchor
  selected within 5 s, `sntp 192.168.4.92` answers from the workstation.
  Owner step still open: `sudo systemctl disable --now systemd-timesyncd` on
  .92, and point the other machines at .92 instead of .11.
- **Auth is off** (`TB3_DASHBOARD_AUTH=false`, no `TB3_MCP_TOKEN`). How to turn
  it on is in DEPLOY.md.
