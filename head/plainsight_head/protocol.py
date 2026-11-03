"""Pure parsing/formatting for the Pico line protocol. No I/O, no logging."""
from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

AXES: tuple[str, ...] = ("pan", "tilt", "zoom", "focus")

_STATUS_KEYS = ("pos", "vel", "tgt", "mode", "homed", "es", "en", "drv")


class ProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class AxisStatus:
    pos: float
    vel: float
    tgt: float
    mode: str
    homed: bool
    endstop: bool
    driver: bool


@dataclass(frozen=True)
class PicoStatus:
    axes: dict[str, AxisStatus]
    enabled: bool

    @property
    def moving(self) -> bool:
        return any(a.vel != 0 or a.mode == "H" for a in self.axes.values())


@dataclass(frozen=True)
class PicoEvent:
    name: str
    axis: str | None
    detail: str | None


def _floats(key: str, text: str) -> list[float]:
    parts = text.split(",")
    if len(parts) != len(AXES):
        raise ProtocolError(f"{key}: expected {len(AXES)} fields, got {len(parts)}")
    try:
        return [float(p) for p in parts]
    except ValueError as exc:
        raise ProtocolError(f"{key}: bad number in {text!r}") from exc


def _flags(key: str, text: str) -> list[str]:
    if len(text) != len(AXES):
        raise ProtocolError(f"{key}: expected {len(AXES)} characters, got {len(text)}")
    return list(text)


def parse_status(payload: str) -> PicoStatus:
    kv: dict[str, str] = {}
    for token in payload.split():
        key, sep, value = token.partition("=")
        if sep:
            kv[key] = value
    missing = [k for k in _STATUS_KEYS if not kv.get(k)]
    if missing:
        raise ProtocolError(f"status missing keys: {', '.join(missing)}")
    pos, vel, tgt = (_floats(k, kv[k]) for k in ("pos", "vel", "tgt"))
    mode, homed, es, drv = (_flags(k, kv[k]) for k in ("mode", "homed", "es", "drv"))
    axes = {
        ax: AxisStatus(
            pos=pos[i], vel=vel[i], tgt=tgt[i], mode=mode[i],
            homed=homed[i] == "1", endstop=es[i] == "1", driver=drv[i] == "1",
        )
        for i, ax in enumerate(AXES)
    }
    return PicoStatus(axes=axes, enabled=kv["en"] == "1")


def parse_event(payload: str) -> PicoEvent:
    tokens = payload.split()
    if not tokens:
        raise ProtocolError("empty event")
    name, rest = tokens[0], tokens[1:]
    axis = None
    if rest and rest[0] in AXES:
        axis, rest = rest[0], rest[1:]
    return PicoEvent(name, axis, " ".join(rest) or None)


def parse_cfg_lines(lines: list[str]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for line in lines:
        parts = line.split()
        if len(parts) != 4 or parts[0] != "C":
            raise ProtocolError(f"bad config line: {line!r}")
        try:
            out.setdefault(parts[1], {})[parts[2]] = float(parts[3])
        except ValueError as exc:
            raise ProtocolError(f"bad config value: {line!r}") from exc
    return out


def parse_drv_lines(lines: list[str]) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for line in lines:
        parts = line.split()
        if len(parts) < 2 or parts[0] != "D":
            raise ProtocolError(f"bad driver line: {line!r}")
        fields: dict[str, str] = {}
        for token in parts[2:]:
            key, sep, value = token.partition("=")
            if not sep:
                raise ProtocolError(f"bad driver field {token!r} in {line!r}")
            fields[key] = value
        out[parts[1]] = fields
    return out


# Copied from plainsight/host/ptz.py::_axes_args (raises ProtocolError, rejects non-finite).
def fmt_axes(values: Mapping[str, float | tuple[float, float]]) -> str:
    parts = []
    for ax, v in values.items():
        if ax not in AXES:
            raise ProtocolError(f"unknown axis {ax!r}")
        vals = v if isinstance(v, (tuple, list)) else (v,)
        if not all(math.isfinite(x) for x in vals):
            raise ProtocolError(f"non-finite value for {ax}: {v!r}")
        parts.append(ax + "".join(f" {float(x):.5f}" for x in vals))
    if not parts:
        raise ProtocolError("no axes given")
    return " ".join(parts)


def classify_line(line: str) -> tuple[str, str]:
    if line.startswith("*S "):
        return "status", line[3:]
    if line.startswith("*E "):
        return "event", line[3:]
    return "reply", line
