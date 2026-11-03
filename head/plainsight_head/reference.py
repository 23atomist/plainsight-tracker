"""Pan reference: restore at boot, IMU north, host SETPOS, and the persisted position (spec 5.3, 5.4)."""
from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, replace
from typing import Any

from .config import HeadConfig
from .imu import ImuReader
from .persist import JsonStore
from .pico import PicoError, PicoLink
from .protocol import fmt_axes
from .state import HeadState, PanRef

log = logging.getLogger(__name__)

REF_FILE = "pan-reference.json"
HEADING_WINDOW_S = 2.0
PERSIST_INTERVAL_S = 5.0
POLL_S = 0.05
SETTLE_CAP_S = 30.0
_SOURCES = ("host", "imu")
_MIN_CAL = 2  # BNO055 calibration level needed for mag and sys


def circular_mean_deg(values: Iterable[float]) -> float:
    """Circular mean in [0, 360). Raises ValueError on an empty input."""
    rads = [math.radians(v) for v in values]
    if not rads:
        raise ValueError("circular mean of no values")
    mean = math.degrees(math.atan2(sum(map(math.sin, rads)), sum(map(math.cos, rads))))
    return round(mean, 9) % 360.0  # rounding keeps -1e-15 from becoming 360.0


def wrap180(deg: float) -> float:
    """Wrap to (-180, 180]."""
    r = (deg + 180.0) % 360.0 - 180.0
    return 180.0 if r == -180.0 else r


@dataclass(frozen=True)
class ReferenceResult:
    source: str  # none | imu | host
    pan: float | None
    reason: str | None


class PanReference:
    def __init__(self, cfg: HeadConfig, pico: PicoLink, imu: ImuReader, state: HeadState,
                 store: JsonStore, *, time_fn: Callable[[], float] = time.time,
                 sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
                 on_event: Callable[[str, dict], None],
                 heading_window_s: float = HEADING_WINDOW_S) -> None:
        self._cfg, self._pico, self._imu, self._state, self._store = cfg, pico, imu, state, store
        self._time, self._sleep, self._on_event = time_fn, sleep, on_event
        self._window_s = heading_window_s
        self._last_written: float | None = None

    # --- boot -----------------------------------------------------------
    async def restore_at_boot(self) -> ReferenceResult:
        saved = self._read_file()
        pico = self._state.pico
        if pico is not None and pico.axes["pan"].homed:
            return self._keep_pico_position(pico.axes["pan"].pos, saved)
        cfg = self._cfg
        if cfg.pan_restore == "persisted" and saved is not None \
                and self._time() - saved["t"] <= cfg.pan_restore_max_age_s:
            return await self._restore_saved(saved)
        if cfg.pan_restore in ("persisted", "imu"):
            return await self.reference_from_imu(cfg.ref_timeout_s)
        log.info("pan reference: HEAD_PAN_RESTORE=none; pan left unreferenced")
        return ReferenceResult("none", None, "pan_restore=none")

    def _keep_pico_position(self, pos: float, saved: dict | None) -> ReferenceResult:
        source = saved["source"] if saved is not None else "host"
        if saved is not None:
            self._last_written = saved["pos"]
        self._state.set_ref(PanRef(source, saved is not None, self._time()))
        log.info("pan reference: Pico still homed at %.3f; keeping source %s", pos, source)
        return ReferenceResult(source, pos, None)

    async def _restore_saved(self, saved: dict) -> ReferenceResult:
        pos, source = saved["pos"], saved["source"]
        try:
            await self._pico.command("SETPOS " + fmt_axes({"pan": pos}))
        except PicoError as exc:
            log.warning("pan reference: restoring persisted pan %.3f failed: %s", pos, exc.reason)
            return ReferenceResult("none", None, f"pico: {exc.reason}")
        self._last_written = pos
        self._state.set_ref(PanRef(source, True, self._time()))
        log.info("pan reference: restored persisted pan %.3f (source %s)", pos, source)
        return ReferenceResult(source, pos, None)

    # --- IMU north --------------------------------------------------------
    async def reference_from_imu(self, timeout_s: float) -> ReferenceResult:
        try:
            reason, pan = await self._imu_north(timeout_s)
        except PicoError as exc:
            reason, pan = f"pico: {exc.reason}", None
        if reason is not None:
            log.warning("pan reference from IMU failed: %s", reason)
            self._on_event("pan_reference", {"source": "none", "reason": reason})
            return ReferenceResult("none", None, reason)
        persisted = self._write(pan, "imu")
        self._state.set_ref(PanRef("imu", persisted, self._time()))
        log.info("pan reference from IMU: pan set to %.3f", pan)
        self._on_event("pan_reference", {"source": "imu", "pan": pan})
        return ReferenceResult("imu", pan, None)

    async def _imu_north(self, timeout_s: float) -> tuple[str | None, float | None]:
        """Returns (failure reason, None) or (None, pan) after SETPOS succeeded."""
        pico = self._state.pico
        if pico is None or not pico.axes["tilt"].homed:
            return "tilt not homed", None
        await self._pico.command("MOVE " + fmt_axes({"tilt": self._cfg.ref_tilt_deg}))
        if not await self._wait_settled():
            return "tilt did not settle", None
        if not await self._wait_imu_ready(timeout_s):
            return "imu calibration timeout", None
        headings = await self._collect_headings()
        if not headings:
            return "imu lost during heading average", None
        pan = wrap180(circular_mean_deg(headings) - self._cfg.imu_heading_offset_deg)
        await self._pico.command("SETPOS " + fmt_axes({"pan": pan}))
        return None, pan

    async def _wait_settled(self) -> bool:
        """True once a status newer than the MOVE reports nothing moving (30 s cap)."""
        before = self._state.pico
        for _ in range(math.ceil(SETTLE_CAP_S / POLL_S)):
            st = self._state.pico
            if st is not before and st is not None and not st.moving:
                return True
            await self._sleep(POLL_S)
        return False

    def _imu_ready(self) -> bool:
        s = self._imu.latest
        return self._imu.ok and s is not None and s.cal[3] >= _MIN_CAL and s.cal[0] >= _MIN_CAL

    async def _wait_imu_ready(self, timeout_s: float) -> bool:
        for _ in range(max(1, math.ceil(timeout_s / POLL_S))):
            if self._imu_ready():
                return True
            await self._sleep(POLL_S)
        return self._imu_ready()

    async def _collect_headings(self) -> list[float]:
        headings: list[float] = []
        for _ in range(max(1, round(self._window_s / POLL_S))):
            s = self._imu.latest
            if self._imu.ok and s is not None:
                headings.append(s.heading)
            await self._sleep(POLL_S)
        return headings

    # --- host ---------------------------------------------------------------
    async def set_from_host(self, pan: float) -> None:
        """SETPOS pan from the host. PicoError and ProtocolError propagate to the caller."""
        pico = self._state.pico
        previous = pico.axes["pan"].pos if pico is not None else None
        await self._pico.command("SETPOS " + fmt_axes({"pan": pan}))
        persisted = self._write(pan, "host")
        self._state.set_ref(PanRef("host", persisted, self._time()))
        log.info("pan reference from host: pan %s -> %.3f", previous, pan)
        self._on_event("pan_reference", {"source": "host", "pan": pan, "previous": previous})

    def note_enable_off(self) -> None:
        log.info("drivers disabled: pan reference cleared")
        self._state.set_ref(PanRef("none"))

    # --- persistence ----------------------------------------------------------
    async def run_persistence(self) -> None:
        while True:
            await self._sleep(PERSIST_INTERVAL_S)
            pico = self._state.pico
            if pico is None or self._state.ref.source == "none":
                continue
            pan = pico.axes["pan"]
            if pan.vel == 0 and pan.pos != self._last_written:
                self._write(pan.pos, self._state.ref.source)

    async def persist_now(self) -> None:
        pico = self._state.pico
        if pico is not None and self._state.ref.source != "none":
            self._write(pico.axes["pan"].pos, self._state.ref.source)

    def _write(self, pos: float, source: str) -> bool:
        try:
            self._store.write(REF_FILE, {"pos": pos, "source": source, "t": self._time()})
        except OSError:
            log.exception("writing %s failed", REF_FILE)
            return False
        self._last_written = pos
        ref = self._state.ref
        if ref.source == source and not ref.persisted:
            self._state.set_ref(replace(ref, persisted=True))
        return True

    def _read_file(self) -> dict | None:
        saved = self._store.read(REF_FILE)
        if saved is None:
            return None
        if not isinstance(saved, dict):
            log.warning("%s: ignoring non-object contents %r", REF_FILE, saved)
            return None
        pos, t, source = saved.get("pos"), saved.get("t"), saved.get("source")
        ok = (all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                  for v in (pos, t)) and source in _SOURCES)
        if not ok:
            log.warning("%s: ignoring malformed contents %r", REF_FILE, saved)
            return None
        return {"pos": float(pos), "t": float(t), "source": source}
