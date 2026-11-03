"""Scripted fake Pico (FakeSerial) and an injectable clock for tests."""
from __future__ import annotations

import threading
import time
from collections import deque

from plainsight_head.protocol import AXES



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
        self.home_pos = 0.0
        self.sent: list[str] = []
        self.reply_override: dict[str, str] = {}
        self.cfg: dict[str, dict[str, float]] = {ax: {"maxv": 100.0, "acc": 50.0} for ax in AXES}
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
            for ax in args:
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
        self._fail = 0

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

    def get_offsets(self) -> bytes:
        self._maybe_fail()
        return self.offsets

    def set_offsets(self, data: bytes) -> None:
        self._maybe_fail()
        self.offsets = bytes(data)

    def close(self) -> None:
        self.closed = True
