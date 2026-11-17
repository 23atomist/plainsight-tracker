#!/usr/bin/env python3
"""Host library and CLI for the plainsight pan/tilt/zoom/focus controller.

Library use (this is what the ADS-B tracker will import):

    from ptz import PTZ
    with PTZ() as ptz:                      # auto-detects the RP2040 USB port
        ptz.move(pan=120, tilt=30)
        ptz.wait_idle()
        ptz.track(pan=(121.5, 0.8), tilt=(31.0, 0.1))   # (position, velocity)

CLI:  python ptz.py --help
"""
from __future__ import annotations

import argparse
import queue
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import serial
from serial.tools import list_ports

AXES = ("pan", "tilt", "zoom", "focus")
RP2040_VID = 0x2E8A


class PTZError(Exception):
    pass


@dataclass
class Status:
    pos: dict[str, float] = field(default_factory=dict)
    vel: dict[str, float] = field(default_factory=dict)
    target: dict[str, float] = field(default_factory=dict)
    mode: dict[str, str] = field(default_factory=dict)  # I idle, P position, T tracking, V velocity, H homing
    homed: dict[str, bool] = field(default_factory=dict)
    endstop: dict[str, bool] = field(default_factory=dict)
    driver_ok: dict[str, bool] = field(default_factory=dict)
    enabled: bool = False

    @property
    def moving(self) -> bool:
        return any(v != 0 for v in self.vel.values()) or "H" in self.mode.values()

    @classmethod
    def parse(cls, text: str) -> "Status":
        kv = dict(item.split("=", 1) for item in text.split() if "=" in item)

        def floats(key):
            return dict(zip(AXES, (float(x) for x in kv[key].split(","))))

        def flags(key):
            return dict(zip(AXES, (c == "1" for c in kv[key])))

        return cls(
            pos=floats("pos"),
            vel=floats("vel"),
            target=floats("tgt"),
            mode=dict(zip(AXES, kv["mode"])),
            homed=flags("homed"),
            endstop=flags("es"),
            driver_ok=flags("drv"),
            enabled=kv["en"] == "1",
        )


def find_port() -> str:
    ports = [p for p in list_ports.comports() if p.vid == RP2040_VID]
    if not ports:
        raise PTZError("no RP2040 controller found on USB; pass --port")
    return ports[0].device


class PTZ:
    """Thread-safe client. Asynchronous lines from the controller (*E events,
    *S stream status) are delivered to the callbacks on a reader thread."""

    def __init__(
        self,
        port: str | None = None,
        baud: int = 115200,
        timeout: float = 2.0,
        on_event: Callable[[str], None] | None = None,
        on_status: Callable[[Status], None] | None = None,
    ):
        self.ser = serial.Serial(port or find_port(), baud, timeout=0.05)
        self.timeout = timeout
        self.on_event = on_event
        self.on_status = on_status
        self._replies: queue.Queue[str] = queue.Queue()
        self._lock = threading.Lock()
        self._running = True
        self.ser.reset_input_buffer()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    # -- plumbing ---------------------------------------------------------
    def close(self):
        self._running = False
        self._reader.join(timeout=1)
        self.ser.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _read_loop(self):
        buf = b""
        while self._running:
            try:
                buf += self.ser.read(256)
            except (serial.SerialException, OSError):
                break
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode(errors="replace").strip()
                if line:
                    self._dispatch(line)

    def _dispatch(self, line: str):
        if line.startswith("*S "):
            if self.on_status:
                self.on_status(Status.parse(line[3:]))
        elif line.startswith("*E "):
            if self.on_event:
                self.on_event(line[3:])
        else:
            self._replies.put(line)

    def command(self, line: str) -> list[str]:
        """Send one command; return its data lines. Raises PTZError on 'err'."""
        with self._lock:
            while not self._replies.empty():
                self._replies.get_nowait()
            self.ser.write((line + "\n").encode())
            data = []
            deadline = time.monotonic() + self.timeout
            while True:
                try:
                    reply = self._replies.get(timeout=max(0.0, deadline - time.monotonic()))
                except queue.Empty:
                    raise PTZError(f"timeout waiting for reply to {line!r}") from None
                if reply == "ok":
                    return data
                if reply.startswith("err"):
                    raise PTZError(f"{line!r}: {reply[4:]}")
                data.append(reply)

    @staticmethod
    def _axes_args(values: dict) -> str:
        parts = []
        for ax, v in values.items():
            if ax not in AXES:
                raise PTZError(f"unknown axis {ax!r}")
            vals = v if isinstance(v, (tuple, list)) else (v,)
            parts.append(ax + "".join(f" {float(x):.5f}" for x in vals))
        if not parts:
            raise PTZError("no axes given")
        return " ".join(parts)

    # -- motion -----------------------------------------------------------
    def move(self, **pos: float):
        self.command("MOVE " + self._axes_args(pos))

    def move_by(self, **delta: float):
        self.command("MOVER " + self._axes_args(delta))

    def track(self, **pos_vel: tuple[float, float]):
        """Position now and velocity (units/s) per axis. Resend at least every
        track_timeout_ms (default 3 s); 2-10 Hz gives smooth following."""
        self.command("TRACK " + self._axes_args(pos_vel))

    def jog(self, **vel: float):
        self.command("JOG " + self._axes_args(vel))

    def stop(self, *axes: str):
        self.command("STOP " + " ".join(axes))

    def estop(self):
        self.command("ESTOP")

    def home(self, *axes: str):
        self.command("HOME " + " ".join(axes))

    def set_position(self, **pos: float):
        self.command("SETPOS " + self._axes_args(pos))

    def enable(self, on: bool = True):
        self.command(f"ENABLE {int(on)}")

    def status(self) -> Status:
        line = self.command("STATUS")[0]
        return Status.parse(line[2:])

    def wait_idle(self, timeout: float = 60.0, poll: float = 0.05) -> Status:
        deadline = time.monotonic() + timeout
        while True:
            st = self.status()
            if not st.moving:
                return st
            if time.monotonic() > deadline:
                raise PTZError("timeout waiting for motion to finish")
            time.sleep(poll)

    def stream(self, interval_ms: int):
        self.command(f"STREAM {int(interval_ms)}")

    # -- configuration ----------------------------------------------------
    def config(self, scope: str | None = None) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        for line in self.command("CFG" + (f" {scope}" if scope else "")):
            _, sc, key, val = line.split()
            out.setdefault(sc, {})[key] = float(val)
        return out

    def set_config(self, scope: str, key: str, value: float):
        self.command(f"CFG {scope} {key} {value}")

    def save(self):
        self.command("SAVE")

    def drivers(self) -> list[str]:
        return self.command("DRV")

    def version(self) -> str:
        return self.command("VER")[0][2:]


# ---------------------------------------------------------------- CLI ----

def _pairs(args: list[str]) -> dict[str, float]:
    if len(args) % 2:
        raise SystemExit("expected <axis> <value> pairs")
    return {args[i]: float(args[i + 1]) for i in range(0, len(args), 2)}


def _print_status(st: Status):
    print(f"enabled={st.enabled}")
    for ax in AXES:
        print(
            f"  {ax:5s} pos={st.pos[ax]:10.4f} vel={st.vel[ax]:9.4f} tgt={st.target[ax]:10.4f} "
            f"mode={st.mode[ax]} homed={int(st.homed[ax])} endstop={int(st.endstop[ax])} "
            f"driver={'ok' if st.driver_ok[ax] else 'OFFLINE'}"
        )


def cmd_repl(ptz: PTZ):
    print(f"connected: {ptz.version()}  (HELP for commands, Ctrl-D to quit)")
    while True:
        try:
            line = input("ptz> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        try:
            for reply in ptz.command(line):
                print(reply)
            print("ok")
        except PTZError as e:
            print(f"error: {e}")


def cmd_keys(ptz: PTZ):
    """Keyboard jogging. Arrows: pan/tilt. w/s: zoom. a/d: focus.
    Pressing a direction starts the axis; the opposite key stops it.
    1-9 speed (10-90% of vmax), space stops all, h homes, q quits."""
    import curses

    vmax = {ax: ptz.config(ax)[ax]["vmax"] for ax in AXES}
    keymap = {
        curses.KEY_LEFT: ("pan", -1), curses.KEY_RIGHT: ("pan", 1),
        curses.KEY_DOWN: ("tilt", -1), curses.KEY_UP: ("tilt", 1),
        ord("s"): ("zoom", -1), ord("w"): ("zoom", 1),
        ord("a"): ("focus", -1), ord("d"): ("focus", 1),
    }

    def ui(scr):
        curses.curs_set(0)
        scr.timeout(150)
        speed = 0.3
        dirs = {ax: 0 for ax in AXES}
        msg = ""
        while True:
            key = scr.getch()
            try:
                if key == ord("q"):
                    ptz.stop()
                    return
                if key == ord(" "):
                    ptz.stop()
                    dirs = {ax: 0 for ax in AXES}
                elif key == ord("h"):
                    ptz.home()
                elif ord("1") <= key <= ord("9"):
                    speed = (key - ord("0")) / 10
                    for ax, d in dirs.items():
                        if d:
                            ptz.jog(**{ax: d * speed * vmax[ax]})
                elif key in keymap:
                    ax, d = keymap[key]
                    dirs[ax] = 0 if dirs[ax] == -d else d
                    if dirs[ax]:
                        ptz.jog(**{ax: d * speed * vmax[ax]})
                    else:
                        ptz.stop(ax)
                st = ptz.status()
            except PTZError as e:
                msg = str(e)
                continue
            scr.erase()
            scr.addstr(0, 0, "arrows pan/tilt  w/s zoom  a/d focus  1-9 speed  space stop  h home  q quit")
            scr.addstr(1, 0, f"speed {int(speed * 100)}%   drivers {'ENABLED' if st.enabled else 'disabled'}")
            for row, ax in enumerate(AXES, start=3):
                scr.addstr(row, 0, f"{ax:5s} {st.pos[ax]:10.3f}  v={st.vel[ax]:8.3f}  mode={st.mode[ax]}"
                                   f"  homed={int(st.homed[ax])}  driver={'ok' if st.driver_ok[ax] else 'OFFLINE'}")
            scr.addstr(8, 0, msg[:70])

    try:
        curses.wrapper(ui)
    finally:
        ptz.stop()  # never leave an axis jogging, even on Ctrl-C or an error


def cmd_wiggle(ptz: PTZ, axes: list[str], amount: float):
    """Small test move: +amount, -amount, then back to where it started."""
    for ax in axes or ["pan", "tilt"]:
        start = ptz.status().pos[ax]
        for offset in (amount, -amount, 0.0):
            print(f"{ax} -> {start + offset:.2f}")
            ptz.move(**{ax: start + offset})
            ptz.wait_idle()


def main(argv=None):
    p = argparse.ArgumentParser(description="plainsight PTZ controller")
    p.add_argument("--port", help="serial port (default: auto-detect RP2040 on USB)")
    p.add_argument("--baud", type=int, default=115200, help="only matters for the Pi-header UART")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("repl", help="interactive raw command prompt")
    sub.add_parser("keys", help="keyboard jogging")
    sub.add_parser("watch", help="print streamed status and events")
    sp = sub.add_parser("wiggle", help="small back-and-forth test: wiggle pan --amount 5")
    sp.add_argument("axes", nargs="*")
    sp.add_argument("--amount", type=float, default=10.0)
    sub.add_parser("drv", help="TMC2209 diagnostics")
    for name, h in (("move", "absolute: move pan 90 tilt 20"), ("mover", "relative: mover pan -5"),
                    ("jog", "velocity: jog pan 3"), ("setpos", "declare position: setpos pan 0")):
        sp = sub.add_parser(name, help=h)
        sp.add_argument("pairs", nargs="+")
    for name in ("stop", "home"):
        sp = sub.add_parser(name)
        sp.add_argument("axes", nargs="*")
    sp = sub.add_parser("cfg", help="cfg [scope [key value]]")
    sp.add_argument("args", nargs="*")
    sub.add_parser("save")
    sp = sub.add_parser("enable")
    sp.add_argument("on", nargs="?", default="1", choices=("0", "1"))
    a = p.parse_args(argv)

    try:
        ptz = PTZ(a.port, a.baud, on_event=lambda e: print(f"event: {e}"))
    except (PTZError, serial.SerialException) as e:
        sys.exit(f"error: {e} (board powered? with the USB-power jumper removed it needs motor power)")
    with ptz:
        try:
            if a.cmd == "status":
                _print_status(ptz.status())
            elif a.cmd == "repl":
                cmd_repl(ptz)
            elif a.cmd == "keys":
                cmd_keys(ptz)
            elif a.cmd == "watch":
                ptz.on_status = lambda st: print(" ".join(f"{ax}={st.pos[ax]:.3f}" for ax in AXES),
                                                 "mode=" + "".join(st.mode.values()))
                ptz.stream(200)
                try:
                    while True:
                        time.sleep(1)
                except KeyboardInterrupt:
                    ptz.stream(0)
            elif a.cmd == "wiggle":
                try:
                    cmd_wiggle(ptz, a.axes, a.amount)
                except KeyboardInterrupt:
                    ptz.stop()
            elif a.cmd == "drv":
                print("\n".join(ptz.drivers()))
            elif a.cmd == "move":
                ptz.move(**_pairs(a.pairs))
            elif a.cmd == "mover":
                ptz.move_by(**_pairs(a.pairs))
            elif a.cmd == "jog":
                ptz.jog(**_pairs(a.pairs))
            elif a.cmd == "setpos":
                ptz.set_position(**_pairs(a.pairs))
            elif a.cmd == "stop":
                ptz.stop(*a.axes)
            elif a.cmd == "home":
                ptz.home(*a.axes)
            elif a.cmd == "cfg":
                if len(a.args) == 3:
                    ptz.set_config(*a.args)
                else:
                    for scope, keys in ptz.config(" ".join(a.args) or None).items():
                        for k, v in keys.items():
                            print(f"{scope:6s} {k:16s} {v:g}")
            elif a.cmd == "save":
                ptz.save()
            elif a.cmd == "enable":
                ptz.enable(a.on == "1")
        except PTZError as e:
            sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
