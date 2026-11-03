"""Scripted fake Pico (FakeSerial), fake BNO055, an injectable clock, and the wired HeadCtx for tests."""
from __future__ import annotations

import asyncio
import dataclasses
import threading
import time
from collections import deque

from plainsight_head.config import HeadConfig
from plainsight_head.deadman import JogDeadman
from plainsight_head.imu import ImuReader
from plainsight_head.persist import JsonStore
from plainsight_head.pico import PicoLink
from plainsight_head.protocol import AXES
from plainsight_head.state import HeadState


class FakeClock:
    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def now(self) -> float:
        return self._now

    def advance(self, s: float) -> None:
        self._now += s


def _axis_model() -> dict:
    return {"pos": 0.0, "vel": 0.0, "tgt": 0.0, "mode": "I",
            "homed": False, "endstop": False, "driver": True}


class FakeSerial:
    """Subset of serial.Serial used by PicoLink, answering like the firmware.

    The instance stays usable after close() (tests hand the same object back
    from the serial factory to simulate a reconnect); is_open is informational.
    """

    def __init__(self, timeout: float = 0.02) -> None:
        self.timeout = timeout
        self.is_open = True
        self.model: dict = {**{ax: _axis_model() for ax in AXES}, "enabled": True}
        self.home_ticks = 2
        self.home_axes = ("tilt",)  # axes with home_dir set in the firmware config
        self.home_pos = 0.0
        self.sent: list[str] = []
        self.reply_override: dict[str, str] = {}
        self.cfg: dict[str, dict[str, float]] = {ax: {"maxv": 100.0, "acc": 50.0} for ax in AXES}
        self.cfg["global"] = {"track_timeout_ms": 1000.0}
        self._cond = threading.Condition()
        self._out = bytearray()
        self._in = bytearray()
        self._fail_reads = 0
        self._home_left: dict[str, int] = {}

    # --- serial.Serial subset -------------------------------------------
    def read(self, n: int = 1) -> bytes:
        with self._cond:
            if self._fail_reads > 0:
                self._fail_reads -= 1
                raise OSError("fake read failure")
            if not self._out:
                self._cond.wait(self.timeout)
            if self._fail_reads > 0:
                self._fail_reads -= 1
                raise OSError("fake read failure")
            data = bytes(self._out[:n])
            del self._out[:n]
            return data

    def write(self, data: bytes) -> int:
        with self._cond:
            self._in += data
            while b"\n" in self._in:
                raw, _, rest = bytes(self._in).partition(b"\n")
                self._in = bytearray(rest)
                line = raw.decode("utf-8", errors="replace").strip()
                if line:
                    self.sent.append(line)
                    self._handle(line)
        return len(data)

    def reset_input_buffer(self) -> None:
        with self._cond:
            self._out.clear()

    def close(self) -> None:
        self.is_open = False

    # --- test knobs ------------------------------------------------------
    def emit_raw(self, data: bytes) -> None:
        with self._cond:
            self._out += data
            self._cond.notify_all()

    def fail_next_reads(self, n: int) -> None:
        with self._cond:
            self._fail_reads = n
            self._cond.notify_all()

    def reboot(self) -> None:
        """Simulate a Pico power cycle: every axis back to the power-on model (unhomed, at 0)."""
        with self._cond:
            self.model = {**{ax: _axis_model() for ax in AXES}, "enabled": True}
            self._home_left.clear()

    def emit_status(self) -> None:
        """Push one *S line for the model; advances any homing in progress."""
        with self._cond:
            self._emit(self._status_line())
            for ax in list(self._home_left):
                self._home_left[ax] -= 1
                if self._home_left[ax] <= 0:
                    del self._home_left[ax]
                    m = self.model[ax]
                    m.update(pos=self.home_pos, tgt=self.home_pos, homed=True, mode="I", vel=0.0)
                    self._emit(f"*E homed {ax}")

    # --- internals (call with the lock held) -------------------------------
    def _emit(self, line: str) -> None:
        self._out += (line + "\n").encode()
        self._cond.notify_all()

    def _status_line(self) -> str:
        m = self.model
        def f(key: str) -> str:
            return ",".join(f"{float(m[ax][key]):.3f}" for ax in AXES)
        def flags(key: str) -> str:
            return "".join("1" if m[ax][key] else "0" for ax in AXES)
        mode = "".join(m[ax]["mode"] for ax in AXES)
        return (f"*S pos={f('pos')} vel={f('vel')} tgt={f('tgt')} mode={mode} "
                f"homed={flags('homed')} es={flags('endstop')} en={int(m['enabled'])} drv={flags('driver')}")

    def _reply(self, *lines: str) -> None:
        for line in lines:
            self._emit(line)

    @staticmethod
    def _axis_args(tokens: list[str]) -> dict[str, list[float]]:
        out: dict[str, list[float]] = {}
        cur = None
        for t in tokens:
            if t in AXES:
                cur = out.setdefault(t, [])
            elif cur is not None:
                cur.append(float(t))
        return out

    def _handle(self, line: str) -> None:
        verb, *args = line.split()
        if verb in self.reply_override:
            text = self.reply_override[verb]
            if text:
                self._reply(text)
            return
        try:
            self._dispatch(verb, args)
        except (ValueError, KeyError):
            self._reply("err bad args")

    def _dispatch(self, verb: str, args: list[str]) -> None:
        m = self.model
        if verb == "VER":
            self._reply("V plainsight-ptz 0.1.0", "ok")
        elif verb == "STATUS":
            self._reply(self._status_line()[1:], "ok")
        elif verb == "CFG" and len(args) == 3:
            self.cfg.setdefault(args[0], {})[args[1]] = float(args[2])
            self._reply("ok")
        elif verb == "CFG":
            self._reply(*[f"C {ax} {k} {v:g}" for ax, kv in self.cfg.items() for k, v in kv.items()], "ok")
        elif verb == "DRV":
            self._reply(*[f"D {ax} sg=0 cs=0" for ax in AXES], "ok")
        elif verb in ("MOVE", "MOVER", "TRACK"):
            for ax, vals in self._axis_args(args).items():
                base = m[ax]["pos"] if verb == "MOVER" else 0.0
                m[ax]["tgt"] = base + vals[0]
                m[ax]["mode"] = "T" if verb == "TRACK" else "P"
            self._reply("ok")
        elif verb == "JOG":
            for ax, vals in self._axis_args(args).items():
                m[ax]["vel"] = vals[0]
                m[ax]["mode"] = "V"
            self._reply("ok")
        elif verb in ("STOP", "ESTOP"):
            for ax in AXES:
                m[ax]["vel"] = 0.0
                if m[ax]["mode"] in ("P", "T", "V"):
                    m[ax]["mode"] = "I"
            self._reply("ok")
        elif verb == "HOME":
            for ax in args or self.home_axes:  # bare HOME homes the axes with an endstop
                if ax not in AXES:
                    raise KeyError(ax)
                m[ax]["mode"] = "H"
                self._home_left[ax] = self.home_ticks
            self._reply("ok")
        elif verb == "SETPOS":
            for ax, vals in self._axis_args(args).items():
                m[ax].update(pos=vals[0], homed=True)
            self._reply("ok")
        elif verb == "ENABLE":
            m["enabled"] = args[0] != "0"
            if not m["enabled"]:
                for ax in AXES:
                    m[ax]["homed"] = False
            self._reply("ok")
        elif verb in ("SAVE", "STREAM"):
            self._reply("ok")
        else:
            self._reply("err unknown command")


_FAKE_MODE_CONFIG, _FAKE_MODE_NDOF = 0x00, 0x0C


class FakeBNO055:
    """In-memory stand-in for plainsight_head.imu.BNO055 (settable readings, injectable failures)."""

    def __init__(self, heading: float = 0.0, roll: float = 0.0, pitch: float = 0.0,
                 cal: tuple[int, int, int, int] = (0, 0, 0, 0),
                 quat: tuple[float, float, float, float] = (1.0, 0.0, 0.0, 0.0),
                 gravity: tuple[float, float, float] = (0.0, 0.0, 9.81),
                 linacc: tuple[float, float, float] = (0.0, 0.0, 0.0),
                 temp: int = 25) -> None:
        self.heading, self.roll, self.pitch = heading, roll, pitch
        self.cal, self.quat, self.gravity, self.linacc, self.temp = cal, quat, gravity, linacc, temp
        self.offsets: bytes = bytes(range(22))
        self.closed = False
        self.mode = _FAKE_MODE_NDOF
        self.offsets_writes: list[bytes] = []
        self.offsets_reads = 0
        self._fail = 0
        self._fail_offsets = 0

    def fail_next(self, n: int) -> None:
        self._fail = n

    def _maybe_fail(self) -> None:
        if self._fail > 0:
            self._fail -= 1
            raise OSError("fake BNO055 failure")

    def read_sample(self, now: float):
        from plainsight_head.imu import ImuSample

        self._maybe_fail()
        return ImuSample(t=now, heading=self.heading % 360.0, roll=self.roll, pitch=self.pitch,
                         quat=self.quat, gravity=self.gravity, linacc=self.linacc,
                         cal=self.cal, temp_c=self.temp)

    def euler(self) -> tuple[float, float, float]:
        self._maybe_fail()
        return self.heading, self.roll, self.pitch

    def quaternion(self) -> tuple[float, float, float, float]:
        self._maybe_fail()
        return self.quat

    def calibration(self) -> tuple[int, int, int, int]:
        self._maybe_fail()
        return self.cal

    def temperature(self) -> int:
        self._maybe_fail()
        return self.temp

    def fail_offsets(self, n: int) -> None:
        """Make the next n OFFSETS-register reads raise OSError (after entering CONFIG mode)."""
        self._fail_offsets = n

    def get_offsets(self) -> bytes:
        self._maybe_fail()
        self.offsets_reads += 1
        self.mode = _FAKE_MODE_CONFIG
        try:
            if self._fail_offsets > 0:
                self._fail_offsets -= 1
                raise OSError("fake OFFSETS read failure")
            return self.offsets
        finally:
            self.mode = _FAKE_MODE_NDOF

    def set_offsets(self, data: bytes) -> None:
        self._maybe_fail()
        self.offsets = bytes(data)
        self.offsets_writes.append(self.offsets)

    def close(self) -> None:
        self.closed = True


_CTX_STREAM_S = 0.02  # the real Pico streams every 100 ms; faster keeps tests short


class HeadCtx:
    """A HeadState wired to a started PicoLink (FakeSerial) and ImuReader (FakeBNO055).

    A background task streams status lines like the Pico's `STREAM`, so code that
    waits for a fresh status after a command sees one; `streaming(False)` pauses it.
    Wired as main.Head wires production: each status first merges `imu.latest` into
    `state`, then goes to `state.on_pico_status`, then `ref.on_status`; Pico `*E`
    events and PanReference events are published on `state`. The attributes cover
    api.HeadContext so `make_app(ctx)` accepts it. (main's IMU-only ticker and
    init_pico are not reproduced here.)
    """

    pico_version = "plainsight-ptz 0.1.0"

    def __init__(self, env: dict, tmp_path) -> None:
        self.cfg = HeadConfig.from_env(env)
        self.fake = FakeSerial()
        self.imu_fake = FakeBNO055()
        self.state = HeadState(self.cfg)
        self.data_dir = tmp_path / "data"
        self.store = JsonStore(str(self.data_dir))
        self.events: list[tuple[str, dict]] = []
        self.pico_events: list = []
        self.link = PicoLink("/dev/fake", 115200, on_status=self._on_status,
                             on_event=self._on_pico_event, on_link=self._on_pico_link,
                             serial_factory=lambda p, b: self.fake)
        self.imu = ImuReader(lambda: self.imu_fake, rate_hz=200, on_link=self.state.set_imu_link)
        self._ref_kw: dict = {"heading_window_s": 0.1}
        self.ref = self._make_ref()
        self.deadman = self._make_deadman()
        self._streamer: asyncio.Task | None = None

    @property
    def pico(self) -> PicoLink:
        return self.link

    def now(self) -> float:
        return time.time()

    def _on_status(self, st) -> None:
        if self.imu.latest is not None:  # main merges the latest IMU sample into every tick
            self.state.on_imu(self.imu.latest)
        self.state.on_pico_status(st)
        self.ref.on_status(st)

    def _on_pico_event(self, ev) -> None:
        self.pico_events.append(ev)
        self.state.publish_event(ev.name, ev.axis, ev.detail)

    def _on_pico_link(self, up: bool) -> None:
        self.state.set_pico_link(up)
        self.state.publish_event("pico_link", None, {"up": up})

    def _on_ref_event(self, name: str, detail: dict) -> None:
        self.events.append((name, detail))
        self.state.publish_event(name, None, detail)

    def _make_deadman(self) -> JogDeadman:
        from plainsight_head.api import pico_stop_axes  # deferred like _make_ref

        return JogDeadman(self.cfg.jog_deadman_ms, pico_stop_axes(self.link))

    def _make_ref(self):
        from plainsight_head.reference import PanReference  # deferred: keeps other test modules importable

        return PanReference(self.cfg, self.link, self.imu, self.state, self.store,
                            time_fn=self.now, on_event=self._on_ref_event,
                            **self._ref_kw)

    def cfg_override(self, **kw) -> None:
        self.cfg = dataclasses.replace(self.cfg, **kw)
        self.ref = self._make_ref()

    def ref_override(self, **kw) -> None:
        """Rebuild `ref` with extra PanReference kwargs (sleep, settle_cap_s, status_wait_s, ...)."""
        self._ref_kw = {**self._ref_kw, **kw}
        self.ref = self._make_ref()

    async def status_now(self, timeout_s: float = 1.0) -> None:
        """Emit one status line and wait until HeadState has taken it."""
        before = self.state.pico
        self.fake.emit_status()
        deadline = time.monotonic() + timeout_s
        while self.state.pico is before:
            if time.monotonic() > deadline:
                raise AssertionError("fake Pico status never reached HeadState")
            await asyncio.sleep(0.005)

    async def streaming(self, on: bool) -> None:
        if on and self._streamer is None:
            self._streamer = asyncio.create_task(self._stream(), name="fake-pico-stream")
        elif not on and self._streamer is not None:
            task, self._streamer = self._streamer, None
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def start(self) -> None:
        await self.link.start()
        await self.imu.start()
        await self.status_now()
        deadline = time.monotonic() + 1.0
        while not self.imu.ok:
            if time.monotonic() > deadline:
                raise AssertionError("fake IMU never came up")
            await asyncio.sleep(0.005)
        await self.streaming(True)
        await self.deadman.start()

    async def _stream(self) -> None:
        while True:
            await asyncio.sleep(_CTX_STREAM_S)
            self.fake.emit_status()

    async def close(self) -> None:
        await self.deadman.close()
        await self.streaming(False)
        await self.imu.close()
        await self.link.close()


async def make_ctx(env: dict, tmp_path) -> HeadCtx:
    c = HeadCtx(env, tmp_path)
    try:
        await c.start()
    except BaseException:
        await c.close()
        raise
    return c
