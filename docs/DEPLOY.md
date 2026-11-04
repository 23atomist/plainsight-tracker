# Deploy

The only install doc for both machines. The two-machine picture is in the
[README](../README.md); first-light results are in [BRING-UP.md](BRING-UP.md).

| Machine | Address | Runs |
|---|---|---|
| plainsight head (Orange Pi Zero 2W, Armbian trixie, arm64) | `192.168.4.100` | `head/compose.yaml`: the head API on `:8780` |
| application host (Debian 13, x86_64) | `192.168.4.92` | `compose.yaml` at the repo root: mcp, agent, dashboard, mediamtx, readsb-pluto, adsb, gpsd |

Both machines log in as `atomist` (uid 1000). Commands below run from the
repo root on the workstation unless they start with `ssh`.

## Prerequisites

- **Docker 29 and Compose v5 on both machines**, with `atomist` in the
  `docker` group (log out and in after `usermod -aG docker atomist`).
  On the head `atomist` also needs `dialout` and `i2c` (see
  `head/.env.example` for the gids).
- **DHCP reservations for both machines.** The head has already moved once
  (from `.96` to `.100`); every default in this repo now says `.100`. Reserve
  `192.168.4.100` for the head and `192.168.4.92` for the host in the router
  so a lease renewal cannot move them again. If the head does move, change
  `TB3_HEAD_URL` in the host `.env` and `headUrl` in
  `$PLAINSIGHT_DATA/config/config.json`, then `docker compose up -d`.
- **No `rsync` on the host.** Debian 13 ships without it and installing it
  needs sudo. Copy with `tar` over ssh (below); on the head `rsync` works.
- **Devices on the host** (stable by-id paths, already in `.env.example`):
  - camera `/dev/v4l/by-id/usb-16MP_Camera_Mamufacture_16MP_USB_Camera_2022050701-video-index0`
    (MJPG only; encoded to H.264 by VAAPI on `/dev/dri/renderD128`)
  - ADALM-Pluto (PlutoSDR), found by libiio as `usb:`
  - u-blox 7 GPS `/dev/serial/by-id/usb-u-blox_AG_-_www.u-blox.com_u-blox_7_-_GPS_GNSS_Receiver-if00`
  - group ids `video=44`, `render=992` (`getent group video render`)
- **The data tree, owned by uid 1000, before the first `up`.** The Node
  services run as uid 1000 and mediamtx is pinned to `1000:1000`. If Docker
  creates a bind-mount directory itself it is owned by root and state,
  snapshots and recordings become unwritable. Two layouts work:

  Without sudo (what the host runs today):

  ```bash
  ssh atomist@192.168.4.92 'mkdir -p ~/plainsight-data/{config,state,recordings,snapshots,adsb}'
  # .env: PLAINSIGHT_DATA=/home/atomist/plainsight-data
  ```

  With sudo, the layout the spec assumes:

  ```bash
  sudo mkdir -p /srv/plainsight/{config,state,recordings,snapshots,adsb}
  sudo chown -R 1000:1000 /srv/plainsight
  # .env: PLAINSIGHT_DATA=/srv/plainsight
  ```

## Head

The head's own bring-up (Docker, the serial and I2C passthrough, the Pico
settings, the TRACK benches) is in [BRING-UP.md](BRING-UP.md), steps 1 to 4.
In short:

```bash
rsync -a --exclude .venv --exclude data --exclude __pycache__ --exclude .pytest_cache \
  --exclude .ruff_cache --exclude '*.egg-info' head/ atomist@192.168.4.100:~/plainsight-tracker/head/
ssh atomist@192.168.4.100 'cd ~/plainsight-tracker/head && cp -n .env.example .env && mkdir -p data && docker compose up -d --build'
curl -s http://192.168.4.100:8780/healthz
```

The head API is documented in [HEAD-API.md](HEAD-API.md).

## Host

### 1. Copy the repo

```bash
COPYFILE_DISABLE=1 tar -cz --exclude node_modules --exclude .git --exclude .worktrees \
  --exclude .superpowers --exclude head/.venv --exclude head/data --exclude host/dist \
  --exclude .DS_Store --exclude ./.env -f - . \
  | ssh atomist@192.168.4.92 'mkdir -p ~/plainsight-tracker && tar -xzf - -C ~/plainsight-tracker'
```

(`COPYFILE_DISABLE=1` stops macOS tar adding `._*` files. GNU tar on the host
prints "Ignoring unknown extended header keyword" for the macOS xattrs; that is
harmless.) Where `rsync` exists the equivalent is
`rsync -a --exclude node_modules --exclude .git --exclude .worktrees --exclude .superpowers --exclude head/.venv --exclude head/data ./ atomist@192.168.4.92:~/plainsight-tracker/`.

### 2. `.env`

```bash
ssh atomist@192.168.4.92 'cd ~/plainsight-tracker && cp -n .env.example .env && chmod 600 .env'
```

Edit it on the host. The keys that differ per install:

| Key | Value on .92 |
|---|---|
| `PLAINSIGHT_DATA` | `/home/atomist/plainsight-data` (or `/srv/plainsight`) |
| `TB3_HEAD_URL` | `http://192.168.4.100:8780` |
| `TB3_LLM_API_KEY` | the Ollama Cloud key, from 1Password (below) |
| `CAMERA_DEVICE` | the camera by-id path |
| `GPS_DEVICE` | the u-blox by-id path |
| `COMPOSE_PROFILES` | `adsb,gps` (add `vision` only once the detector exists) |

A blank `KEY=` counts as unset, so the empty `TB3_MCP_TOKEN=` and
`INFLUX_TOKEN=` lines can stay.

The LLM key comes from 1Password on the workstation and is piped straight into
the host `.env`, never echoed or written to a local file:

```bash
op item get <your-1password-item-id> --fields password --reveal \
  | ssh atomist@192.168.4.92 'IFS= read -r k; cd ~/plainsight-tracker && K="$k" awk '"'"'BEGIN{k=ENVIRON["K"]} /^TB3_LLM_API_KEY=/{print "TB3_LLM_API_KEY=" k; next} {print}'"'"' .env > .env.new && mv .env.new .env && chmod 600 .env'
```

### 3. `config.json`

```bash
ssh atomist@192.168.4.92 'cp -n ~/plainsight-tracker/host/config.example.json ~/plainsight-data/config/config.json'
```

The example already carries the head on `.100`, the camera by-id path in
`cameraV4l2Device` (inside the container `/dev/video0` does not exist; compose
maps `${CAMERA_DEVICE}` at its own path), `cameraEncoder: vaapi` at 1280x720,
and `adsbEnabled: true` against the local ultrafeeder. Environment variables
(`TB3_*`) override the file. Key reference: [host/README.md](../host/README.md#configuration).

### 4. Start

```bash
ssh atomist@192.168.4.92 'cd ~/plainsight-tracker && docker compose up -d --build'
```

The first build pulls the base images and compiles TypeScript and readsb (with
libiio) from source. On the Celeron G6900 the whole first `up -d --build` took
1 min 17 s wall (readsb's `make` about 35 s); later builds reuse the layer
cache.

### Dashboard and MCP auth

First light runs with auth off (`TB3_DASHBOARD_AUTH=false`, no
`TB3_MCP_TOKEN`) on the trusted LAN. What that exposes, to anyone who can reach
the LAN:

- **Dashboard, `:8788`** (binds every interface): move the head (jog, goto,
  point, track), clear an E-STOP, arm the autonomous agent, and every other
  dashboard control.
- **MCP server, `:8770`** (listens on every interface, host networking): every
  MCP tool, the same as above plus writing the head's config
  (`set_head_config`, including guarded keys with `force`).
- **Head API, `:8780` on the head (192.168.4.100)**: moves the head, clears its
  E-STOP and writes its config directly. It has no auth at all.

Turning on the dashboard and MCP token (below) closes `:8788` and `:8770`. It
does **not** protect the head API: anything that can reach the head's address
can still drive it. Keep the head on a segment only the host and trusted
machines can reach.

To turn auth on, set a long random token and enable the gate, then recreate the
services:

```bash
# in .env on the host
TB3_MCP_TOKEN=<output of: openssl rand -hex 32>
TB3_DASHBOARD_AUTH=true
```

```bash
docker compose up -d mcp agent dashboard
```

The MCP server then requires `Authorization: Bearer <token>`; the agent and the
dashboard read the same token from `.env`. Browsers open the dashboard as
`http://192.168.4.92:8788/?token=<token>` once, which sets the cookie.

## Verification

On the host (`ssh atomist@192.168.4.92`, then `cd ~/plainsight-tracker`):

```bash
docker compose ps                                   # mcp, agent, dashboard, mediamtx, readsb-pluto, adsb (ultrafeeder), gpsd up; no detector
curl -s localhost:8770/healthz                      # MCP: {"ok":true}
curl -s localhost:8088/data/aircraft.json | head -c 300   # tar1090: non-empty "aircraft" array
curl -s localhost:8788/api/state | head -c 600      # rig.connected true, services.head/adsb/mediamtx "up"
curl -s localhost:9997/v3/paths/list                # MediaMTX API: path tb3
curl -s http://192.168.4.100:8780/healthz           # the head, from the host
docker compose exec dashboard vainfo                # VAEntrypointEncSlice for H264 profiles
docker compose logs readsb-pluto --tail 20          # Pluto opened
docker compose logs gpsd --tail 10
```

In a browser: `http://192.168.4.92:8788` (dashboard: telemetry, jog, E-STOP
latch and clear, Start camera) and `http://192.168.4.92:8088` (tar1090). The
camera tile is WebRTC: the browser needs UDP 8189 to the host.

After deploy the dashboard shows the pan as referenced (the head reports
`ref.pan = host`) but no calibration. That is expected: tracking stays gated
until the operator sights landmarks from the dashboard.

## Updating

```bash
# workstation: copy the new tree (step 1), then
ssh atomist@192.168.4.92 'cd ~/plainsight-tracker && docker compose up -d --build'
```

If the host ever gets a git checkout instead of a copied tree, this becomes
`git pull && docker compose up -d --build`. `.env` and `config.json` are never
in git and are never overwritten by the copy (`--exclude ./.env`; config lives
under `$PLAINSIGHT_DATA`). A changed `config.example.json` is NOT copied over an
existing `config.json`: diff and merge by hand.

## Logs

```bash
docker compose logs -f <service>        # mcp | agent | dashboard | mediamtx | readsb-pluto | adsb | gpsd
docker compose logs --tail 100 dashboard
```

The ultrafeeder container is named `ultrafeeder` (service `adsb`).

## Troubleshooting

- **VAAPI.** `docker compose exec dashboard vainfo` must list
  `VAProfileH264*: VAEntrypointEncSlice` (or `EncSliceLP`). "failed to
  initialize display" means `/dev/dri/renderD128` is not mapped or
  `RENDER_GID` is wrong (`getent group render`). The driver
  (`intel-media-va-driver-non-free`) is only installed in amd64 images. The
  software fallback is `cameraEncoder: x264`, 720p at most on this CPU.
- **Camera.** `ls -l /dev/v4l/by-id/`: use the `video-index0` node (index1 is
  the metadata node). A different camera means a different by-id path in both
  `CAMERA_DEVICE` (.env) and `cameraV4l2Device` (config.json). The camera
  only produces MJPG; supported modes:
  `docker compose exec dashboard ffmpeg -hide_banner -f v4l2 -list_formats all -i "$CAMERA_DEVICE"`.
  The dashboard does not start the camera until "Start camera" is pressed
  (`cameraStartEnabled: false`).
- **USB bandwidth.** On .92 the Pluto, the GPS and the camera all enumerate on
  the USB 2.0 root hub (bus 001, `lsusb -t`). If the camera drops frames or
  readsb reports lost samples, move the camera to a USB 3.0 port (bus 002).
- **PlutoSDR.** `docker compose logs readsb-pluto` should show the Pluto being
  opened at `usb:`. "No device found" means the Pluto is not on USB or another
  process holds it; `lsusb | grep -i pluto` on the host (`0456:b673`).
  `PLUTO_GAIN` (default 60) is the only receiver knob; there is no PPM to set
  on the Pluto (the RTL-SDR PPM item from the spec no longer applies).
- **tar1090 not on :8088.** With host networking there is no `8088:80`
  mapping, so ultrafeeder's nginx is told the port with
  `TAR1090_NGINX_PORT=8088` in `compose.yaml`. Without it nginx binds `:80`,
  `adsbUrl` fails and the dashboard shows `services.adsb down`.
- **ADS-B empty.** `curl -s localhost:8088/data/aircraft.json`: an empty
  `aircraft` array with `messages` climbing means the receiver works but sees
  nothing (antenna); `messages` stuck means ultrafeeder is not getting Beast
  from `127.0.0.1:31005` (check `readsb-pluto` is up).
- **GPS.** `docker compose logs gpsd`; from the host
  `(echo '?WATCH={"enable":true,"json":true}'; sleep 3) | nc -q1 127.0.0.1 2947`.
- **Head unreachable.** `curl -s http://192.168.4.100:8780/healthz` from the
  host. The dashboard shows `services.head down` and the E-STOP button reports
  the head leg failed. Check the DHCP lease first.
- **A service crash-loops.** `docker compose logs --tail 100 <service>`. A
  config error names the key (`headUrl: must start with http://`).
