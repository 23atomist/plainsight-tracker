"""Latest head state and the telemetry tick assembled from it."""
from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .config import HeadConfig
from .imu import ImuSample
from .protocol import AXES, PicoStatus

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class PanRef:
    source: str = "none"  # none | imu | host
    persisted: bool = False
    set_at: float | None = None


class HeadState:
    def __init__(self, cfg: HeadConfig, time_fn: Callable[[], float] = time.time) -> None:
        self._cfg = cfg
        self._time = time_fn
        self._subs: list[Callable[[dict], None]] = []
        self.pico: PicoStatus | None = None
        self.imu: ImuSample | None = None
        self.pico_link = False
        self.imu_link = False
        self.estop = False
        self.ref = PanRef()
        self.seq = 0

    def on_pico_status(self, st: PicoStatus) -> None:
        self.pico = st
        self._publish()

    def on_imu(self, sample: ImuSample) -> None:
        self.imu = sample

    def set_pico_link(self, up: bool) -> None:
        self.pico_link = up

    def set_imu_link(self, up: bool) -> None:
        self.imu_link = up

    def set_estop(self, on: bool) -> None:
        self.estop = on

    def set_ref(self, ref: PanRef) -> None:
        self.ref = ref

    def publish_imu_only(self) -> None:
        self._publish()

    def subscribe(self, cb: Callable[[dict], None]) -> Callable[[], None]:
        self._subs.append(cb)

        def unsubscribe() -> None:
            if cb in self._subs:
                self._subs.remove(cb)

        return unsubscribe

    def tilt_disagree_deg(self) -> float | None:
        if not (self.imu_link and self.imu and self.pico_link and self.pico):
            return None
        cfg = self._cfg
        value = getattr(self.imu, cfg.imu_tilt_axis)
        diff = cfg.imu_tilt_sign * (value - cfg.imu_pitch_offset_deg) - self.pico.axes["tilt"].pos
        return round(diff, 3)

    def tick(self) -> dict[str, Any]:
        now = self._time()
        out: dict[str, Any] = {"type": "tick", "t": int(now * 1000), "seq": self.seq}
        if self.pico_link and self.pico is not None:
            out["axes"] = {
                ax: {
                    "pos": a.pos, "vel": a.vel, "tgt": a.tgt, "mode": a.mode,
                    "homed": a.homed, "endstop": a.endstop, "driver": a.driver,
                }
                for ax, a in ((ax, self.pico.axes[ax]) for ax in AXES)
            }
            out["enabled"] = self.pico.enabled
            out["moving"] = self.pico.moving
        out["estop"] = self.estop
        out["imu"] = self._imu_obj()
        out["tiltDisagreeDeg"] = self.tilt_disagree_deg()
        age = None if self.ref.set_at is None else round(now - self.ref.set_at, 1)
        out["ref"] = {"pan": self.ref.source, "persisted": self.ref.persisted, "ageS": age}
        out["link"] = {"pico": self.pico_link, "imu": self.imu_link}
        return out

    def _imu_obj(self) -> dict[str, Any]:
        s = self.imu
        if not self.imu_link or s is None:
            return {"ok": False, "heading": None, "pitch": None, "roll": None, "cal": None, "tempC": None}
        sys_, gyr, acc, mag = s.cal
        return {
            "ok": True, "heading": s.heading, "pitch": s.pitch, "roll": s.roll,
            "cal": {"sys": sys_, "gyr": gyr, "acc": acc, "mag": mag}, "tempC": s.temp_c,
        }

    def publish_event(self, name: str, axis: str | None = None,
                      detail: dict | str | None = None) -> None:
        """Deliver an event to the tick subscribers (does not advance `seq`)."""
        self._deliver({"type": "event", "t": int(self._time() * 1000),
                       "name": name, "axis": axis, "detail": detail})

    def _publish(self) -> None:
        self.seq += 1
        self._deliver(self.tick())

    def _deliver(self, msg: dict[str, Any]) -> None:
        for cb in list(self._subs):
            try:
                cb(msg)
            except Exception:
                log.exception("%s subscriber failed", msg["type"])
