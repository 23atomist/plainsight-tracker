"""Environment-variable configuration for the head service (all HEAD_* keys)."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

_TRUE = {"1", "true", "yes"}
_FALSE = {"0", "false", "no"}


def _int(key: str, raw: str) -> int:
    try:
        return int(raw.strip())
    except ValueError:
        raise ValueError(f"{key}: expected an integer, got {raw!r}") from None


def _float(key: str, raw: str) -> float:
    try:
        return float(raw.strip())
    except ValueError:
        raise ValueError(f"{key}: expected a number, got {raw!r}") from None


def _bool(key: str, raw: str) -> bool:
    v = raw.strip().lower()
    if v in _TRUE:
        return True
    if v in _FALSE:
        return False
    raise ValueError(f"{key}: expected one of 1/0/true/false/yes/no, got {raw!r}")


def _choice(*options: str) -> Callable[[str, str], str]:
    def parse(key: str, raw: str) -> str:
        v = raw.strip()
        if v not in options:
            raise ValueError(f"{key}: expected one of {'|'.join(options)}, got {raw!r}")
        return v

    return parse


def _sign(key: str, raw: str) -> int:
    v = _int(key, raw)
    if v not in (-1, 1):
        raise ValueError(f"{key}: expected 1 or -1, got {raw!r}")
    return v


def _str(key: str, raw: str) -> str:
    return raw


def _int_in(lo: int, hi: int) -> Callable[[str, str], int]:
    def parse(key: str, raw: str) -> int:
        v = _int(key, raw)
        if not lo <= v <= hi:
            raise ValueError(f"{key}: expected {lo}..{hi}, got {raw!r}")
        return v

    return parse


@dataclass(frozen=True)
class HeadConfig:
    port: int = 8780
    serial: str = "/dev/ttyACM0"
    baud: int = 115200
    i2c_bus: int | None = None
    imu_address: int | None = None
    auto_home: bool = True
    pan_restore: str = "persisted"
    pan_restore_max_age_s: float = 604800
    ref_tilt_deg: float = 0.0
    ref_timeout_s: float = 120
    imu_heading_offset_deg: float = 0.0
    imu_pitch_offset_deg: float = 0.0
    imu_tilt_axis: str = "pitch"
    imu_tilt_sign: int = 1
    jog_deadman_ms: int = 500
    track_timeout_ms: int = 1000
    stream_ms: int = 100
    data_dir: str = "/data"
    log_level: str = "INFO"

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> HeadConfig:
        parsers: dict[str, Callable[[str, str], Any]] = {
            "port": _int_in(1, 65535),
            "serial": _str,
            "baud": _int,
            "i2c_bus": _int,
            "imu_address": lambda k, r: int(r.strip(), 0) if _is_int(r) else _int(k, r),
            "auto_home": _bool,
            "pan_restore": _choice("persisted", "imu", "none"),
            "pan_restore_max_age_s": _float,
            "ref_tilt_deg": _float,
            "ref_timeout_s": _float,
            "imu_heading_offset_deg": _float,
            "imu_pitch_offset_deg": _float,
            "imu_tilt_axis": _choice("pitch", "roll"),
            "imu_tilt_sign": _sign,
            "jog_deadman_ms": _int_in(100, 10000),
            "track_timeout_ms": _int,
            "stream_ms": _int_in(20, 1000),
            "data_dir": _str,
            "log_level": _str,
        }
        values: dict[str, Any] = {}
        for name, parse in parsers.items():
            key = f"HEAD_{name.upper()}"
            raw = env.get(key, "")
            if raw.strip():  # an empty value (`HEAD_I2C_BUS=`) means unset: the default applies
                values[name] = parse(key, raw)
        return cls(**values)


def _is_int(raw: str) -> bool:
    try:
        int(raw.strip(), 0)
    except ValueError:
        return False
    return True
