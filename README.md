# plainsight-tracker

A roof-mounted pan/tilt camera head that points at aircraft. A small head
controller drives the motors and reports telemetry; an application host on the
LAN decides where to look (ADS-B, calibration, an LLM target chooser), streams
the camera and serves the operator dashboard.

## Two machines

```
                 LAN 192.168.4.0/22
                          |
  +-----------------------+-----------------------------+
  |                                                     |
  plainsight head (Orange Pi Zero 2W, 192.168.4.100)    application host (192.168.4.92)
  Armbian trixie, arm64, Docker                         Debian 13, x86_64, Docker 29 + Compose v5
  |                                                     |
  |  head/compose.yaml                                  |  compose.yaml (network_mode: host)
  |   +-- head  (Python, :8780 HTTP + WS)               |   +-- mcp           :8770  MCP server + tracking + capture
  |        |-- SKR Pico (plainsight-ptz) on USB serial  |   +-- agent                LLM target chooser (MCP client)
  |        +-- BNO055 IMU on I2C                        |   +-- dashboard     :8788  ops UI, camera ingest (ffmpeg VAAPI -> MediaMTX)
  |                                                     |   +-- mediamtx      :8189/udp WebRTC; api/rtsp/whep on 127.0.0.1
  |                                                     |   +-- adsb          :8088  ultrafeeder (readsb on the RTL-SDR + tar1090 + feeders)
  |                                                     |   +-- gpsd          :2947  u-blox 7 (loopback)
  |                                                     |   +-- detector             profile "vision", not built yet
  |                                                     |
  |                                                     |  USB camera (MJPG), Nooelec RTL-SDR, u-blox 7 GPS
  |                                                     |  /dev/dri/renderD128  Intel VAAPI
  |                                                     |  $PLAINSIGHT_DATA/{config,state,recordings,snapshots,adsb}
  |
  external: LLM = Ollama Cloud; optional InfluxDB on 192.168.4.11 for ultrafeeder stats
```

The host talks to the head only through the head API over the LAN. The head
never talks to the host; it serves. The dashboard's E-STOP latches the head
directly, without going through the MCP server.

## Repo layout

```
plainsight-tracker/
  README.md            this file
  compose.yaml         the application host stack
  .env.example         host settings (copy to .env on the host; never commit .env)
  head/                the head controller: compose.yaml, Dockerfile, plainsight_head/, tests/, tools/
  host/                the host stack: one Node image for mcp/agent/dashboard
    src/               mcp/ agent/ dashboard/ shared/
    dashboard/public/  the dashboard UI (vanilla JS, no build)
    mediamtx/          mediamtx.yml
    gpsd/              gpsd image
    config.example.json
    test/              vitest suite
  docs/
    DEPLOY.md          install and update both machines
    HEAD-API.md        the head API reference, with JSON Schemas in head-api/
    BRING-UP.md        first-light checklist and measured results
    superpowers/       design spec and implementation plans
```

## Docs

- [docs/DEPLOY.md](docs/DEPLOY.md): prerequisites, head, host, verification,
  updating, logs, troubleshooting.
- [docs/HEAD-API.md](docs/HEAD-API.md): the head's HTTP and WebSocket API.
- [docs/BRING-UP.md](docs/BRING-UP.md): bring-up steps and what was measured.
- [host/README.md](host/README.md): host configuration keys, MCP tools, tracking,
  sun guard, dashboard.
- Design spec: [docs/superpowers/specs/2026-11-03-plainsight-tracker-design.md](docs/superpowers/specs/2026-11-03-plainsight-tracker-design.md).

## Quick start (host)

```bash
# on the host, after copying the repo (see docs/DEPLOY.md)
mkdir -p ~/plainsight-data/{config,state,recordings,snapshots,adsb}
cp -n .env.example .env            # set PLAINSIGHT_DATA, TB3_LLM_API_KEY
cp -n host/config.example.json ~/plainsight-data/config/config.json
docker compose up -d --build
```

Dashboard: `http://192.168.4.92:8788`. tar1090: `http://192.168.4.92:8088`.

## Development

```bash
cd host && npm ci && npm test      # Node 22
cd head && pytest                  # Python 3.13
```
