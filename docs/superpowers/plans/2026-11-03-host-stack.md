# Host Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the `tb3-mcp` host stack (MCP server, agent, dashboard) from the ESP32 step-based device API to the plainsight head API, drop everything that needed a host install, and ship it as one Docker Compose project with MediaMTX and the ADS-B feeder.

**Architecture:** The existing TypeScript project moves into `host/` and is reorganised as `src/{mcp,agent,dashboard,shared}`. The only component that talks to hardware, `shared/device.ts`, is rewritten against the head API (degrees, `POST /api/track`, `/ws` ticks). Everything above it keeps its logic; call sites that touched step units, the ESP32 program/camera/battery features, or `systemctl` are ported or removed. A `FakeHead` test server replaces `MockTb3`. Compose runs the four services with host networking plus the ADS-B feeder.

**Tech Stack:** Node 22, TypeScript 5, express, ws, zod, `@modelcontextprotocol/sdk`, vitest; `bluenviron/mediamtx` image; `ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder`; ffmpeg with Intel VAAPI.

**Spec:** `docs/superpowers/specs/2026-11-03-plainsight-tracker-design.md` (sections 3, 6, 7, 8, 9, 11) and `docs/HEAD-API.md` with `docs/head-api/schemas/` (produced by the head plan, Task 10; this plan's Task 3 needs them).

## Global Constraints

- Source of the port: `TB3-ESP32` branch `feat/ops-rework` at commit `d7c1e3c` (spec 6.10). Nothing from `main`, `feat/reboot-rezero`, or `feat/calib-fixes-tuning`.
- No step units anywhere after Task 4: `STEPS_PER_DEG`, `stepsToDeg`, `degToSteps`, `panSteps`, `tiltSteps`, `auxSteps` must not appear in `host/src` or `host/test` (`grep -r` returns nothing).
- No `systemctl`, `execFile("systemctl"`, polkit, or `/opt` references after Task 8.
- Internal `TB3_*` env prefix, the `tb3` MediaMTX path, and `~/.tb3-mcp` fallbacks for store files are kept (spec section 3); user-facing names (compose services, images, docs) are `plainsight-*`.
- The vitest suite stays green at the end of every task (`cd host && npm test`), with `fileParallelism: false` as today. The baseline count is recorded in Task 1 and must not go down except by the deletions this plan names.
- Keep the module-level comments that record field lessons wherever the surrounding logic survives (spec section 10).
- Conventional-commit messages; commit after every task.

## Review Focus

1. A head tick that carries no `axes` (Pico link down) must not refresh `lastUpdateMs`, so tracking enters `waiting` with reason `stale_telemetry` within `trackStaleTelemetryMs` rather than servoing on frozen angles (Task 3 and Task 5).
2. A `pan_reference` event with `source: none` arriving mid-track must stop the session and refuse new automated motion until a reference returns; a jog and a goto must still work (Task 7).
3. The dashboard E-STOP must latch the head (`POST /api/estop`) even when the MCP server is down, and the page must show the latch and offer "Clear E-STOP" (Task 8).
4. Config loaded with the old keys (`deviceHost`, `trackKp`, `jogVectorTtlMs`, `cameraEncoder: "nvenc"`) must fail validation with a message naming the key and the replacement, not boot with silently ignored settings (Task 2).
5. A head `/api/config` where pan `amax` is smaller than the host's assumed deceleration must widen the limit guard's stopping horizon; a guard tuned for the ESP32 constant would overrun the stop (Task 5).

---

## File structure (after Task 1)

```
host/
  Dockerfile  .dockerignore  package.json  package-lock.json  tsconfig.json  tsconfig.build.json  vitest.config.ts
  PORTED-FROM.md                         source commit and the reorganisation map
  src/
    shared/                              config.ts device.ts head-types.ts types.ts angles.ts calibration.ts
                                         adsb/ geo/ track/ policy/ capture/ recordings/ mediamtx/ vision/
                                         *-store.ts imu-stats.ts agent-store.ts (Task 8)
    mcp/                                 server.ts tools.ts tool-helpers.ts move.ts *-tools.ts
    agent/                               agent.ts loop.ts decide.ts llm.ts mcp-client.ts
    dashboard/                           server.ts client.ts controls.ts state.ts parse.ts head.ts (was rig.ts) util.ts auth.ts
                                         recordings-routes.ts camera/
  dashboard/public/                      unchanged vanilla JS, small edits in Task 8
  mediamtx/mediamtx.yml
  test/                                  as today plus fake-head.ts; mock-tb3.ts deleted in Task 3
compose.yaml  .env.example  (repo root)
docs/DEPLOY.md  docs/BRING-UP.md (host section)  README.md
```

---

### Task 1: Import the source and reorganise

**Files:**
- Create: `host/` (everything from `tb3-mcp/` at `d7c1e3c` except `deploy/`, `dist/`, `node_modules/`, `config.json`, `.pio`), `host/PORTED-FROM.md`
- Modify: `host/package.json` (`name: "plainsight-host"`, scripts `start`→`node dist/mcp/server.js`, `agent`→`node dist/agent/agent.js`, `dashboard`→`node dist/dashboard/server.js`, dev variants likewise), every import path touched by the move

**Interfaces:**
- Produces: the module layout in the file structure above. `src/mcp/` holds `server.ts`, `tools.ts`, `tool-helpers.ts`, `move.ts`, and every `*-tools.ts`; `src/shared/` holds everything else that is not `agent/` or `dashboard/`. The dashboard's static root resolution in `src/dashboard/server.ts:627` (`../../dashboard/public`) still resolves from `dist/dashboard/`.

- [ ] **Step 1: Export the source**

Run: `cd /Volumes/ExtData2/coding/TB3-ESP32 && git archive d7c1e3c tb3-mcp | tar -x -C /Volumes/ExtData2/coding/plainsight-tracker/ && cd /Volumes/ExtData2/coding/plainsight-tracker && mv tb3-mcp host && rm -rf host/deploy host/dist host/tb3-mcp.plist`
Expected: `host/src`, `host/test`, `host/dashboard/public`, `host/package.json` present; `host/deploy` absent.

- [ ] **Step 2: Baseline**

Run: `cd host && npm ci && npm run build && npm test 2>&1 | tail -5`
Expected: build clean; tests pass; record the test-file and test counts in `host/PORTED-FROM.md` together with `Source: TB3-ESP32 feat/ops-rework d7c1e3c (2026-08-30)`.

- [ ] **Step 3: Reorganise with `git mv`** per the file structure, then fix imports (`tsc --noEmit` lists each; tests import via `../src/...` so update those too). Rename `src/dashboard/rig.ts` to `head.ts` only in Task 8; leave it now.

- [ ] **Step 4: Verify**

Run: `cd host && npm run build && npm test 2>&1 | tail -3 && grep -rn "from \"\.\./src/" test | grep -v "src/\(shared\|mcp\|agent\|dashboard\)/" | head`
Expected: build clean; same test counts as the baseline; the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add -A host && git commit -m "chore(host): import tb3-mcp from feat/ops-rework d7c1e3c and reorganise into mcp/agent/dashboard/shared"
```

---

### Task 2: Configuration for the new topology

**Files:**
- Modify: `host/src/shared/config.ts` (schema `:6-203`, env overrides `:233-317`, `loadConfig` `:219`), `host/config.example.json`
- Test: `host/test/config.test.ts` (extend)

**Interfaces:**
- Removed keys (presence in the file is a validation error whose message names the key and its replacement): `deviceHost`→`headUrl`, `deviceIpFallback` (none), `trackKp`, `trackRateSlewDps`, `jogVectorTtlMs` (none: "tracking is servoed by the head"), `auxSign` (none).
- Added keys with defaults: `headUrl: string` default `http://192.168.4.96:8780` (env `TB3_HEAD_URL`, must start with `http://` or `https://`); `llmApiKey?: string` (env `TB3_LLM_API_KEY`, never written to any log or status payload); `stateDir: string` default `/data/state` (env `TB3_STATE_DIR`); `snapshotDir`: existing `captureSnapshotDir` default becomes `/data/snapshots`; `passJournalFile` default becomes `/data/state/passes.jsonl`; `agentFile` is derived (`join(stateDir, "agent.json")`).
- Changed defaults: `cameraEncoder` enum gains `"vaapi"` and defaults to it; `cameraFfmpegBin` and `captureFfmpegBin` default `/usr/bin/ffmpeg`; `parkTiltDeg` default `60`; `tiltMin` default `0`; `llmUrl` default `https://ollama.com/v1/chat/completions`; `llmModel` default `gpt-oss:120b`; `adsbUrl` default `http://127.0.0.1:8088/data/aircraft.json`; `maxJogDps` keeps its meaning as the manual-jog rate ceiling (dps).
- Store file keys (`calibrationFile`, `sectorFile`, `floorFile`, `rangeFile`, `limitsFile`, `visionScaleFile`) keep their override role; their default moves from `~/.tb3-mcp/<name>.json` to `join(stateDir, "<name>.json")`, and `aim-trim.json`, `policy.json` follow the same rule (server.ts `:527`, `:537`).

- [ ] **Step 1: Write the failing tests**

```ts
// host/test/config.test.ts (additions)
it("rejects retired keys by name with the replacement", () => {
  for (const [key, hint] of [["deviceHost", "headUrl"], ["trackKp", "head"], ["jogVectorTtlMs", "head"], ["auxSign", "removed"]])
    expect(() => parseConfig({ [key]: 1 })).toThrow(new RegExp(`${key}.*${hint}`, "i"));
});
it("rejects cameraEncoder nvenc only when asked? no: nvenc stays selectable; vaapi is the default", () => {
  expect(parseConfig({}).cameraEncoder).toBe("vaapi");
  expect(parseConfig({ cameraEncoder: "nvenc" }).cameraEncoder).toBe("nvenc");
});
it("new defaults", () => {
  const c = parseConfig({});
  expect(c).toMatchObject({ headUrl: "http://192.168.4.96:8780", stateDir: "/data/state", parkTiltDeg: 60, tiltMin: 0,
    cameraFfmpegBin: "/usr/bin/ffmpeg", adsbUrl: "http://127.0.0.1:8088/data/aircraft.json" });
  expect(c.llmUrl).toMatch(/^https:\/\/ollama\.com\//);
});
it("env overrides for the new keys", () => {
  const c = loadConfig(undefined, { TB3_HEAD_URL: "http://h:1", TB3_LLM_API_KEY: "k", TB3_STATE_DIR: "/tmp/s" });
  expect([c.headUrl, c.llmApiKey, c.stateDir]).toEqual(["http://h:1", "k", "/tmp/s"]);
});
it("headUrl must be http(s)", () => expect(() => parseConfig({ headUrl: "192.168.4.96" })).toThrow(/headUrl/));
```

(`parseConfig` is `ConfigSchema.parse` exported for tests, or `loadConfig` with a temp file; follow whatever the existing config tests use.)

- [ ] **Step 2: Run to verify failure**

Run: `cd host && npx vitest run test/config.test.ts`
Expected: the new cases fail.

- [ ] **Step 3: Implement** the schema changes with a `z.preprocess` (or `superRefine`) that reports retired keys; update `config.example.json`; update the `~/.tb3-mcp` defaults in `src/mcp/server.ts` to `cfg.stateDir`.

- [ ] **Step 4: Run the whole suite**

Run: `cd host && npm run build && npm test 2>&1 | tail -3`
Expected: green. Tests elsewhere that constructed configs with `deviceHost`/`trackKp` must be updated in this task (grep `deviceHost\|trackKp\|jogVectorTtlMs\|auxSign` under `test/`).

- [ ] **Step 5: Commit**

```bash
git add -A host && git commit -m "feat(host): config for the head URL, state dir, VAAPI default, Ollama Cloud, retired ESP32 keys"
```

---

### Task 3: Device client against the head API, with a FakeHead

**Files:**
- Create: `host/src/shared/head-types.ts`, `host/test/fake-head.ts`
- Rewrite: `host/src/shared/device.ts`, `host/src/shared/types.ts`
- Delete: `host/test/mock-tb3.ts`, `host/src/shared/angles.ts` lines 1-9 (`STEPS_PER_DEG`, `stepsToDeg`, `degToSteps`; keep `applySign`, `Limits`, `checkPanTilt`, `checkSpeed`), `host/test/angles.test.ts:10-16`
- Test: `host/test/device.test.ts` (rewrite), `host/test/head-contract.test.ts` (new)

**Interfaces:**
- Produces (`head-types.ts`): `interface HeadAxis { pos: number; vel: number; tgt: number; mode: "I"|"P"|"T"|"V"|"H"; homed: boolean; endstop: boolean; driver: boolean }`, `interface HeadImu { ok: boolean; heading: number|null; pitch: number|null; roll: number|null; cal: {sys:number;gyr:number;acc:number;mag:number}|null; tempC: number|null }`, `interface HeadRef { pan: "none"|"imu"|"host"; persisted: boolean; ageS: number|null }`, `interface HeadTick { type:"tick"; t:number; seq:number; axes?: Record<"pan"|"tilt"|"zoom"|"focus", HeadAxis>; enabled?: boolean; moving?: boolean; estop: boolean; imu: HeadImu; tiltDisagreeDeg: number|null; ref: HeadRef; link: {pico:boolean; imu:boolean} }`, `interface HeadEvent { type:"event"; t:number; name:string; axis:string|null; detail: unknown }`, `interface HeadAxisConfig { min:number; max:number; vmax:number; amax:number }`, `interface HeadImuSample { t:number; heading:number; roll:number; pitch:number; quat:[number,number,number,number]; gravity:[number,number,number]; linacc:[number,number,number]; cal:{sys:number;gyr:number;acc:number;mag:number}; tempC:number }`, plus zod schemas `HeadTickZ`, `HeadEventZ` mirroring `docs/head-api/schemas`.
- Produces (`types.ts`): `interface DeviceState { connected: boolean; panDeg: number; tiltDeg: number; zoomDeg: number; focusDeg: number; axes?: HeadTick["axes"]; moving: boolean; enabled: boolean; estop: boolean; imu?: HeadImu; tiltDisagreeDeg: number|null; ref: HeadRef; link: {pico:boolean; imu:boolean}; lastUpdateMs: number }`. `panDeg`… are the raw head values (device frame); `applySign` still maps to the user frame at the call sites.
- Produces (`device.ts`): `class DeviceHttpError extends Error { status: number }` (kept); `class Device` with `constructor(cfg: Config, now = Date.now, fetchFn = fetch, wsFactory = (url) => new WebSocket(url))`, `start()`, `close()`, `getState(): DeviceState`, `onTelemetry(cb)`, `onEvent(cb: (e: HeadEvent) => void)`, `onReferenceChanged(cb: (c: {source: HeadRef["pan"]; pan: number|null; previous: number|null}) => void)` (fired from `pan_reference` events), `onConfig(cb: (c: Record<"pan"|"tilt", HeadAxisConfig>) => void)`, `getAxisConfig(): Record<"pan"|"tilt", HeadAxisConfig> | null`, `async gotoAngle(panDeg, tiltDeg, speedDps?)` (speed ignored by the head; kept for callers), `async track(cmd: {pan?: {pos:number; vel:number}; tilt?: {pos:number; vel:number}})`, `async jog(panDps, tiltDps, durationMs)` (refreshes `POST /api/jog` every 100 ms for `durationMs`, then sends zeros), `setJogVector(panDps, tiltDps, ttlMs)`/`clearJog()`/`lockJog()`/`unlockJog()` (same dead-man semantics as before but the frame is `POST /api/jog` with dps), `async stop()`, `async estop()`, `async clearEstop()`, `async home(axes?: string[])`, `async setPos(pos: {pan?: number; tilt?: number})`, `async reference()`, `async getGravity(n = 100): Promise<Vec3>` (mean of `samples[].gravity` from `GET /api/imu?n=`; throws `IMU not ok` when the head reports `imu.ok === false`), `async waitForArrival(targetPanDeg, targetTiltDeg, timeoutMs)` (tolerance 0.25°, no arrival until `moving === false`).
- Behaviour: a tick without `axes` updates `link`, `imu`, `ref`, `estop` and does NOT touch `lastUpdateMs` or `connected`'s companion `moving`; `connected` is the WebSocket state. On WS open the client fetches `GET /api/config` and caches pan/tilt `{min,max,vmax,amax}`; a `config` event refetches. Reconnect every 1 s; single host, no fallback.
- Produces (`test/fake-head.ts`): `class FakeHead` with `start(): Promise<number>` (port), `stop()`, `url`, a model `{axes, enabled, estop, imu, ref, link}`, `tick()` (publish one tick to all WS clients), `tickNoAxes()`, `emitEvent(e)`, `setConfig(axis, patch)`, request log `calls: {method, path, body}[]`, and the routes of spec 4.3 with the status codes (423 while `estop`, 503 while `link.pico === false`, 409 on `setpos` while moving, 202 for goto/home/reference). It validates every outgoing tick against `docs/head-api/schemas/tick.json`.
- Exposes the former `MockTb3` conveniences the other tests used: `setPosition(panDeg, tiltDeg)`, `lastGoto`, `lastTrack`, `lastJog`, `stopCount`, `homeCount`, `gotoCount`, `imuOk`.

- [ ] **Step 1: Write the failing tests**

```ts
// host/test/device.test.ts (rewrite; names are the contract)
it("parses a tick into degrees and fires telemetry once per tick")
it("a tick without axes updates link/imu/ref but not lastUpdateMs or angles")
it("goto posts /api/goto and resolves on 202; 423 becomes DeviceHttpError(423)")
it("track posts the pos/vel pairs exactly as given")
it("jog refreshes every 100ms and sends zeros at the end; setJogVector expires via TTL")
it("lockJog clears and blocks refreshes until unlockJog")
it("estop/clearEstop/home/setPos/reference hit their routes")
it("getGravity averages the burst gravity vectors and throws when imu.ok is false")
it("fetches /api/config on open and on a config event; getAxisConfig returns pan/tilt")
it("pan_reference events fire onReferenceChanged with source/pan/previous")
it("reconnects after the socket closes")
// host/test/head-contract.test.ts
it("FakeHead ticks and events validate against docs/head-api/schemas")   // uses ajv or zod-from-schema; add `ajv` as a devDependency
it("HeadTickZ accepts every example in docs/HEAD-API.md")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd host && npx vitest run test/device.test.ts test/head-contract.test.ts`
Expected: FAIL (types and FakeHead missing).

- [ ] **Step 3: Implement** `head-types.ts`, `types.ts`, `device.ts`, `fake-head.ts`; delete `mock-tb3.ts` and the step helpers. The 19 test files that imported `MockTb3` are switched to `FakeHead` in this task only where the import and construction change; their step-based assertions are ported in Task 4 (expect those files to fail until then; run just the two new files here).

- [ ] **Step 4: Run to verify pass**

Run: `cd host && npx vitest run test/device.test.ts test/head-contract.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add -A host && git commit -m "feat(host): Device client for the head API, FakeHead test server, contract tests"
```

---

### Task 4: Degrees everywhere

**Files:**
- Modify: `host/src/mcp/move.ts:3,48-58`, `host/src/mcp/tools.ts:5,68-74`, `host/src/mcp/sun-tools.ts:9,34-35`, `host/src/mcp/vision-tools.ts:8,548-549`, `host/src/mcp/server.ts:13,114-119`, `host/src/mcp/geo-tools.ts:5,48-52`, `host/src/shared/track/supervisor.ts:10,189-190,371-372`, `host/src/shared/track/session.ts:6,313-314`, `host/src/dashboard/parse.ts`, `host/src/dashboard/state.ts:162,327`
- Modify tests: `session.test.ts`, `session-identity.test.ts`, `session-floor.test.ts`, `session-sector.test.ts`, `session-aim-offset.test.ts` (FakeDevice: fields `panDeg/tiltDeg`, `getState()` returns the new `DeviceState`, add `track(cmd)` recording to `tracks[]`, keep `setJogVector/clearJog/stop/gotoAngle/waitForArrival`), `vision-fix4-restore.test.ts`, `vision-tools.test.ts`, `vision-sign-audit.test.ts`, `vision-composition-root.test.ts`, `limits-tools.test.ts`, `tools.test.ts`, `supervisor.test.ts`, `dashboard-parse.test.ts`, `dashboard-state.test.ts`, `cockpit.test.ts`, and the other `MockTb3` users listed in the map (device-jog, imu-tools-north-zero, server-error, pass-recorder-composition-root, vision-predictpixel-wiring, tracking-sim, geo-tools, sun-tools, imu-ingest, server, track-tools).

**Interfaces:**
- `get_status` output (`tools.ts:60`) becomes `{ connected, pan_deg, tilt_deg, zoom_deg, focus_deg, moving, enabled, estop, pan_ref, tilt_disagree_deg, link, imu, last_update_age_ms }`; `aux_steps`, `program_engaged`, `battery_v`, `sta_ip` are gone. `src/dashboard/client.ts:22-30` `DeviceStatusZ` follows.
- `move.ts` `moveToUserAngle` signature unchanged; the body compares degrees and passes degrees to `waitForArrival`.
- `dashboard/parse.ts` `parseRigStatus` is replaced by `parseHeadState(raw: unknown): HeadDirect` where `HeadDirect = { connected: boolean; panDeg: number|null; tiltDeg: number|null; moving: boolean|null; estop: boolean; ref: HeadRef|null; imu: HeadImu|null; tiltDisagreeDeg: number|null; link: {pico:boolean; imu:boolean}|null }` (validated with `HeadTickZ`).
- `dashboard/state.ts` `DashboardState.rig` drops `batteryV` and gains `estop`, `panRef` (`"none"|"imu"|"host"|null`), `tiltDisagreeDeg`, `link`.

- [ ] **Step 1: Port src call sites** to `panDeg/tiltDeg` (device frame) and remove the step helpers imports. In `session.ts:384` and `supervisor.ts:318` replace `programEngaged` with `estop` (reason strings `"estop"` in both).

- [ ] **Step 2: Port the tests** named above: replace `N * STEPS_PER_DEG` with `N`, `/ 444.444` with the degree value, `programEngaged` with `estop`, `MockTb3` with `FakeHead`, `battery_v`/`batteryV` fixtures removed, dashboard fixtures to `HeadDirect`.

- [ ] **Step 3: Verify**

Run: `cd host && npm run build && npm test 2>&1 | tail -3 && grep -rn "STEPS_PER_DEG\|stepsToDeg\|degToSteps\|panSteps\|tiltSteps\|auxSteps\|programEngaged\|batteryV\|staIp\|444\.444" src test | wc -l`
Expected: green except the tracking-control tests that Task 5 owns (`control.test.ts`, `tracking-sim.test.ts`, and the `session*.test.ts` cases asserting on jog vectors; list them in the commit message); the grep count is `0`.

- [ ] **Step 4: Commit**

```bash
git add -A host && git commit -m "refactor(host): degrees everywhere; ESP32 program/battery/steps removed from state and tools"
```

---

### Task 5: Tracking via the head's TRACK

**Files:**
- Modify: `host/src/shared/track/session.ts:440-515` (the servo tail of `tick()`), `:11-13` imports, `:325-330` (`cancelGoto`/`stopMotion`), `host/src/shared/track/control.ts` (delete `controlRate :123`, `slewTowards :151`, `rateToDeflection :169`, `decelMs :207` and the `FW_*` constants `:178-196`; change `limitHorizonMs :232` and `limitGuard :272`), `host/src/shared/track/supervisor.ts:247` (its `limitHorizonMs` call), `host/src/mcp/tools.ts:105-149` (jog tool)
- Test: `host/test/control.test.ts`, `host/test/session.test.ts`, `host/test/tracking-sim.test.ts`, `host/test/session-aim-offset.test.ts`

**Interfaces:**
- `limitHorizonMs(rateDps: number, telemetryAgeMs: number, tickPeriodMs: number, amaxDps2: number): number` replaces the `maxJogDps` parameter: stopping time is `|rate| / amax` seconds plus the telemetry age and one tick period.
- `limitGuard(cmd: {panDps; tiltDps}, rigPanDeg, rigTiltDeg, limits, horizon)` keeps its signature and return.
- `TrackingSession` gains a `axisConfigProvider: () => Record<"pan"|"tilt", HeadAxisConfig> | null` constructor parameter (after `floorProvider`, default `() => null`); when null, the horizon uses `cfg.trackFallbackAmaxDps2` (new config key, default `10`, the Pico's current `amax`).
- The tracking tail: compute `aim`/`reach` as today; `guarded = limitGuard({panDps: aim.ratePanDps, tiltDps: aim.rateTiltDps}, …)`; for each axis, if blocked → include it in a `device.stop()` call once per block edge (not every tick) and record `commandedPanDps = 0`; otherwise send `device.track({pan: {pos: applySign(reach.pan, cfg.panSign), vel: applySign(aim.ratePanDps, cfg.panSign)}, tilt: …})`. `lastStatus.commandedPanDps/TiltDps` carry the sent feed-forward rates. The "device_busy" gate (`:455`) is deleted; `beginAcquire` still uses `moveToUserAngle` for the first slew.
- `stopMotion()` sends `device.stop()` (no jog vector to clear); `trackDeadmanMs`, `trackStaleTelemetryMs`, `trackReacquireDeg`, `trackLeadMs` keep their roles.
- `jog` tool (`tools.ts:105`): `limitGuard` as today with `horizon = {panMs: duration_ms, tiltMs: duration_ms}`; then `device.jog(guarded.out.panDps * cfg.panSign, guarded.out.tiltDps * cfg.tiltSign, duration_ms)`; the `aux` argument is removed from `jogArgsShape :38-44`; the reply reads `jogged for Nms (pan X°/s tilt Y°/s)`.

- [ ] **Step 1: Write the failing tests**

```ts
// control.test.ts: replace controlRate/slew/deflection/decelMs cases with
it("limitHorizonMs grows as amax shrinks", () => expect(limitHorizonMs(10, 0, 100, 5)).toBeGreaterThan(limitHorizonMs(10, 0, 100, 20)));
it("limitHorizonMs includes telemetry age and one tick", () => expect(limitHorizonMs(0, 200, 100, 10)).toBe(300));
// session.test.ts (replace jog-vector assertions)
it("tracking sends TRACK with reach setpoint and aim feedforward every tick", …)   // dev.tracks[0] deep-equals {pan:{pos,vel},tilt:{pos,vel}} with panSign applied
it("a blocked axis sends stop once and reports commanded 0 until unblocked", …)
it("no device_busy wait: a goto is issued while the head reports moving", …)
it("head estop puts the session in waiting with reason estop", …)
it("a tick without axes makes telemetry stale and the session waits", …)      // Review Focus 1
// tracking-sim.test.ts: drive FakeHead's model from the TRACK commands (pos += vel*dt toward tgt) and assert following error < 0.5° on the existing simulated pass
```

- [ ] **Step 2: Run to verify failure**

Run: `cd host && npx vitest run test/control.test.ts test/session.test.ts test/tracking-sim.test.ts test/session-aim-offset.test.ts`

- [ ] **Step 3: Implement** the changes in the Interfaces block; wire `axisConfigProvider` as `() => device.getAxisConfig()` in `src/mcp/server.ts:541`.

- [ ] **Step 4: Run the whole suite**

Run: `cd host && npm run build && npm test 2>&1 | tail -3`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A host && git commit -m "feat(host): tracking servoed by the head's TRACK; limit guard horizon from Pico amax; jog in dps"
```

---

### Task 6: MCP tools for the head; retired ESP32 tools

**Files:**
- Modify: `host/src/mcp/tools.ts` (delete `set_home :157-178`, `trigger_camera :180-190`, `list_programs :192-196`, `select_program :198-229`; add `home`, `set_position`, `reference_pan`, `estop`, `clear_estop`, `get_head_config`, `set_head_config`), `host/src/mcp/imu-tools.ts:182-237` (`set_north_zero` now calls `device.setPos({pan})` instead of `setHome`)
- Test: `host/test/tools.test.ts`, `host/test/imu-tools-north-zero.test.ts`

**Interfaces:**
- `home` `{ axes?: ("tilt")[] }` → `device.home(axes)`; refused while tracking or sun-locked (same guards as `goto_angle :82`); reply `homing tilt — watch get_status.axes.tilt.homed`.
- `set_position` `{ pan_deg?: number; tilt_deg?: number }` (user frame; signs applied) → `device.setPos`. Unlike the old `set_home`, it does NOT clear calibration or taught limits: the head emits `pan_reference` with the delta and Task 7 shifts them. Reply says so.
- `reference_pan` `{}` → `device.reference()`; reply `re-referencing pan from the IMU — result arrives as a pan_reference event (see get_status.pan_ref)`.
- `estop` `{}` → `session.stop(); supervisor` idle-park abort; `device.estop()`; reply `E-STOP latched; clear_estop to release`. `clear_estop` → `device.clearEstop()`.
- `get_head_config` → `GET /api/config` passthrough; `set_head_config` `{ scope: "pan"|"tilt"|"zoom"|"focus"|"global"; key: string; value: number; save?: boolean; force?: boolean }` → `POST /api/config` (`?force=1` when `force`), returns the head's reply or its 403 text.
- `stop` (`:151`) also clears any jog vector (already) and leaves the E-STOP latch alone.

- [ ] **Step 1: Write the failing tests** in `tools.test.ts`: one per new tool asserting the FakeHead call log (`calls` path and body) and the guard refusals; `set_position` must not touch `store.invalidateCalibration` or `limitsStore.clear` (spy); the four retired tools are absent from the registered tool list.

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the whole suite**: `cd host && npm run build && npm test 2>&1 | tail -3` → green.

- [ ] **Step 5: Commit**

```bash
git add -A host && git commit -m "feat(host): home/set_position/reference_pan/estop/head-config tools; ESP32 program and camera tools removed"
```

---

### Task 7: Pan reference changes and the unreferenced gate

**Files:**
- Modify: `host/src/shared/calibration.ts` (add `shiftPanZero(deltaDeg: number): void`), `host/src/shared/limits-store.ts` (add `shiftPan(deltaDeg)`), `host/src/shared/sector-store.ts` (add `shiftPan(deltaDeg)`), `host/src/mcp/server.ts` (wire `device.onReferenceChanged`), `host/src/shared/track/session.ts` (gate), `host/src/shared/track/supervisor.ts` (`idleParkAbortReason :313` and the sun-park entry), `host/src/mcp/track-tools.ts:37` (`start_tracking`), `host/src/mcp/adsb-tools.ts:260` (`track_aircraft`), `host/src/agent/loop.ts` and `host/src/agent/mcp-client.ts` (`getStatus` gains `panReferenced`)
- Test: `host/test/reference-shift.test.ts` (new), `host/test/session.test.ts`, `host/test/supervisor.test.ts`, `host/test/agent-loop.test.ts` (or the existing loop test file)

**Interfaces:**
- Spec amendment (recorded here, 6.8 rule 2): the "unreferenced" gate is a rig-state gate, not a policy predicate (policy predicates are per-aircraft). It lives in: `TrackingSession.tick()` → `wait("pan_unreferenced")` when `dev.ref.pan === "none"`; `SunSupervisor` → `idleParkAbortReason` returns `"pan_unreferenced"` and `driveParkTick` refuses to start a sun park (it still `stop()`s); `start_tracking`/`track_aircraft` return `errText("pan unreferenced — run reference_pan or set_position")`; the agent's `RigMcpClient.getStatus()` result gains `panReferenced: boolean` and `runOnce` returns `{kind: "keep"}` with reason `pan_unreferenced` when false.
- `WaitReason` (`session.ts:20`) gains `"pan_unreferenced"`.
- Shift on a known delta: `server.ts` subscribes `device.onReferenceChanged(({pan, previous}) => { if (pan != null && previous != null) { const d = wrapDeg180(pan - previous); store.shiftPanZero(d); limitsStore.shiftPan(d); sectorStore.shiftPan(d); } })`. `CalibrationStore.shiftPanZero(d)` rotates the solved orientation about the mount's pan axis by `-d` (so `boresightEnu(R, pan + d, tilt)` after equals `boresightEnu(R_old, pan, tilt)` before) and shifts every stored sighting's recorded pan by `+d`; `LimitsStore.shiftPan` and `SectorStore.shiftPan` add `d` to their pan edges with wrap. Aim trims are offsets and are left alone (spec 6.8 says "trims"; they are relative, so a shift is a no-op; note this in the code comment).
- `pan_reference` with `source: none`: no shift; the gates above engage via `ref.pan`.

- [ ] **Step 1: Write the failing tests**

```ts
// reference-shift.test.ts
it("shiftPanZero keeps the boresight fixed in ENU for the same physical pose", …)  // boresightEnu(R', p+d, t) ≈ boresightEnu(R, p, t) to 1e-9
it("sightings move with the zero and the fit residual is unchanged", …)
it("limits and sector edges shift with wrap", …)
it("server wires onReferenceChanged to the three stores", …)                        // FakeHead.emitEvent(pan_reference {pan:10, previous:0}) -> stores shifted by 10
// session.test.ts
it("ref.pan none mid-track stops motion and waits with pan_unreferenced; a jog still works", …)   // Review Focus 2
// supervisor.test.ts
it("idle park and sun park refuse while unreferenced", …)
// agent loop test
it("agent keeps when the rig is unreferenced", …)
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the whole suite**: green.

- [ ] **Step 5: Commit**

```bash
git add -A host && git commit -m "feat(host): shift calibration/limits/sector on pan re-reference; refuse automated motion while unreferenced"
```

---

### Task 8: Dashboard without systemctl; agent armed flag; head E-STOP

**Files:**
- Create: `host/src/shared/agent-store.ts` (`class AgentStore(file) { get(): {armed: boolean}; set(armed: boolean) }`, same JSON-file pattern as `floor-store.ts`)
- Modify: `host/src/mcp/tools.ts` (add `get_agent_armed`, `set_agent_armed {armed: boolean}`), `host/src/mcp/server.ts` (construct `AgentStore(join(cfg.stateDir, "agent.json"))`), `host/src/agent/loop.ts` and `mcp-client.ts` (`RigMcpClient.getAgentArmed(): Promise<boolean>`; `runOnce` returns `{kind:"keep"}` reason `disarmed` without calling the LLM when false), `host/src/dashboard/server.ts:29-30,164,244-246,566-567`, `host/src/dashboard/controls.ts:34-35,80-86,101-102`, `host/src/dashboard/state.ts:18,315`, `host/src/dashboard/client.ts` (add `getAgentArmed`/`setAgentArmed`/`estop`/`clearEstop` tool calls), rename `host/src/dashboard/rig.ts`→`head.ts` (`class HeadDirectClient(url, fetchFn)` with `state()`, `estop()`, `clearEstop()`), `host/dashboard/public/app.js` + `cockpit.js` + `estop.js` (Auto toggle → `set_agent_armed`; "Clear E-STOP" button; chips for `estop`, `pan unreferenced`, `pico link`, `imu`; battery chip removed)
- Delete: `host/src/dashboard/services.ts`, `host/test/dashboard-services.test.ts` (if present)
- Test: `host/test/agent-store.test.ts`, `host/test/tools.test.ts`, `host/test/dashboard-state.test.ts`, `host/test/dashboard-server.test.ts` (or `server.test.ts` for the dashboard), `host/test/cockpit.test.ts`, `host/test/estop.test.ts`

**Interfaces:**
- `ServicesState` (`state.ts:18`) becomes `{ mcp: "up"|"down"; agentArmed: boolean|null; mediamtx: "up"|"down"; adsb: "up"|"down"; head: "up"|"down" }`; `collect()` derives `mcp` from the MCP client reachability, `agentArmed` from `get_agent_armed`, `mediamtx` from `GET ${cameraMediamtxControlUrl}/v3/paths/list`, `adsb` from `GET adsbUrl` (2 s timeout), `head` from `HeadDirectClient.state()`.
- `mode` (`state.ts:315`) uses `services.agentArmed === true` where it used `tb3agent === "active"`.
- `ControlDeps`: `agentStop`→`setAgentArmed(false)`, `agentStart`→`setAgentArmed(true)` (MCP tool calls through `client.ts`); `firmwareStop`→`headEstop` (`HeadDirectClient.estop()`, direct to the head so it works with the MCP server down: Review Focus 3); new `clearEstop` action `POST /api/control/clear_estop` → `HeadDirectClient.clearEstop()` AND `client.clearEstop()` best-effort. `emergencyStop` order: `setAgentArmed(false)` (best effort, 1 s), `stopTracking` (best effort), `headEstop` (must succeed or the response is 502 with the error text).
- `DashboardState.rig` adds `estop: boolean`, `panRef`, `link`; the page shows them.

- [ ] **Step 1: Write the failing tests**: `AgentStore` round-trip; `set_agent_armed`/`get_agent_armed` tools; agent loop `disarmed` keep without an LLM call (spy on `choose`); `mergeState` mode from `agentArmed`; dashboard E-STOP route calls the head even when MCP throws (and reports 502 only when the head call fails); `clear_estop` route; cockpit renders the three new chips and no battery (DOM test as the existing cockpit tests do).

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement** (delete `services.ts`; `grep -rn "systemctl\|RealSystemctl\|tb3-agent" src test` must return nothing).

- [ ] **Step 4: Run the whole suite**: green.

- [ ] **Step 5: Commit**

```bash
git add -A host && git commit -m "feat(host): agent armed flag replaces systemctl; dashboard E-STOP latches the head directly; head status chips"
```

---

### Task 9: LLM client for Ollama Cloud

**Files:**
- Modify: `host/src/agent/llm.ts:93-116`, `host/src/agent/agent.ts:21`
- Test: `host/test/llm.test.ts` (extend or create)

**Interfaces:**
- `chooseTarget(llmUrl, model, input, fetchFn = fetch, timeoutMs = 10000, apiKey?: string)`; when `apiKey` is set the request carries `authorization: Bearer <apiKey>`. `agent.ts` passes `cfg.llmApiKey`.
- Response handling: keep `response_format`; if `content` is not valid JSON, try to extract the first `{…}` block (Ollama Cloud models sometimes wrap JSON in prose or fences); if that fails throw as today so `failSafeAction` (`loop.ts:83`) applies.
- The key must never be logged: `agent.ts:11` prints the URL and model only.

- [ ] **Step 1: Write the failing tests**: bearer header present iff `apiKey`; fenced ```` ```json {…} ``` ```` reply parses; prose-only reply throws; `runOnce` turns that throw into keep (existing behaviour, assert it still holds); the startup log line does not contain the key.

- [ ] **Step 2: Run to verify failure** → **Step 3: Implement** → **Step 4: Whole suite green**

- [ ] **Step 5: Commit**

```bash
git add -A host && git commit -m "feat(agent): bearer auth and tolerant JSON extraction for Ollama Cloud"
```

---

### Task 10: VAAPI camera encoding

**Files:**
- Modify: `host/src/dashboard/camera/rtsp.ts:6-13,43-92`, `host/src/dashboard/camera/encoder-check.ts:60`
- Test: `host/test/camera-rtsp.test.ts` (or the existing rtsp args test)

**Interfaces:**
- `encoderName`: `"vaapi"` → `"h264_vaapi"`.
- `ffmpegRtspArgs` for vaapi: pre-input `-vaapi_device /dev/dri/renderD128` (new config key `cameraVaapiDevice`, env `TB3_CAMERA_VAAPI_DEVICE`, default `/dev/dri/renderD128`); after input `-vf format=nv12,hwupload`; encoder args `-c:v h264_vaapi -rc_mode CQP -qp 23 -bf 0` plus the existing keyframe args; everything else (input args, rtsp output) shared with the other branches.
- `assertEncoderAvailable` treats `h264_vaapi` like the others (must be in the probed set).

- [ ] **Step 1: Write the failing tests**: args for `cameraEncoder: "vaapi"` contain the five tokens above in order; `nvenc`/`x264`/`copy` args unchanged (snapshot the existing expectations).

- [ ] **Step 2: Run to verify failure** → **Step 3: Implement** → **Step 4: Whole suite green**

- [ ] **Step 5: Commit**

```bash
git add -A host && git commit -m "feat(dashboard): h264_vaapi camera encoder (default) for the Intel host"
```

---

### Task 11: Images and compose

**Files:**
- Create: `host/Dockerfile`, `host/.dockerignore`, `host/mediamtx/mediamtx.yml` (from the old `deploy/mediamtx.yml` with `recordPath: /recordings/%path/%Y-%m-%d_%H-%M-%S-%f`), `compose.yaml`, `.env.example`, `.gitignore` (`.env`, `host/config.json`, `head/data/`)
- Test: `host/test/compose.test.ts` (shells `docker compose config` and asserts on the rendered YAML)

**Interfaces:**
- `host/Dockerfile`: stage `build` from `node:22-bookworm-slim`: `npm ci`, copy `src tsconfig*.json dashboard`, `npm run build`, `npm prune --omit=dev`. Stage `runtime` from `node:22-bookworm-slim`: `apt-get install -y --no-install-recommends ffmpeg intel-media-va-driver-non-free libva-drm2 vainfo` (enable `non-free` in `sources.list.d`), copy `dist`, `node_modules`, `package.json`, `dashboard/public`; `ENV NODE_ENV=production TB3_CONFIG=/config/config.json`; `USER node`; no `CMD` (compose sets the command per service).
- `compose.yaml` services (all `network_mode: host`, `restart: unless-stopped`, `env_file: .env`):
  - `mcp`: `build: ./host`, `image: plainsight-host`, `command: ["node", "dist/mcp/server.js"]`, volumes `${PLAINSIGHT_DATA}/config:/config:ro`, `${PLAINSIGHT_DATA}/state:/data/state`, `${PLAINSIGHT_DATA}/snapshots:/data/snapshots`, `${PLAINSIGHT_DATA}/recordings:/recordings:ro`; `healthcheck: curl -fs http://127.0.0.1:${TB3_MCP_PORT:-8770}/healthz` (add a `/healthz` route to `src/mcp/server.ts` `buildApp` if absent: returns `{ok:true}`).
  - `agent`: same image, `command: ["node", "dist/agent/agent.js"]`, config volume, `depends_on: mcp: condition: service_healthy`.
  - `dashboard`: same image, `command: ["node", "dist/dashboard/server.js"]`, config + state + recordings volumes, `devices: ["${CAMERA_DEVICE}:${CAMERA_DEVICE}", "/dev/dri/renderD128:/dev/dri/renderD128"]`, `group_add: ["${VIDEO_GID:-44}", "${RENDER_GID:-989}"]`, `depends_on: [mcp, mediamtx]`.
  - `mediamtx`: `image: bluenviron/mediamtx:1.19.3`, volumes `./host/mediamtx/mediamtx.yml:/mediamtx.yml:ro`, `${PLAINSIGHT_DATA}/recordings:/recordings`.
  - `adsb`: the ultrafeeder definition from spec 6.12 (image `ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder:telegraf`, `device_cgroup_rules: [c 189:* rwm]`, `/dev/bus/usb` bind, tmpfs as before, volumes under `${PLAINSIGHT_DATA}/adsb/`, `profiles: [adsb]`, `ULTRAFEEDER_CONFIG` copied verbatim, `INFLUXDBV2_URL=${INFLUX_URL:-}`).
  - `detector`: `profiles: [vision]`, `image: plainsight-detector`, `build: ./services/detector` commented out with a pointer to `TB3-ESP32/services/detector`.
- `.env.example`: `PLAINSIGHT_DATA=/srv/plainsight`, `COMPOSE_PROFILES=adsb`, `TB3_HEAD_URL=http://192.168.4.96:8780`, `CAMERA_DEVICE=/dev/v4l/by-id/CHANGE-ME-video-index0`, `VIDEO_GID=44`, `RENDER_GID=989`, `TB3_ADSB_URL=http://127.0.0.1:8088/data/aircraft.json`, `TB3_LLM_URL=https://ollama.com/v1/chat/completions`, `TB3_LLM_MODEL=gpt-oss:120b`, `TB3_LLM_API_KEY=` (comment: `op read "op://<vault>/<your-1password-item-id>/credential"`), `TB3_DASHBOARD_AUTH=false`, `TB3_MCP_TOKEN=`, and the `FEEDER_*`/`ADSB_SDR_*`/`MULTIFEEDER_UUID`/`FEEDER_HEYWHATSTHAT_*` keys with the .11 values (PPM left blank with the comment from spec 6.12), `INFLUX_URL=http://192.168.4.11:8181`, `INFLUX_TOKEN=`, `INFLUX_BUCKET=adsb`.

- [ ] **Step 1: Write the failing test**: `docker compose --env-file .env.example config --format json` parses; services `mcp agent dashboard mediamtx adsb detector` exist; `mcp.network_mode === "host"`; `adsb.profiles` includes `adsb`; `detector.profiles` includes `vision`; every `plainsight-host` service mounts `/config`.

- [ ] **Step 2: Run to verify failure** → **Step 3: Write the files.**

- [ ] **Step 4: Verify**

Run: `cd host && npm test 2>&1 | tail -3 && cd .. && docker compose --env-file .env.example config >/dev/null && docker build -t plainsight-host:check host && docker run --rm plainsight-host:check ffmpeg -hide_banner -encoders | grep -c h264_vaapi`
Expected: green; config ok; image builds; prints `1`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: host image and compose stack (mcp, agent, dashboard, mediamtx, adsb profile, detector slot)"
```

---

### Task 12: Docs and deployment to the application host

**Files:**
- Create: `docs/DEPLOY.md`, `README.md`; extend `docs/BRING-UP.md` with spec section 8 steps 5 to 8
- Modify: `.env.example` (anything learned during deploy)

**Interfaces:**
- `docs/DEPLOY.md` sections: Prerequisites (Docker on both machines, DHCP reservations for .92 and .96, `/srv/plainsight` tree creation `sudo mkdir -p /srv/plainsight/{config,state,recordings,snapshots,adsb} && sudo chown -R 1000:1000 /srv/plainsight`), Head (`head/` compose), Host (`.env` from 1Password: `op read … > ` the `TB3_LLM_API_KEY` line; `config.json` from `host/config.example.json` into `/srv/plainsight/config/`; `docker compose up -d --build`), Verification (`curl :8770/healthz`, `:8788`, `:8088`, head `/healthz`), Updating (`git pull && docker compose up -d --build`), Logs (`docker compose logs -f <service>`), Troubleshooting (VAAPI check `docker compose exec dashboard vainfo`; camera by-id; dongle serial `rtl_test`; PPM).
- `README.md`: the two-machine picture from spec section 3, the repo layout, links to the three docs and the spec.

- [ ] **Step 1: Write the docs.**

- [ ] **Step 2: Deploy** (the owner has plugged the dongle and the camera into .92; Docker is already there)

Run: `rsync -a --exclude node_modules --exclude .git ./ atomist@192.168.4.92:~/plainsight-tracker/ && ssh atomist@192.168.4.92 'cd ~/plainsight-tracker && cp -n .env.example .env && docker compose up -d --build'`
Then fill `.env` on the host (camera by-id path from `ls -l /dev/v4l/by-id/`, LLM key via `op`), restart.
Expected: `docker compose ps` shows mcp, agent, dashboard, mediamtx, adsb up.

- [ ] **Step 3: Verify**

Run on the host: `curl -s localhost:8770/healthz; curl -s localhost:8088/data/aircraft.json | head -c 200; curl -s localhost:8788/api/state | head -c 400; docker compose logs dashboard --tail 20 | grep -i "camera"`
Expected: `{"ok":true}`; aircraft JSON with a non-empty `aircraft` array; dashboard state with `rig.connected: true` and `rig.panRef`; a camera line naming `vaapi` with no encoder error. Open `http://192.168.4.92:8788` and confirm telemetry, joystick jog, E-STOP latch and clear, tar1090 at `:8088`.

- [ ] **Step 4: Record results in `docs/BRING-UP.md` and commit**

```bash
git add -A && git commit -m "docs: deploy guide, README, host bring-up results"
```
