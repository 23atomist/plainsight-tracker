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
from .protocol import AxisStatus, PicoStatus, fmt_axes
from .state import EstopLatched, HeadState, PanRef, guard_head_motion

log = logging.getLogger(__name__)

REF_FILE = "pan-reference.json"
HEADING_WINDOW_S = 2.0
PERSIST_INTERVAL_S = 5.0
PERSIST_REFRESH_S = 3600.0  # rewrite while referenced even if pan has not moved (spec 5.4 freshness)
POLL_S = 0.05
SETTLE_CAP_S = 30.0
SETTLE_TOL_DEG = 0.5
STILL_TOL_DEG = 0.05  # pan/tilt drift allowed across the heading window
STATUS_WAIT_S = 3.0
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
                 heading_window_s: float = HEADING_WINDOW_S, settle_cap_s: float = SETTLE_CAP_S,
                 status_wait_s: float = STATUS_WAIT_S) -> None:
        self._cfg, self._pico, self._imu, self._state, self._store = cfg, pico, imu, state, store
        self._time, self._sleep, self._on_event = time_fn, sleep, on_event
        self._window_s, self._settle_cap_s, self._status_wait_s = heading_window_s, settle_cap_s, status_wait_s
        self._lock = asyncio.Lock()
        self._busy = False
        self._last_written: float | None = None
        self._last_write_t: float | None = None  # the `t` stored in the file as last written
        self._setpos_status: PicoStatus | None = None  # state.pico when the last SETPOS returned
        self._setpos_count = 0  # successful SETPOS pan; lets a queued restore see it was overtaken
        self._pan_homed: bool | None = None

    @property
    def busy(self) -> bool:
        """True while an IMU north reference is running."""
        return self._busy

    def on_status(self, st: PicoStatus) -> None:
        """Feed every Pico status; drops the reference when pan loses its homed flag."""
        homed = st.axes["pan"].homed
        was, self._pan_homed = self._pan_homed, homed
        if was and not homed and self._state.ref.source != "none":
            log.warning("pan lost its homed flag; pan reference cleared")
            self._state.set_ref(PanRef("none"))
            self._dropped("pan unhomed")

    # --- boot -----------------------------------------------------------
    async def restore_at_boot(self) -> ReferenceResult:
        if self._state.pico is None and not await self._poll(self._status_wait_s, self._has_status):
            log.warning("pan reference: no Pico status within %ss; pan left unreferenced", self._status_wait_s)
            return ReferenceResult("none", None, "no pico status")
        saved = self._read_file()
        pan = self._state.pico.axes["pan"]
        if pan.homed:
            return self._keep_pico_position(pan.pos, saved)
        cfg = self._cfg
        if cfg.pan_restore == "persisted" and self._fresh(saved):
            return await self._restore_saved(saved)
        if cfg.pan_restore in ("persisted", "imu"):
            return await self.reference_from_imu(cfg.ref_timeout_s)
        log.info("pan reference: HEAD_PAN_RESTORE=none; pan left unreferenced")
        return ReferenceResult("none", None, "pan_restore=none")

    def _keep_pico_position(self, pos: float, saved: dict | None) -> ReferenceResult:
        source = saved["source"] if saved is not None else "host"
        if saved is not None:
            self._last_written, self._last_write_t = saved["pos"], saved["t"]
        self._state.set_ref(PanRef(source, saved is not None, self._time()))
        log.info("pan reference: Pico still homed at %.3f; keeping source %s", pos, source)
        return ReferenceResult(source, pos, None)

    def _fresh(self, saved: dict | None) -> bool:
        return saved is not None and self._time() - saved["t"] <= self._cfg.pan_restore_max_age_s

    async def restore_after_reconnect(self) -> ReferenceResult:
        """Spec 6.8 rule 2 only, after the Pico link came back (never IMU north: no motion).

        Call it once `state.pico` holds a status read after the reconnect. If the Pico kept pan
        homed (a USB glitch, not a reboot) nothing changes. If pan came back unhomed, restore
        the persisted position when the file is fresh; otherwise pan stays unreferenced.

        It may wait behind an IMU north run for the reference lock, so the decision is made
        inside the lock: if any SETPOS pan landed while it waited, that newer reference wins.
        """
        setpos_count = self._setpos_count
        async with self._lock:
            if self._setpos_count != setpos_count:
                log.info("pan reference: set while the reconnect restore waited; keeping it")
                return ReferenceResult(self._state.ref.source, None, "referenced meanwhile")
            return await self._restore_after_reconnect_locked()

    async def _restore_after_reconnect_locked(self) -> ReferenceResult:
        pico = self._state.pico
        if pico is None:
            return ReferenceResult("none", None, "no pico status")
        pan = pico.axes["pan"]
        if pan.homed:
            return ReferenceResult(self._state.ref.source, pan.pos, None)
        if self._cfg.pan_restore != "persisted":
            log.info("pan reference: Pico reconnected with pan unhomed; HEAD_PAN_RESTORE=%s, "
                     "pan left unreferenced", self._cfg.pan_restore)
            return ReferenceResult("none", None, f"pan_restore={self._cfg.pan_restore}")
        saved = self._read_file()
        if not self._fresh(saved):
            log.warning("pan reference: Pico reconnected with pan unhomed and no fresh %s; "
                        "pan left unreferenced", REF_FILE)
            return ReferenceResult("none", None, "no fresh persisted reference")
        log.info("pan reference: Pico reconnected with pan unhomed; restoring the persisted position")
        return await self._apply_saved(saved)

    async def _restore_saved(self, saved: dict) -> ReferenceResult:
        async with self._lock:
            return await self._apply_saved(saved)

    async def _apply_saved(self, saved: dict) -> ReferenceResult:
        """SETPOS pan to the persisted position; the caller holds the reference lock."""
        pos, source = saved["pos"], saved["source"]
        try:
            previous = await self._setpos(pos)
        except PicoError as exc:
            reason = f"pico: {exc.reason}"
            log.warning("pan reference: restoring persisted pan %.3f failed: %s", pos, exc.reason)
            self._failed(reason)
            return ReferenceResult("none", None, reason)
        self._last_written, self._last_write_t = pos, saved["t"]
        self._state.set_ref(PanRef(source, True, self._time()))
        log.info("pan reference: restored persisted pan %.3f (source %s)", pos, source)
        self._changed(source, pos, previous)
        return ReferenceResult(source, pos, None)

    # --- events (spec 6.8) ------------------------------------------------
    def _changed(self, source: str, pan: float, previous: float | None) -> None:
        """Pan was renamed: old and new value for the same physical position (rule 1)."""
        self._on_event("pan_reference", {"source": source, "pan": pan, "previous": previous})

    def _dropped(self, reason: str) -> None:
        """The reference is gone (rule 2): the host must stop automated motion."""
        self._on_event("pan_reference", {"source": "none", "reason": reason})

    def _failed(self, reason: str) -> None:
        """An attempt to set the reference failed; the current reference is unchanged."""
        self._on_event("pan_reference_failed", {"reason": reason, "source": self._state.ref.source})

    # --- IMU north --------------------------------------------------------
    async def reference_from_imu(self, timeout_s: float) -> ReferenceResult:
        async with self._lock:
            self._busy = True
            try:
                try:
                    reason, pan, previous = await self._imu_north(timeout_s)
                except PicoError as exc:
                    reason, pan, previous = f"pico: {exc.reason}", None, None
            finally:
                self._busy = False
            if reason is not None:
                log.warning("pan reference from IMU failed: %s", reason)
                self._failed(reason)
                return ReferenceResult("none", None, reason)
            persisted = self._write(pan, "imu")
            self._state.set_ref(PanRef("imu", persisted, self._time()))
            log.info("pan reference from IMU: pan %s -> %.3f", previous, pan)
            self._changed("imu", pan, previous)
            return ReferenceResult("imu", pan, None)

    async def _imu_north(self, timeout_s: float) -> tuple[str | None, float | None, float | None]:
        """Returns (failure reason, None, None) or (None, pan, previous) after SETPOS succeeded."""
        pico = self._state.pico
        if pico is None:
            return "no pico status", None, None
        if not pico.axes["tilt"].homed:
            return "tilt not homed", None, None
        try:
            guard_head_motion(self._state)
        except EstopLatched:
            return "estop latched", None, None
        await self._pico.command("MOVE " + fmt_axes({"tilt": self._cfg.ref_tilt_deg}))
        before = self._state.pico
        settled = await self._poll(self._settle_cap_s,
                                   lambda: self._state.estop or self._settled(before))
        if self._state.estop:
            return "estop latched", None, None
        if not settled:
            return "tilt did not settle", None, None
        if not await self._poll(timeout_s, self._imu_ready):
            return "imu calibration timeout", None, None
        window_start = self._state.pico
        headings = await self._collect_headings()
        if not headings:
            return "imu lost during heading average", None, None
        if not self._held_still(window_start, self._state.pico):
            return "head moved during reference", None, None
        pan = wrap180(circular_mean_deg(headings) - self._cfg.imu_heading_offset_deg)
        previous = await self._setpos(pan)
        return None, pan, previous

    async def _poll(self, timeout_s: float, cond: Callable[[], bool]) -> bool:
        for _ in range(max(1, math.ceil(timeout_s / POLL_S))):
            if cond():
                return True
            await self._sleep(POLL_S)
        return cond()

    def _has_status(self) -> bool:
        return self._state.pico is not None

    def _settled(self, before: PicoStatus | None) -> bool:
        """A status newer than the MOVE, nothing moving, tilt at the reference angle."""
        st = self._state.pico
        return (st is not before and st is not None and not st.moving
                and abs(st.axes["tilt"].pos - self._cfg.ref_tilt_deg) <= SETTLE_TOL_DEG)

    @staticmethod
    def _held_still(start: PicoStatus | None, end: PicoStatus | None) -> bool:
        """A status arrived during the heading window and pan and tilt did not move across it."""
        if start is None or end is None or end is start or end.moving:
            return False
        return all(abs(end.axes[ax].pos - start.axes[ax].pos) <= STILL_TOL_DEG for ax in ("pan", "tilt"))

    def _imu_ready(self) -> bool:
        s = self._imu.latest
        return self._imu.ok and s is not None and s.cal[3] >= _MIN_CAL and s.cal[0] >= _MIN_CAL

    async def _collect_headings(self) -> list[float]:
        headings: list[float] = []
        for _ in range(max(1, round(self._window_s / POLL_S))):
            s = self._imu.latest
            if self._imu.ok and s is not None:
                headings.append(s.heading)
            await self._sleep(POLL_S)
        return headings

    async def _setpos(self, pan: float) -> float | None:
        """SETPOS pan; returns pan's position before it, or None if pan had no frame to rename.

        `previous` is None when no status is known or pan was not homed: an unhomed Pico's
        position is its power-on count, not a pan value the host could shift from.
        """
        pico = self._state.pico
        previous = pico.axes["pan"].pos if pico is not None and pico.axes["pan"].homed else None
        await self._pico.command("SETPOS " + fmt_axes({"pan": pan}))
        self._setpos_status = self._state.pico
        self._setpos_count += 1
        return previous

    # --- host ---------------------------------------------------------------
    async def set_from_host(self, pan: float) -> None:
        """SETPOS pan from the host. PicoError and ProtocolError propagate to the caller."""
        async with self._lock:
            previous = await self._setpos(pan)
            persisted = self._write(pan, "host")
            self._state.set_ref(PanRef("host", persisted, self._time()))
            log.info("pan reference from host: pan %s -> %.3f", previous, pan)
            self._changed("host", pan, previous)

    def note_enable_off(self) -> None:
        if self._state.ref.source == "none":
            return
        log.info("drivers disabled: pan reference cleared")
        self._state.set_ref(PanRef("none"))
        self._dropped("enable off")

    # --- persistence ----------------------------------------------------------
    async def run_persistence(self) -> None:
        while True:
            await self._sleep(PERSIST_INTERVAL_S)
            pan = self._persistable_pan()
            if pan is not None and pan.vel == 0 and (pan.pos != self._last_written or self._stale()):
                self._write(pan.pos, self._state.ref.source)

    def _stale(self) -> bool:
        """The file's age is measured from the last known-good write: refresh it hourly."""
        return self._last_write_t is None or self._time() - self._last_write_t >= PERSIST_REFRESH_S

    async def persist_now(self) -> None:
        pan = self._persistable_pan()
        if pan is not None:
            self._write(pan.pos, self._state.ref.source)

    def _persistable_pan(self) -> AxisStatus | None:
        """Pan's status if it is referenced, homed, and reported since the last SETPOS."""
        pico = self._state.pico
        if pico is None or pico is self._setpos_status or self._state.ref.source == "none":
            return None
        pan = pico.axes["pan"]
        return pan if pan.homed else None

    def _write(self, pos: float, source: str) -> bool:
        try:
            t = self._time()
            self._store.write(REF_FILE, {"pos": pos, "source": source, "t": t})
        except OSError:
            log.exception("writing %s failed", REF_FILE)
            return False
        self._last_written, self._last_write_t = pos, t
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
