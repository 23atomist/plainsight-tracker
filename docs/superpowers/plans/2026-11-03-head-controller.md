# Head Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `head/`, the Python service on the Orange Pi Zero 2W that owns the SKR Pico over serial and the BNO055 over I2C and exposes the head API (spec section 4) on port 8780.

**Architecture:** One asyncio process. A threaded pyserial reader feeds Pico status/event lines into the event loop; an IMU task samples the BNO055 at 20 Hz; a `HeadState` object merges both into the tick JSON and fans it out to WebSocket clients; aiohttp routes translate HTTP commands into Pico protocol lines with the head-level guards (E-STOP latch, jog dead-man, link checks, config guard) applied first; a `PanReference` component implements the boot/restore/IMU-north rules and persists to `/data`.

**Tech Stack:** Python 3.13, aiohttp, pyserial, jsonschema (tests), pytest, pytest-asyncio. Container `python:3.13-slim` on arm64.

**Spec:** `docs/superpowers/specs/2026-11-03-plainsight-tracker-design.md` (sections 4, 5, 8; also 6.12 for nothing, it is host-side).

## Global Constraints

- Python 3.13; runtime dependencies are exactly `aiohttp` and `pyserial`. Test-only: `pytest`, `pytest-asyncio`, `jsonschema`.
- Angles in degrees, rates in degrees per second, everywhere in the API. The head never re-wraps or re-signs Pico positions (spec 4.1).
- Ticks are published only when a real Pico status line arrives; no timer-synthesized motion ticks (spec 4.2). The only timer-driven tick is the 2 Hz IMU-only tick while the Pico link is down, and it carries no `axes` key.
- The head never moves pan on its own. The only sanctioned boot motion is `HOME tilt` when `HEAD_AUTO_HOME=1`, and `MOVE tilt <HEAD_REF_TILT_DEG>` inside an IMU north reference (spec 5.3 rule 3).
- Motion routes return 423 while the E-STOP latch is set and 503 while the Pico link is down (spec 4.3).
- All config via `HEAD_*` environment variables with the defaults in spec 5.5 plus: `HEAD_BAUD=115200`, `HEAD_TRACK_TIMEOUT_MS=1000`, `HEAD_STREAM_MS=100`, `HEAD_DATA_DIR=/data`, `HEAD_IMU_TILT_AXIS=pitch` (`pitch|roll`), `HEAD_IMU_TILT_SIGN=1`.
- Persistence is exactly two files under `HEAD_DATA_DIR`: `pan-reference.json` and `bno055-offsets.json` (spec 5.4). Writes are atomic (temp file + rename).
- Nothing in `head/` imports from `plainsight/host/`; the needed code is copied in (the BNO055 register driver and the axes-argument formatter) with a comment naming its origin.
- Commit after every task with a conventional-commit message. Tests run with `cd head && python -m pytest -q`.

## Review Focus

1. A Pico `err` reply to `SETPOS` while the axis is moving must surface as HTTP 409, not 400, and must not be sent at all when the head already sees the axis moving (test in Task 8).
2. A WebSocket client that stops reading must not stall tick fan-out to the other clients or to the serial reader: per-client bounded queue, drop oldest (test in Task 8).
3. A truncated or garbled status line (`S pos=1.0,2.0 vel=` or non-UTF-8 bytes) must be logged and skipped; the reader thread keeps running and the next good line produces a tick (test in Task 2 and Task 3).
4. `POST /api/track` with `NaN`, `Infinity`, a string, or an unknown axis must return 400 and send nothing to the Pico (test in Task 8).
5. The uncalibrated BNO055 reports heading exactly `360.0`; heading math must treat 360 as 0, and the circular mean of `[359, 1]` must be `0`, not `180` (test in Task 7).

---

## File structure

```
head/
  pyproject.toml                   package metadata, deps, pytest config (asyncio_mode = auto)
  Dockerfile
  compose.yaml
  .env.example
  plainsight_head/
    __init__.py                    __version__ = "0.1.0"
    config.py                      HeadConfig dataclass, from_env()
    protocol.py                    pure functions: parse/format Pico protocol lines
    pico.py                        PicoLink: serial transport, command/reply, async line routing, link supervision
    imu.py                         BNO055 register driver + ImuSample + ImuReader task
    persist.py                     JsonStore: atomic JSON files under the data dir
    state.py                       HeadState: merges Pico/IMU/ref/estop/link into the tick, subscribers
    deadman.py                     JogDeadman
    reference.py                   PanReference: boot restore and IMU north rules
    api.py                         aiohttp Application: routes and WebSocket fan-out
    main.py                        wiring, startup sequence, shutdown, `python -m plainsight_head`
    __main__.py                    calls main.main()
  tools/
    track_bench.py                 bring-up step 3: synthetic target over POST /api/track
  tests/
    fakes.py                       FakeSerial (scripted Pico), FakeBNO055, FakeClock
    test_config.py test_protocol.py test_pico.py test_imu.py test_persist.py
    test_state.py test_deadman.py test_reference.py test_api.py test_main.py test_contract.py
docs/
  HEAD-API.md                      the API reference (spec section 4 as a document)
  head-api/schemas/                tick.json event.json goto.json track.json jog.json setpos.json config-set.json
```

---

### Task 1: Package scaffold and configuration

**Files:**
- Create: `head/pyproject.toml`, `head/plainsight_head/__init__.py`, `head/plainsight_head/__main__.py`, `head/plainsight_head/config.py`
- Test: `head/tests/test_config.py`

**Interfaces:**
- Produces: `@dataclass(frozen=True) HeadConfig` with fields (name: type = default): `port: int = 8780`, `serial: str = "/dev/ttyACM0"`, `baud: int = 115200`, `i2c_bus: int | None = None`, `imu_address: int | None = None`, `auto_home: bool = True`, `pan_restore: str = "persisted"` (one of `persisted|imu|none`), `pan_restore_max_age_s: float = 604800`, `ref_tilt_deg: float = 0.0`, `ref_timeout_s: float = 120`, `imu_heading_offset_deg: float = 0.0`, `imu_pitch_offset_deg: float = 0.0`, `imu_tilt_axis: str = "pitch"`, `imu_tilt_sign: int = 1`, `jog_deadman_ms: int = 500`, `track_timeout_ms: int = 1000`, `stream_ms: int = 100`, `data_dir: str = "/data"`, `log_level: str = "INFO"`.
- Produces: `HeadConfig.from_env(env: Mapping[str, str]) -> HeadConfig`; raises `ValueError` naming the key on a bad value (non-numeric, `pan_restore` outside the three values, `imu_tilt_axis` outside `pitch|roll`, `imu_tilt_sign` not ±1). Booleans accept `1/0/true/false/yes/no`.

- [ ] **Step 1: Write the failing tests**

```python
# head/tests/test_config.py
from plainsight_head.config import HeadConfig
import pytest

def test_defaults_match_spec():
    c = HeadConfig.from_env({})
    assert (c.port, c.serial, c.auto_home, c.pan_restore) == (8780, "/dev/ttyACM0", True, "persisted")
    assert (c.jog_deadman_ms, c.track_timeout_ms, c.stream_ms, c.data_dir) == (500, 1000, 100, "/data")
    assert (c.ref_timeout_s, c.pan_restore_max_age_s, c.imu_tilt_axis, c.imu_tilt_sign) == (120, 604800, "pitch", 1)

def test_env_overrides_and_bool_parsing():
    c = HeadConfig.from_env({"HEAD_PORT": "9000", "HEAD_AUTO_HOME": "no", "HEAD_PAN_RESTORE": "imu", "HEAD_I2C_BUS": "3"})
    assert (c.port, c.auto_home, c.pan_restore, c.i2c_bus) == (9000, False, "imu", 3)

@pytest.mark.parametrize("key,val", [("HEAD_PORT", "x"), ("HEAD_PAN_RESTORE", "maybe"), ("HEAD_IMU_TILT_AXIS", "yaw"), ("HEAD_IMU_TILT_SIGN", "2")])
def test_bad_values_name_the_key(key, val):
    with pytest.raises(ValueError, match=key):
        HeadConfig.from_env({key: val})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_config.py -q`
Expected: FAIL, `ModuleNotFoundError: plainsight_head`

- [ ] **Step 3: Create `pyproject.toml`** with `[project] name = "plainsight-head"`, `requires-python = ">=3.13"`, `dependencies = ["aiohttp>=3.10", "pyserial>=3.5"]`, `[project.optional-dependencies] test = ["pytest", "pytest-asyncio", "jsonschema"]`, `[tool.pytest.ini_options] asyncio_mode = "auto"`, `testpaths = ["tests"]`, and `[project.scripts] plainsight-head = "plainsight_head.main:main"`. Install editable: `pip install -e ".[test]"` (use the asdf-managed Python per the user's global rules).

- [ ] **Step 4: Implement `config.py`** with `HeadConfig` and `from_env` as specified; `__init__.py` with `__version__ = "0.1.0"`; `__main__.py` with `from .main import main; main()` (main.py arrives in Task 9; leave the import inside a function so the package imports cleanly until then).

- [ ] **Step 5: Run to verify pass**

Run: `cd head && python -m pytest tests/test_config.py -q`
Expected: 3 passed (parametrized counts as 4 cases; 6 total)

- [ ] **Step 6: Commit**

```bash
git add head/pyproject.toml head/plainsight_head head/tests/test_config.py
git commit -m "feat(head): package scaffold and HEAD_* configuration"
```

---

### Task 2: Pico protocol parsing and formatting

**Files:**
- Create: `head/plainsight_head/protocol.py`
- Test: `head/tests/test_protocol.py`

**Interfaces:**
- Produces: `AXES: tuple[str, ...] = ("pan", "tilt", "zoom", "focus")`
- Produces: `@dataclass(frozen=True) AxisStatus(pos: float, vel: float, tgt: float, mode: str, homed: bool, endstop: bool, driver: bool)`
- Produces: `@dataclass(frozen=True) PicoStatus(axes: dict[str, AxisStatus], enabled: bool)` with property `moving: bool` (any `vel != 0` or any `mode == "H"`).
- Produces: `@dataclass(frozen=True) PicoEvent(name: str, axis: str | None, detail: str | None)`
- Produces: `class ProtocolError(ValueError)`
- Produces: `parse_status(payload: str) -> PicoStatus` where payload is the text after the `S ` / `*S ` prefix; raises `ProtocolError` on a missing key or a wrong field count.
- Produces: `parse_event(payload: str) -> PicoEvent` (text after `*E `): first token is `name`; second token is `axis` if it is in `AXES`; the rest joined with spaces is `detail` or `None`.
- Produces: `parse_cfg_lines(lines: list[str]) -> dict[str, dict[str, float]]` from `C <scope> <key> <value>` lines.
- Produces: `parse_drv_lines(lines: list[str]) -> dict[str, dict[str, str]]` from `D <axis> k=v k=v …` lines (values kept as strings).
- Produces: `fmt_axes(values: Mapping[str, float | tuple[float, float]]) -> str` (copied from `plainsight/host/ptz.py::_axes_args`): `pan 1.00000 tilt 2.00000 3.00000`; raises `ProtocolError` on an unknown axis, an empty mapping, or a non-finite number.
- Produces: `classify_line(line: str) -> tuple[str, str]` returning `("status", payload)` for `*S `, `("event", payload)` for `*E `, `("reply", line)` otherwise.

- [ ] **Step 1: Write the failing tests**

```python
# head/tests/test_protocol.py
import math, pytest
from plainsight_head.protocol import *

STATUS = "pos=12.0000,30.0000,0.0000,0.0000 vel=0.0000,0.0000,0.0000,0.0000 tgt=12.0000,30.0000,0.0000,0.0000 mode=PPII homed=1100 es=0000 en=1 drv=1111"

def test_parse_status_fields():
    st = parse_status(STATUS)
    assert st.axes["pan"] == AxisStatus(12.0, 0.0, 12.0, "P", True, False, True)
    assert st.axes["zoom"].mode == "I" and st.axes["zoom"].homed is False
    assert st.enabled is True and st.moving is False

def test_moving_when_velocity_or_homing():
    assert parse_status(STATUS.replace("vel=0.0000,", "vel=1.5000,")).moving
    assert parse_status(STATUS.replace("mode=PPII", "mode=PHII")).moving

@pytest.mark.parametrize("bad", ["pos=1.0,2.0 vel=", "pos=1,2,3 vel=0,0,0,0 tgt=0,0,0,0 mode=IIII homed=0000 es=0000 en=1 drv=1111", ""])
def test_parse_status_rejects_truncated(bad):
    with pytest.raises(ProtocolError):
        parse_status(bad)

def test_parse_event_forms():
    assert parse_event("homed tilt") == PicoEvent("homed", "tilt", None)
    assert parse_event("driver_fault pan drv_status=0x40") == PicoEvent("driver_fault", "pan", "drv_status=0x40")
    assert parse_event("track_timeout pan") == PicoEvent("track_timeout", "pan", None)

def test_parse_cfg_and_drv():
    assert parse_cfg_lines(["C pan gear 6.44", "C global track_timeout_ms 3000"]) == {"pan": {"gear": 6.44}, "global": {"track_timeout_ms": 3000.0}}
    assert parse_drv_lines(["D pan socket=Z online=1 version=0x21"])["pan"] == {"socket": "Z", "online": "1", "version": "0x21"}

def test_fmt_axes():
    assert fmt_axes({"pan": 1, "tilt": (2, 3)}) == "pan 1.00000 tilt 2.00000 3.00000"
    for bad in ({}, {"yaw": 1}, {"pan": math.nan}, {"pan": math.inf}):
        with pytest.raises(ProtocolError):
            fmt_axes(bad)

def test_classify_line():
    assert classify_line("*S pos=1")[0] == "status"
    assert classify_line("*E homed tilt") == ("event", "homed tilt")
    assert classify_line("ok") == ("reply", "ok")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_protocol.py -q`
Expected: FAIL, `ImportError`

- [ ] **Step 3: Implement `protocol.py`** per the Interfaces block. `parse_status` splits on whitespace into `k=v`, requires keys `pos vel tgt mode homed es en drv`, requires exactly 4 comma fields / 4 characters per axis key.

- [ ] **Step 4: Run to verify pass**

Run: `cd head && python -m pytest tests/test_protocol.py -q`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add head/plainsight_head/protocol.py head/tests/test_protocol.py
git commit -m "feat(head): Pico protocol parsing and formatting"
```

---

### Task 3: Fake Pico and the serial link

**Files:**
- Create: `head/tests/fakes.py`, `head/plainsight_head/pico.py`
- Test: `head/tests/test_pico.py`

**Interfaces:**
- Consumes: Task 2 (`parse_status`, `parse_event`, `classify_line`, `PicoStatus`, `PicoEvent`).
- Produces (fakes): `class FakeSerial` implementing the subset of `serial.Serial` that `PicoLink` uses: `read(n) -> bytes` (blocks up to `timeout`), `write(b) -> int`, `reset_input_buffer()`, `close()`, `is_open`. It is a scripted Pico: it answers `VER` with `V plainsight-ptz 0.1.0`, `STATUS` with one `S …` line, `CFG` with a configurable dict rendered as `C` lines, `DRV` with one `D` line per axis, `MOVE/MOVER/TRACK/JOG/STOP/ESTOP/HOME/SETPOS/ENABLE/SAVE/STREAM` with `ok` (updating an internal `pos`/`tgt`/`mode`/`homed`/`vel` model: `MOVE` sets `tgt` and mode `P`, `JOG` sets `vel` and mode `V`, `STOP` zeroes `vel`, `SETPOS` sets `pos`+`homed`, `ENABLE 0` clears `homed`, `HOME <ax>` sets mode `H` and after `home_ticks` emitted status lines emits `*E homed <ax>` and sets `pos=home_pos`, `homed`), and anything unknown with `err unknown command`. Public knobs: `model: dict[str, dict]` (per-axis `pos/vel/tgt/mode/homed/endstop/driver` plus `enabled`, readable and writable by tests), `home_ticks: int = 2`, `sent: list[str]` (every command line received), `emit_status()` (push one `*S` line reflecting the model), `emit_raw(bytes)`, `fail_next_reads(n)` (raise `OSError` on the next n reads, to simulate link loss), `reply_override: dict[str, str]` (force e.g. `SETPOS` to answer `err axis moving`).
- Produces (fakes): `class FakeClock` with `now() -> float`, `advance(s)`, usable as `time_fn` injection.
- Produces: `class PicoError(Exception)` with attribute `reason: str` (the text after `err `), and `class PicoTimeout(PicoError)`.
- Produces: `class PicoLink` with `__init__(self, port: str, baud: int, *, on_status: Callable[[PicoStatus], None], on_event: Callable[[PicoEvent], None], on_link: Callable[[bool], None], on_reconnect: Callable[[], Awaitable[None]] | None = None, serial_factory: Callable[[str, int], Any] = _pyserial_factory, stale_s: float = 2.0, reconnect_s: float = 1.0)`; `async start() -> None` (opens, starts the reader thread and the supervisor task); `async close() -> None`; `connected: bool`; `async command(line: str, timeout_s: float = 2.0) -> list[str]` (serialised by an `asyncio.Lock`; returns data lines; raises `PicoError(reason)` on `err`, `PicoTimeout` on no terminal line in time, `PicoError("link down")` when not connected).
- Behaviour: the reader thread splits on `\n`, decodes with `errors="replace"`, strips, calls `classify_line`; status/event payloads go through the parsers and on failure are logged at WARNING and dropped; replies go to an `asyncio.Queue` via `loop.call_soon_threadsafe`. The supervisor marks the link down (`on_link(False)`) when `stale_s` pass without a status line while a stream is expected (`expect_stream: bool`, set by the caller after `STREAM`), or when the reader thread dies on `OSError`; it then retries `serial_factory` every `reconnect_s`, and on success calls `on_link(True)` then `await on_reconnect()`.

- [ ] **Step 1: Write the failing tests**

```python
# head/tests/test_pico.py
import asyncio, pytest
from plainsight_head.pico import PicoLink, PicoError, PicoTimeout
from tests.fakes import FakeSerial

async def make_link(fake, **kw):
    seen = {"status": [], "events": [], "link": []}
    link = PicoLink("/dev/fake", 115200, on_status=seen["status"].append, on_event=seen["events"].append,
                    on_link=seen["link"].append, serial_factory=lambda p, b: fake, **kw)
    await link.start()
    return link, seen

async def test_command_returns_data_lines_and_ok():
    fake = FakeSerial(); link, _ = await make_link(fake)
    assert await link.command("VER") == ["V plainsight-ptz 0.1.0"]
    assert fake.sent[-1] == "VER"
    await link.close()

async def test_err_reply_raises_with_reason():
    fake = FakeSerial(); link, _ = await make_link(fake)
    with pytest.raises(PicoError) as e:
        await link.command("BOGUS")
    assert e.value.reason == "unknown command"
    await link.close()

async def test_timeout_when_no_terminal_line():
    fake = FakeSerial(); fake.reply_override["VER"] = ""   # swallow
    link, _ = await make_link(fake)
    with pytest.raises(PicoTimeout):
        await link.command("VER", timeout_s=0.2)
    await link.close()

async def test_async_lines_route_to_callbacks_not_replies():
    fake = FakeSerial(); link, seen = await make_link(fake)
    fake.emit_status(); fake.emit_raw(b"*E homed tilt\n")
    await asyncio.sleep(0.05)
    assert len(seen["status"]) == 1 and seen["events"][0].name == "homed"
    assert await link.command("VER") == ["V plainsight-ptz 0.1.0"]   # queue not polluted
    await link.close()

async def test_garbled_lines_are_skipped_and_reader_survives():
    fake = FakeSerial(); link, seen = await make_link(fake)
    fake.emit_raw(b"*S pos=1.0,2.0 vel=\n\xff\xfe garbage\n"); fake.emit_status()
    await asyncio.sleep(0.05)
    assert len(seen["status"]) == 1
    await link.close()

async def test_link_loss_and_reconnect():
    fake = FakeSerial(); reconnected = []
    async def on_reconnect(): reconnected.append(1)
    link, seen = await make_link(fake, stale_s=0.1, reconnect_s=0.05, on_reconnect=on_reconnect)
    link.expect_stream = True
    await asyncio.sleep(0.3)                      # no status lines -> stale
    assert seen["link"][-1] is False and link.connected is False
    with pytest.raises(PicoError): await link.command("VER")
    fake.emit_status(); await asyncio.sleep(0.2)  # factory returns the same fake; it reconnects
    assert seen["link"][-1] is True and reconnected == [1]
    await link.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_pico.py -q`
Expected: FAIL, `ImportError`

- [ ] **Step 3: Implement `tests/fakes.py` (`FakeSerial`, `FakeClock`) and `pico.py`** per the Interfaces block. `FakeSerial.read` must honour a short timeout so the reader thread loop can observe `close()`.

- [ ] **Step 4: Run to verify pass**

Run: `cd head && python -m pytest tests/test_pico.py -q`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add head/plainsight_head/pico.py head/tests/fakes.py head/tests/test_pico.py
git commit -m "feat(head): PicoLink serial transport with link supervision, plus the scripted fake Pico"
```

---

### Task 4: BNO055 driver and IMU reader

**Files:**
- Create: `head/plainsight_head/imu.py`
- Modify: `head/tests/fakes.py` (add `FakeBNO055`)
- Test: `head/tests/test_imu.py`

**Interfaces:**
- Produces: `@dataclass(frozen=True) ImuSample(t: float, heading: float, roll: float, pitch: float, quat: tuple[float, float, float, float], gravity: tuple[float, float, float], linacc: tuple[float, float, float], cal: tuple[int, int, int, int], temp_c: int)`. `heading` is normalised to `[0, 360)` (360.0 becomes 0.0).
- Produces: `class BNO055` copied from `plainsight/host/imu.py` (same register constants, `find_bus`, `_probe`, `_begin`, `euler`, `quaternion`, `calibration`, `temperature`, `status`, `get_offsets`, `set_offsets`), minus the file-based `cal_file` logic, plus `read_sample(now: float) -> ImuSample` doing one 28-byte read from `EUL_DATA` (0x1A) covering EUL(6) QUA(8) LIA(6) GRV(6) TEMP(1) CALIB_STAT(1). Scale: euler /16, quat /16384, LIA and GRV /100 (m/s²).
- Produces: `class FakeBNO055` with the same public methods, settable `heading/roll/pitch/cal/quat/gravity/linacc/temp`, `fail_next(n)` (raise `OSError`), and `offsets: bytes` written by `set_offsets`.
- Produces: `class ImuReader` with `__init__(self, open_fn: Callable[[], BNO055-like], *, rate_hz: float = 20, on_fully_calibrated: Callable[[bytes], None] | None = None, on_link: Callable[[bool], None] | None = None, time_fn=time.monotonic)`; `async start()`, `async close()`; `latest: ImuSample | None`; `ok: bool`; `async burst(n: int) -> list[ImuSample]` (reads `n` samples back-to-back, max 1000, independent of the 20 Hz task); `load_offsets(data: bytes) -> None`. On `OSError` from the sensor: `ok=False`, `on_link(False)`, reopen via `open_fn` every 1 s, `on_link(True)` on success. `on_fully_calibrated` fires once per session the first time `cal == (3,3,3,3)`, with `get_offsets()`.

- [ ] **Step 1: Write the failing tests**

```python
# head/tests/test_imu.py
import asyncio, struct
from plainsight_head.imu import ImuSample, ImuReader, BNO055
from tests.fakes import FakeBNO055

def test_read_sample_decodes_register_block(monkeypatch):
    raw = struct.pack("<hhh", 360*16, 1*16, -2*16) + struct.pack("<hhhh", 16384, 0, 0, 0) \
        + struct.pack("<hhh", 0, 0, 100) + struct.pack("<hhh", 0, 0, 981) + bytes([28, 0b11_10_01_00])
    dev = BNO055.__new__(BNO055); monkeypatch.setattr(dev, "read", lambda reg, n=1: raw)
    s = dev.read_sample(now=5.0)
    assert (s.heading, s.roll, s.pitch) == (0.0, 1.0, -2.0)       # 360 -> 0
    assert s.quat == (1.0, 0.0, 0.0, 0.0) and s.gravity == (0.0, 0.0, 9.81) and s.linacc == (0.0, 0.0, 1.0)
    assert s.cal == (3, 2, 1, 0) and s.temp_c == 28

async def test_reader_publishes_latest_and_burst():
    fake = FakeBNO055(heading=90.0); r = ImuReader(lambda: fake, rate_hz=200)
    await r.start(); await asyncio.sleep(0.05)
    assert r.ok and r.latest.heading == 90.0
    assert len(await r.burst(50)) == 50
    await r.close()

async def test_fully_calibrated_callback_fires_once():
    fake = FakeBNO055(cal=(3, 3, 3, 3)); got = []
    r = ImuReader(lambda: fake, rate_hz=200, on_fully_calibrated=got.append)
    await r.start(); await asyncio.sleep(0.05); await r.close()
    assert got == [fake.get_offsets()]

async def test_link_loss_and_recovery():
    fake = FakeBNO055(); links = []
    r = ImuReader(lambda: fake, rate_hz=200, on_link=links.append)
    await r.start(); fake.fail_next(3); await asyncio.sleep(0.05)
    assert r.ok is False and links[-1] is False
    await asyncio.sleep(1.2)
    assert r.ok is True and links[-1] is True
    await r.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_imu.py -q`
Expected: FAIL, `ImportError`

- [ ] **Step 3: Implement `imu.py` and `FakeBNO055`** per the Interfaces block. Mark the copied driver with `# Copied from plainsight/host/imu.py (2026-11); keep in sync by hand.`

- [ ] **Step 4: Run to verify pass**

Run: `cd head && python -m pytest tests/test_imu.py -q`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add head/plainsight_head/imu.py head/tests/fakes.py head/tests/test_imu.py
git commit -m "feat(head): BNO055 driver, ImuSample, and the 20 Hz ImuReader"
```

---

### Task 5: Persistence and head state (the tick)

**Files:**
- Create: `head/plainsight_head/persist.py`, `head/plainsight_head/state.py`
- Test: `head/tests/test_persist.py`, `head/tests/test_state.py`

**Interfaces:**
- Consumes: `PicoStatus`, `AxisStatus` (Task 2), `ImuSample` (Task 4), `HeadConfig` (Task 1).
- Produces: `class JsonStore(dir: str)` with `read(name: str) -> dict | None` (None when missing or unparseable, logged) and `write(name: str, obj: dict) -> None` (write `name.tmp`, `os.replace`). Creates `dir` on first write.
- Produces: `@dataclass(frozen=True) PanRef(source: str = "none", persisted: bool = False, set_at: float | None = None)`; `source` in `none|imu|host`.
- Produces: `class HeadState(cfg: HeadConfig, time_fn=time.time)` with attributes `pico: PicoStatus | None`, `imu: ImuSample | None`, `pico_link: bool`, `imu_link: bool`, `estop: bool`, `ref: PanRef`, `seq: int`; methods `on_pico_status(st: PicoStatus) -> None` (stores and publishes), `on_imu(sample: ImuSample) -> None` (stores only), `set_pico_link(up: bool)`, `set_imu_link(up: bool)`, `set_estop(on: bool)`, `set_ref(ref: PanRef)`, `tick() -> dict` (the spec 4.2 JSON; omits `axes`, `enabled`, `moving` when `pico_link` is False or `pico` is None), `publish_imu_only() -> None` (publishes a tick without `axes`), `subscribe(cb: Callable[[dict], None]) -> Callable[[], None]` (returns unsubscribe), `tilt_disagree_deg() -> float | None` = `sign * (imu.<tilt_axis> - imu_pitch_offset_deg) - pico.axes["tilt"].pos`, None when IMU not ok or Pico missing.
- Tick keys exactly: `type, t, seq, axes?, enabled?, moving?, estop, imu, tiltDisagreeDeg, ref, link`. `imu` is `{"ok": false}` plus nulls for the other keys when `imu_link` is False. `ref` is `{"pan": source, "persisted": bool, "ageS": seconds since set_at or null}`. `t` is epoch milliseconds (int).

- [ ] **Step 1: Write the failing tests**

```python
# head/tests/test_persist.py
from plainsight_head.persist import JsonStore
def test_roundtrip_and_missing(tmp_path):
    s = JsonStore(str(tmp_path / "data"))
    assert s.read("x") is None
    s.write("x", {"a": 1}); assert s.read("x") == {"a": 1}
    assert not list(tmp_path.glob("data/*.tmp"))
def test_corrupt_file_reads_as_none(tmp_path):
    (tmp_path / "x.json").write_text("{nope"); assert JsonStore(str(tmp_path)).read("x") is None
```

```python
# head/tests/test_state.py
from plainsight_head.state import HeadState, PanRef
from plainsight_head.config import HeadConfig
from plainsight_head.protocol import parse_status
from plainsight_head.imu import ImuSample
STATUS = parse_status("pos=12.0000,30.0000,0,0 vel=0,0,0,0 tgt=12,30,0,0 mode=PPII homed=1100 es=0000 en=1 drv=1111")
def sample(**k):
    d = dict(t=0, heading=124.0, roll=-0.4, pitch=31.5, quat=(1,0,0,0), gravity=(0,0,9.81), linacc=(0,0,0), cal=(3,3,3,2), temp_c=28); d.update(k)
    return ImuSample(**d)
def test_tick_shape_and_publish():
    st = HeadState(HeadConfig.from_env({}), time_fn=lambda: 1762150000.123); got = []
    st.subscribe(got.append); st.set_imu_link(True); st.on_imu(sample()); st.set_pico_link(True); st.on_pico_status(STATUS)
    t = got[-1]
    assert set(t) == {"type","t","seq","axes","enabled","moving","estop","imu","tiltDisagreeDeg","ref","link"}
    assert t["t"] == 1762150000123 and t["seq"] == 1 and t["axes"]["pan"]["pos"] == 12.0 and t["axes"]["pan"]["mode"] == "P"
    assert t["imu"]["cal"] == {"sys":3,"gyr":3,"acc":3,"mag":2} and t["link"] == {"pico": True, "imu": True}
    assert t["ref"] == {"pan": "none", "persisted": False, "ageS": None}
def test_tilt_disagree_uses_axis_sign_and_offset():
    cfg = HeadConfig.from_env({"HEAD_IMU_PITCH_OFFSET_DEG": "1.5", "HEAD_IMU_TILT_SIGN": "-1", "HEAD_IMU_TILT_AXIS": "roll"})
    st = HeadState(cfg); st.set_imu_link(True); st.on_imu(sample(roll=-28.5)); st.set_pico_link(True); st.pico = STATUS
    assert st.tilt_disagree_deg() == -(-28.5 - 1.5) - 30.0
def test_pico_down_tick_has_no_axes_and_imu_down_is_ok_false():
    st = HeadState(HeadConfig.from_env({})); got = []; st.subscribe(got.append)
    st.set_pico_link(False); st.publish_imu_only()
    assert "axes" not in got[-1] and got[-1]["imu"] == {"ok": False, "heading": None, "pitch": None, "roll": None, "cal": None, "tempC": None}
    assert got[-1]["tiltDisagreeDeg"] is None
def test_subscriber_exception_does_not_stop_others():
    st = HeadState(HeadConfig.from_env({})); got = []
    st.subscribe(lambda t: 1/0); st.subscribe(got.append); st.set_pico_link(True); st.on_pico_status(STATUS)
    assert len(got) == 1
```

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_persist.py tests/test_state.py -q`
Expected: FAIL, `ImportError`

- [ ] **Step 3: Implement `persist.py` and `state.py`** per the Interfaces block.

- [ ] **Step 4: Run to verify pass**

Run: `cd head && python -m pytest tests/test_persist.py tests/test_state.py -q`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add head/plainsight_head/persist.py head/plainsight_head/state.py head/tests/test_persist.py head/tests/test_state.py
git commit -m "feat(head): JsonStore and HeadState tick assembly"
```

---

### Task 6: Jog dead-man

**Files:**
- Create: `head/plainsight_head/deadman.py`
- Test: `head/tests/test_deadman.py`

**Interfaces:**
- Produces: `class JogDeadman(timeout_ms: int, stop_axes: Callable[[list[str]], Awaitable[None]], *, time_fn=time.monotonic, poll_s: float = 0.05)` with `async start()`, `async close()`, `touch(axis: str) -> None` (arm/refresh), `clear(axis: str | None = None) -> None` (disarm one or all without calling `stop_axes`), `armed: set[str]`. When an armed axis goes `timeout_ms` without a touch, the task calls `stop_axes([axis, …])` once for all expired axes and disarms them; a failing `stop_axes` is logged and retried on the next poll.

- [ ] **Step 1: Write the failing tests**

```python
# head/tests/test_deadman.py
import asyncio
from plainsight_head.deadman import JogDeadman
from tests.fakes import FakeClock
async def test_expired_axes_are_stopped_once():
    clk = FakeClock(); stopped = []
    async def stop(axes): stopped.append(sorted(axes))
    d = JogDeadman(500, stop, time_fn=clk.now, poll_s=0.01); await d.start()
    d.touch("pan"); d.touch("tilt"); clk.advance(0.3); d.touch("pan"); clk.advance(0.3); await asyncio.sleep(0.05)
    assert stopped == [["tilt"]] and d.armed == {"pan"}
    clk.advance(0.3); await asyncio.sleep(0.05)
    assert stopped == [["tilt"], ["pan"]] and d.armed == set()
    await d.close()
async def test_clear_disarms_without_stopping():
    stopped = []
    async def stop(axes): stopped.append(axes)
    d = JogDeadman(100, stop, poll_s=0.01); await d.start(); d.touch("pan"); d.clear(); await asyncio.sleep(0.2)
    assert stopped == [] and d.armed == set(); await d.close()
```

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_deadman.py -q`
Expected: FAIL, `ImportError`

- [ ] **Step 3: Implement `deadman.py`**.

- [ ] **Step 4: Run to verify pass**

Run: `cd head && python -m pytest tests/test_deadman.py -q`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add head/plainsight_head/deadman.py head/tests/test_deadman.py
git commit -m "feat(head): per-axis jog dead-man"
```

---

### Task 7: Pan reference

**Files:**
- Create: `head/plainsight_head/reference.py`
- Test: `head/tests/test_reference.py`

**Interfaces:**
- Consumes: `PicoLink.command` (Task 3), `ImuReader.latest`/`ok` (Task 4), `HeadState`, `PanRef`, `JsonStore` (Task 5), `HeadConfig` (Task 1).
- Produces: `circular_mean_deg(values: Iterable[float]) -> float` in `[0, 360)`.
- Produces: `wrap180(deg: float) -> float` in `(-180, 180]`.
- Produces: `@dataclass(frozen=True) ReferenceResult(source: str, pan: float | None, reason: str | None)`.
- Produces: `class PanReference(cfg: HeadConfig, pico: PicoLink, imu: ImuReader, state: HeadState, store: JsonStore, *, time_fn=time.time, sleep=asyncio.sleep, on_event: Callable[[str, dict], None])`:
  - `async restore_at_boot() -> ReferenceResult` implementing spec 5.3: rule 1 if `state.pico.axes["pan"].homed` (restore `source` from the file if present, else `host`); else rule 2 if `cfg.pan_restore == "persisted"` and the file exists and `time_fn() - file.t <= cfg.pan_restore_max_age_s` (`SETPOS pan <pos>`); else if `cfg.pan_restore in ("persisted", "imu")` run `reference_from_imu(cfg.ref_timeout_s)`; else `ReferenceResult("none", None, "pan_restore=none")`.
  - `async reference_from_imu(timeout_s: float) -> ReferenceResult`: requires tilt homed else `("none", None, "tilt not homed")`; `MOVE tilt <cfg.ref_tilt_deg>` and wait until `state.pico.moving` is False (poll 50 ms, 30 s cap); wait until `imu.ok` and `cal.mag >= 2 and cal.sys >= 2` or timeout (`("none", None, "imu calibration timeout")`); collect headings for 2 s; `pan = wrap180(circular_mean - cfg.imu_heading_offset_deg)`; `SETPOS pan <pan>`; `state.set_ref(PanRef("imu", True, now))`; persist; `on_event("pan_reference", {"source": "imu", "pan": pan})`.
  - `async set_from_host(pan: float) -> None`: `SETPOS pan`, `set_ref(PanRef("host", True, now))`, persist, event with the previous and new value (`{"source": "host", "pan": pan, "previous": old_pos}`).
  - `async run_persistence() -> None` (task): every 5 s, if `state.pico` exists, pan `vel == 0`, `ref.source != "none"`, and `pos` changed since the last write, write `pan-reference.json` `{pos, source, t}`.
  - `async persist_now() -> None` (for shutdown).
  - `note_enable_off() -> None`: sets `state.ref = PanRef("none")` (spec 4.3 `enable`).

- [ ] **Step 1: Write the failing tests**

```python
# head/tests/test_reference.py
import asyncio, pytest
from plainsight_head.reference import circular_mean_deg, wrap180, PanReference, ReferenceResult
from plainsight_head.state import HeadState, PanRef
# fixture `ctx` builds HeadConfig(env), FakeSerial-backed PicoLink (started, homed flags controllable via fake.model),
# ImuReader over FakeBNO055 (rate 200), HeadState wired to both, JsonStore(tmp_path), events list; see tests/fakes.py helper make_ctx(env, tmp_path)

def test_circular_mean_and_wrap():
    assert circular_mean_deg([359, 1]) == pytest.approx(0.0, abs=1e-6)
    assert circular_mean_deg([360.0]) == pytest.approx(0.0)
    assert wrap180(190) == -170 and wrap180(180) == 180 and wrap180(-180) == 180

async def test_rule1_pico_already_homed_keeps_file_source(ctx):
    ctx.store.write("pan-reference.json", {"pos": 40.0, "source": "host", "t": ctx.now()})
    ctx.fake.model["pan"]["homed"] = True; ctx.fake.emit_status(); await asyncio.sleep(0.05)
    r = await ctx.ref.restore_at_boot()
    assert r.source == "host" and "SETPOS" not in " ".join(ctx.fake.sent) and ctx.state.ref.source == "host"

async def test_rule2_persisted_restore_sets_position(ctx):
    ctx.store.write("pan-reference.json", {"pos": 40.5, "source": "imu", "t": ctx.now() - 100})
    r = await ctx.ref.restore_at_boot()
    assert r == ReferenceResult("imu", 40.5, None) and "SETPOS pan 40.50000" in ctx.fake.sent

async def test_rule2_file_too_old_falls_through_to_imu(ctx_imu_ready):
    c = ctx_imu_ready; c.store.write("pan-reference.json", {"pos": 40.5, "source": "imu", "t": c.now() - 10**7})
    c.imu_fake.heading = 124.0; c.cfg_override(imu_heading_offset_deg=4.0)
    r = await c.ref.restore_at_boot()
    assert r.source == "imu" and r.pan == pytest.approx(120.0) and c.events[-1][0] == "pan_reference"
    assert c.state.ref.persisted and c.store.read("pan-reference.json")["source"] == "imu"

async def test_imu_reference_requires_tilt_homed_and_times_out_on_cal(ctx):
    ctx.fake.model["tilt"]["homed"] = False; ctx.fake.emit_status(); await asyncio.sleep(0.05)
    assert (await ctx.ref.reference_from_imu(0.1)).reason == "tilt not homed"
    ctx.fake.model["tilt"]["homed"] = True; ctx.fake.emit_status(); ctx.imu_fake.cal = (0, 0, 0, 0); await asyncio.sleep(0.05)
    assert (await ctx.ref.reference_from_imu(0.1)).reason == "imu calibration timeout" and ctx.state.ref.source == "none"

async def test_set_from_host_persists_and_reports_previous(ctx):
    await ctx.ref.set_from_host(10.0)
    assert ctx.events[-1] == ("pan_reference", {"source": "host", "pan": 10.0, "previous": 0.0})
    assert ctx.store.read("pan-reference.json")["source"] == "host"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_reference.py -q`
Expected: FAIL, `ImportError`

- [ ] **Step 3: Implement `reference.py`** and add `make_ctx` (plus the `ctx` / `ctx_imu_ready` pytest fixtures in `tests/conftest.py`) to the fakes. `ctx_imu_ready` is `ctx` with the IMU fake at `cal=(3,3,3,3)` and tilt homed.

- [ ] **Step 4: Run to verify pass**

Run: `cd head && python -m pytest tests/test_reference.py -q`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add head/plainsight_head/reference.py head/tests/conftest.py head/tests/fakes.py head/tests/test_reference.py
git commit -m "feat(head): pan reference restore and IMU north"
```

---

### Task 8: HTTP and WebSocket API

**Files:**
- Create: `head/plainsight_head/api.py`
- Test: `head/tests/test_api.py`

**Interfaces:**
- Consumes: everything above. `HeadContext` is a plain dataclass defined in `api.py`: `cfg, pico: PicoLink, imu: ImuReader, state: HeadState, deadman: JogDeadman, ref: PanReference, pico_version: str` (set by main after `VER`).
- Produces: `make_app(ctx: HeadContext) -> aiohttp.web.Application` with the routes of spec 4.3 and `GET /ws`.
- Produces: `estop_latch` lives on `HeadState.estop`; `POST /api/estop` sends `ESTOP`, clears the dead-man (`clear()`), sets `estop=True`, emits event `estop`; `/api/estop/clear` sets False and emits `estop_cleared`.
- Request validation: bodies parsed with a small validator `expect_axes(body: dict, allowed: tuple, kind: "scalar"|"pair") -> dict` raising `web.HTTPBadRequest` with `{"ok": false, "error": …}` on unknown keys, non-finite numbers, non-numbers, or an empty body.
- Error mapping: `PicoError` → 400 with `{"ok": false, "error": reason}`; `PicoTimeout` → 504; link down → 503 (checked before sending); estop latch → 423; `setpos` on an axis whose latest `vel != 0` or `mode in "HV"` → 409 before sending, and a `PicoError` whose reason contains `moving` or `stopped` → 409.
- `POST /api/config` refuses `key in ("socket", "host_baud")` or `scope == "global"` with 403 unless query `force=1`. `save: true` sends `SAVE` after the `CFG`.
- `GET /api/imu?n=` clamps `n` to 1..1000; returns `{"n": n, "samples": [ {t, heading, roll, pitch, quat, gravity, linacc, cal:{sys,gyr,acc,mag}, tempC} … ]}`.
- WebSocket: on connect send the latest tick immediately (`state.tick()`), then every published tick and every event. Per-client `asyncio.Queue(maxsize=50)`; when full, drop the oldest item and count `dropped` (exposed in `/healthz` as `wsDroppedTotal`). Events are published through `state.publish_event(name: str, axis: str | None, detail: dict | str | None)` which Task 5's `HeadState` gains here (`subscribe` callbacks receive both tick and event dicts; `{"type": "event", "t", "name", "axis", "detail"}`).
- `GET /healthz` → `{"ok": true, "pico": bool, "imu": bool, "estop": bool, "wsClients": n, "wsDroppedTotal": n, "version": __version__}`.
- `GET /api/version` → `{"head": __version__, "pico": ctx.pico_version}`.

- [ ] **Step 1: Write the failing tests** (aiohttp `TestClient` over `make_app(ctx)` using the `ctx` fixture from Task 7; `ctx.fake.sent` is the Pico transcript)

```python
# head/tests/test_api.py  (abridged: one test per rule; names are the contract)
async def test_healthz_and_version(client, ctx): ...                    # 200, keys as specified, pico version string
async def test_state_returns_latest_tick(client): ...                   # same shape as WS tick
async def test_goto_sends_move_and_returns_202(client, ctx): ...        # body {"pan":10,"tilt":20} -> "MOVE pan 10.00000 tilt 20.00000"
async def test_goto_while_moving_is_accepted(client, ctx): ...          # fake model vel != 0, still 202
async def test_track_sends_track_pairs(client, ctx): ...                # {"pan":{"pos":1,"vel":0.5}} -> "TRACK pan 1.00000 0.50000"
@pytest.mark.parametrize("body", [{"pan": {"pos": float("nan"), "vel": 0}}, {"pan": {"pos": "1", "vel": 0}}, {"yaw": {"pos": 1, "vel": 0}}, {}])
async def test_track_rejects_bad_bodies_and_sends_nothing(client, ctx, body): ...   # 400 and no TRACK in sent
async def test_jog_arms_deadman_and_zero_disarms(client, ctx): ...      # {"pan": 2} -> "JOG pan 2.00000", deadman.armed == {"pan"}; {"pan": 0} -> armed == set()
async def test_deadman_expiry_sends_stop(client, ctx): ...              # after jog_deadman_ms with no refresh: "STOP pan" in sent
async def test_stop_clears_deadman(client, ctx): ...
async def test_estop_latches_and_motion_returns_423(client, ctx): ...   # ESTOP sent; goto/track/jog/home -> 423; stop still allowed; clear -> goto 202; events estop/estop_cleared on WS
async def test_link_down_returns_503(client, ctx): ...                  # state.set_pico_link(False); goto -> 503, state/healthz still 200
async def test_home_defaults_and_event_forwarding(client, ctx, ws): ...  # POST /api/home {} -> "HOME"; fake emits *E homed tilt -> WS {"type":"event","name":"homed","axis":"tilt"}
async def test_setpos_sets_host_ref_and_409_when_moving(client, ctx): ...  # 200 path -> ref.pan=="host"; fake vel!=0 -> 409 and no SETPOS sent; reply_override SETPOS="err axis moving" -> 409
async def test_enable_off_clears_ref(client, ctx): ...                  # ENABLE 0 -> ref.pan == "none"
async def test_reference_returns_202_and_event(client, ctx_imu_ready, ws): ...
async def test_imu_burst_shape_and_clamp(client): ...                   # ?n=5000 -> 1000 samples; keys per spec
async def test_config_get_set_guard_and_save(client, ctx): ...          # GET shape {"pan":{...},"global":{...},"head":{...}}; POST pan vmax 20 -> "CFG pan vmax 20"; POST global -> 403; ?force=1 -> 200; save:true -> SAVE sent after CFG
async def test_drivers_parsed(client): ...
async def test_ws_sends_latest_tick_on_connect_then_ticks(client, ctx): ...
async def test_ws_slow_client_drops_oldest_without_blocking_others(client, ctx): ...  # one client never reads; emit 200 status lines; other client receives all; healthz wsDroppedTotal > 0
```

Write each as a real test with the assertions given in the comment.

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_api.py -q`
Expected: FAIL, `ImportError`

- [ ] **Step 3: Implement `api.py`** and the `publish_event` addition to `state.py`. Keep route handlers under 30 lines each by factoring `send_motion(ctx, line)` (link check, latch check, `command`, error mapping) and `expect_axes`.

- [ ] **Step 4: Run to verify pass**

Run: `cd head && python -m pytest tests/test_api.py -q`
Expected: all passed

- [ ] **Step 5: Commit**

```bash
git add head/plainsight_head/api.py head/plainsight_head/state.py head/tests/test_api.py
git commit -m "feat(head): HTTP command routes and WebSocket telemetry"
```

---

### Task 9: Startup sequence, IMU-only ticks, shutdown

**Files:**
- Create: `head/plainsight_head/main.py`
- Modify: `head/plainsight_head/__main__.py`
- Test: `head/tests/test_main.py`

**Interfaces:**
- Produces: `async def run(cfg: HeadConfig, *, serial_factory=None, imu_open=None, store=None, stop_event: asyncio.Event | None = None) -> None` (injection points for tests) and `def main() -> None` (parses env, configures logging at `cfg.log_level`, installs SIGTERM/SIGINT → `stop_event`, runs `run`).
- Startup order (spec 5.1), each step logged: (1) `PicoLink.start`; on first connect and on every reconnect, `init_pico()`: `VER` (store `pico_version`), `CFG` (log), `CFG global track_timeout_ms <cfg.track_timeout_ms>`, `STREAM <cfg.stream_ms>`, `link.expect_stream = True`. (2) `ImuReader.start` with `imu_open` reading `bno055-offsets.json` via `store` and `load_offsets` when present; `on_fully_calibrated` writes that file. (3) aiohttp server on `cfg.port`. (4) wait up to 3 s for the first status; if `cfg.auto_home` and tilt not homed: `HOME tilt`, wait for `homed tilt` / `home_failed tilt` event or 60 s. (5) `ref.restore_at_boot()`. (6) start `deadman`, `ref.run_persistence()`, and the IMU-only ticker: a task that every 0.5 s calls `state.publish_imu_only()` while `state.pico_link` is False.
- Shutdown on `stop_event`: `STOP` (best effort, 1 s timeout), `ref.persist_now()`, close server, deadman, imu, pico.
- Reconnect handling: `init_pico()` only; no homing, no referencing (spec 5.2). If the Pico came back with `pan.homed == False`, set `state.ref = PanRef("none")` and emit `pan_reference` with `source: none`.

- [ ] **Step 1: Write the failing tests**

```python
# head/tests/test_main.py
async def test_boot_sequence_order(tmp_path):
    # run() with FakeSerial (tilt not homed, home_ticks=2), FakeBNO055 cal (3,3,3,3) heading 90, empty store, auto_home on
    # assert fake.sent starts with ["VER", "CFG", "CFG global track_timeout_ms 1000", "STREAM 100", "HOME tilt"] and later contains "SETPOS pan 90.00000"
    # assert GET /healthz on cfg.port answers during the boot (server up before homing finishes)
async def test_no_auto_home_and_pan_restore_none_sends_no_motion(tmp_path): ...   # sent has no HOME/MOVE/SETPOS
async def test_imu_only_ticks_while_pico_down(tmp_path): ...                      # fail the serial factory; WS receives ticks without "axes" at ~2 Hz; link.pico False
async def test_reconnect_reinits_without_homing_and_drops_ref_if_pico_rebooted(tmp_path): ...  # after link loss, fake model homed cleared; sent after reconnect == [VER, CFG, CFG global…, STREAM 100]; ref.pan == "none"; event pan_reference none
async def test_shutdown_stops_and_persists(tmp_path): ...                         # set stop_event; last sent == "STOP"; pan-reference.json written
```

Write each as a real test.

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_main.py -q`
Expected: FAIL, `ImportError`

- [ ] **Step 3: Implement `main.py`**; make `__main__.py` call `main()`.

- [ ] **Step 4: Run to verify pass**

Run: `cd head && python -m pytest -q`
Expected: all tests in `head/tests` pass

- [ ] **Step 5: Commit**

```bash
git add head/plainsight_head/main.py head/plainsight_head/__main__.py head/tests/test_main.py
git commit -m "feat(head): startup sequence, IMU-only ticks, graceful shutdown"
```

---

### Task 10: API document and contract schemas

**Files:**
- Create: `docs/HEAD-API.md`, `docs/head-api/schemas/tick.json`, `event.json`, `goto.json`, `track.json`, `jog.json`, `setpos.json`, `config-set.json`, `imu-burst.json`
- Test: `head/tests/test_contract.py`

**Interfaces:**
- Produces: JSON Schema (draft 2020-12) files. `tick.json` requires `type, t, seq, estop, imu, tiltDisagreeDeg, ref, link` and declares `axes` (object with exactly the four axis keys, each `{pos, vel, tgt, mode: enum[I,P,T,V,H], homed, endstop, driver}`), `enabled`, `moving` as optional; `additionalProperties: false` at every level. Command schemas mirror Task 8's validation (numbers must be finite: use `"type": "number"` and note that JSON cannot carry NaN, so the NaN rule is a parser rule).
- Produces: `docs/HEAD-API.md`: spec section 4 rewritten as reference documentation (frame contract, tick, events, route table with status codes, config guard, examples), linking each schema file. This is the document the host plan's contract test also reads.

- [ ] **Step 1: Write the failing test**

```python
# head/tests/test_contract.py
import json, pathlib, jsonschema
SCHEMAS = pathlib.Path(__file__).parents[2] / "docs" / "head-api" / "schemas"
def load(n): return json.loads((SCHEMAS / n).read_text())
def test_live_tick_validates(ctx):                      # from the ctx fixture, after one status and one imu sample
    jsonschema.validate(ctx.state.tick(), load("tick.json"))
def test_pico_down_tick_validates(ctx):
    ctx.state.set_pico_link(False); jsonschema.validate(ctx.state.tick(), load("tick.json"))
def test_event_validates(ctx):
    jsonschema.validate({"type":"event","t":1,"name":"homed","axis":"tilt","detail":None}, load("event.json"))
def test_spec_examples_validate():                      # the JSON examples embedded in docs/HEAD-API.md (fenced ```json blocks tagged with a schema name in the preceding line) all validate
    ...
```

- [ ] **Step 2: Run to verify failure**

Run: `cd head && python -m pytest tests/test_contract.py -q`
Expected: FAIL, schema files missing

- [ ] **Step 3: Write the schemas and `docs/HEAD-API.md`**.

- [ ] **Step 4: Run to verify pass**

Run: `cd head && python -m pytest tests/test_contract.py -q`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add docs/HEAD-API.md docs/head-api head/tests/test_contract.py
git commit -m "docs(head): HEAD-API reference and JSON Schemas with contract tests"
```

---

### Task 11: Container, compose, bench tool

**Files:**
- Create: `head/Dockerfile`, `head/compose.yaml`, `head/.env.example`, `head/.dockerignore`, `head/tools/track_bench.py`
- Test: `head/tests/test_track_bench.py` (the bench's error math only)

**Interfaces:**
- `Dockerfile`: `FROM python:3.13-slim`, copy `pyproject.toml` and `plainsight_head/`, `pip install --no-cache-dir .`, `ENV PYTHONUNBUFFERED=1`, `CMD ["python", "-m", "plainsight_head"]`, `EXPOSE 8780`. No test deps in the image.
- `compose.yaml`: service `head`, `build: .`, `image: plainsight-head`, `restart: unless-stopped`, `init: true`, `stop_grace_period: 5s`, `ports: ["${HEAD_PORT:-8780}:8780"]`, `devices: ["${HEAD_SERIAL_BY_ID}:/dev/ttyACM0", "/dev/i2c-${HEAD_I2C_BUS}:/dev/i2c-${HEAD_I2C_BUS}"]`, `group_add: ["${DIALOUT_GID}", "${I2C_GID}"]`, `volumes: ["./data:/data"]`, `env_file: .env`, `environment: [HEAD_I2C_BUS=${HEAD_I2C_BUS}]`.
- `.env.example`: `HEAD_SERIAL_BY_ID=/dev/serial/by-id/usb-Raspberry_Pi_Pico_454741505A8814FA-if00`, `HEAD_I2C_BUS=3`, `DIALOUT_GID=20`, `I2C_GID=989`, plus every `HEAD_*` key with its default commented.
- `tools/track_bench.py`: `python tools/track_bench.py --head http://192.168.4.96:8780 --axis pan --rate 2 --seconds 60 [--sine AMPLITUDE PERIOD] [--stop-test]`. Reads the start position, sends `POST /api/track` at 10 Hz with `pos = start + profile(t)`, `vel = profile'(t)`, records `axes[axis].pos` from `/ws` ticks, prints max and RMS following error and the 95th percentile. `--stop-test` stops sending after 10 s and reports how long until `vel == 0` (expect under 1 s). Exit code 1 if max error > 0.5° or stop time > 1 s. Pure function `following_error(commanded: list[tuple[float,float]], observed: list[tuple[float,float]]) -> dict` (interpolate commanded at observed times) is the unit-tested part.

- [ ] **Step 1: Write the failing test** for `following_error` (two aligned series with a constant 0.2° lag → `max ≈ 0.2`, `rms ≈ 0.2`).

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Write the Dockerfile, compose, env example, dockerignore (`tests/ .venv/ __pycache__/ data/`), and the bench tool.**

- [ ] **Step 4: Verify**

Run: `cd head && python -m pytest -q && docker compose --env-file .env.example config >/dev/null && docker build -t plainsight-head:check .`
Expected: tests pass; compose config prints no error; image builds (on the Mac this builds amd64, which is fine for a syntax check).

- [ ] **Step 5: Commit**

```bash
git add head/Dockerfile head/compose.yaml head/.env.example head/.dockerignore head/tools head/tests/test_track_bench.py
git commit -m "feat(head): container, compose, and TRACK bench tool"
```

---

### Task 12: Deploy to the Zero 2W and first-light checks

This task is run against the real head and needs Docker installed there (the owner does `curl -fsSL https://get.docker.com | sh` and `sudo usermod -aG docker atomist`; the plan does not run sudo).

**Files:**
- Create: `docs/BRING-UP.md` (spec section 8, steps 1 to 4, as a checklist with the exact commands below)

- [ ] **Step 1: Sync and build on the head**

Run: `rsync -a --exclude .venv --exclude data head/ atomist@192.168.4.96:~/plainsight-tracker/head/ && ssh atomist@192.168.4.96 'cd ~/plainsight-tracker/head && cp -n .env.example .env && docker compose up -d --build'`
Expected: container `head` running.

- [ ] **Step 2: Verify boot**

Run: `curl -s http://192.168.4.96:8780/healthz; curl -s http://192.168.4.96:8780/api/version; docker compose logs --tail 40` (on the head)
Expected: `"pico": true, "imu": true`; logs show `VER`, `CFG`, `STREAM 100`, `HOME tilt`, `homed tilt`, then the pan reference result.

- [ ] **Step 3: Verify telemetry and direction**

Run: a 5 s `websocat ws://192.168.4.96:8780/ws | head -5`, then `curl -XPOST -d '{"pan":5}' http://…/api/goto`, watch pan increase; `{"tilt":10}`, watch tilt increase and `tiltDisagreeDeg` stay near a constant; record that constant as `HEAD_IMU_PITCH_OFFSET_DEG` in `.env` and restart.
Expected: pan increases clockwise seen from above; tilt increases upward; after the offset, `tiltDisagreeDeg` within ±0.5 at tilt 0 and 45.

- [ ] **Step 4: Bench TRACK**

Run: `python head/tools/track_bench.py --head http://192.168.4.96:8780 --axis pan --rate 2 --seconds 60` and the same for `tilt --rate 1`, then `--stop-test`.
Expected: exit 0 for all three; record the numbers in `docs/BRING-UP.md`.

- [ ] **Step 5: Commit the bring-up doc with the recorded results**

```bash
git add docs/BRING-UP.md head/.env.example
git commit -m "docs: head bring-up checklist with first-light results"
```
