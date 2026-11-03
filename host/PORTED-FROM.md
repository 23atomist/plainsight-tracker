# Ported from

Source: TB3-ESP32 feat/ops-rework d7c1e3c (2026-08-30)
Imported: 2026-11-03 (`git archive d7c1e3c tb3-mcp`, minus deploy/, dist/, tb3-mcp.plist, config.json, .pio)

Baseline on import (before reorganising), `npm ci && npm run build && npm test`:

```
 Test Files  149 passed (149)
      Tests  1662 passed (1662)
```

## Reorganisation map (old `src/` path -> new)

| Old | New |
| --- | --- |
| `server.ts`, `tools.ts`, `tool-helpers.ts`, `move.ts` | `src/mcp/` |
| `adsb-tools.ts floor-tools.ts geo-tools.ts imu-tools.ts limits-tools.ts range-tools.ts sector-tools.ts sun-tools.ts track-tools.ts vision-tools.ts` | `src/mcp/` |
| `agent/` | `src/agent/` (unchanged) |
| `dashboard/` | `src/dashboard/` (unchanged) |
| `adsb/ geo/ track/ policy/ capture/ recordings/ mediamtx/ vision/` | `src/shared/` |
| `aim-trim-store.ts floor-store.ts limits-store.ts policy-store.ts range-store.ts sector-store.ts vision-scale-store.ts` | `src/shared/` |
| `config.ts device.ts types.ts angles.ts calibration.ts imu-stats.ts` | `src/shared/` |

Package renamed `plainsight-host`; `start`/`dev` scripts now target `src/mcp/server.ts`. `TB3_*` env names and all identifiers unchanged.
