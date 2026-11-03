"""Per-axis jog dead-man: stop an axis whose jog command stopped being refreshed."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Iterable

from plainsight_head.pico import PicoError
from plainsight_head.protocol import AXES

log = logging.getLogger(__name__)


class JogDeadman:
    def __init__(
        self,
        timeout_ms: int,
        stop_axes: Callable[[list[str]], Awaitable[None]],
        *,
        time_fn: Callable[[], float] = time.monotonic,
        poll_s: float = 0.05,
    ) -> None:
        self._timeout_s = timeout_ms / 1000.0
        self._stop_axes = stop_axes
        self._time = time_fn
        self._poll_s = poll_s
        self._last_touch: dict[str, float] = {}
        self._task: asyncio.Task | None = None
        self._failure: str | None = None  # the last logged stop failure; None while stops work

    @property
    def armed(self) -> set[str]:
        return set(self._last_touch)

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def close(self) -> None:
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def touch(self, axis: str) -> None:
        if axis not in AXES:
            raise ValueError(f"unknown axis: {axis!r}")
        self._last_touch[axis] = self._time()

    def clear(self, axis: str | None = None) -> None:
        if axis is None:
            self._last_touch.clear()
        else:
            self._last_touch.pop(axis, None)

    def snapshot(self) -> dict[str, float]:
        """The arm times now; pass to `clear_unchanged` after a command that supersedes a jog."""
        return dict(self._last_touch)

    def clear_unchanged(self, snap: dict[str, float], axes: Iterable[str]) -> None:
        """Disarm `axes` unless a jog re-armed them since `snap` (that jog was sent later)."""
        for axis in axes:
            if axis in self._last_touch and self._last_touch[axis] == snap.get(axis):
                del self._last_touch[axis]

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self._poll_s)
            now = self._time()
            stale = {a: t for a, t in self._last_touch.items() if now - t >= self._timeout_s}
            expired = list(stale)
            if not expired:
                continue
            try:
                await self._stop_axes(expired)
            except Exception as exc:
                self._note_failure(expired, exc)
                continue
            if self._failure is not None:
                log.warning("jog dead-man: STOP %s went through after failing", " ".join(expired))
                self._failure = None
            for axis in expired:
                if self._last_touch.get(axis) == stale[axis]:  # not re-touched meanwhile
                    del self._last_touch[axis]

    def _note_failure(self, axes: list[str], exc: Exception) -> None:
        """Log a failing stop once per change of failure, not once per poll; the axes stay armed."""
        failure = f"{type(exc).__name__}: {exc}"
        if failure == self._failure:
            return
        self._failure = failure
        log.warning("jog dead-man: STOP %s failed (%s); retrying every %.0f ms until it goes through",
                    " ".join(axes), failure, self._poll_s * 1000, exc_info=not _expected(exc))


def _expected(exc: Exception) -> bool:
    """Pico refusals and link loss need no traceback; anything else does."""
    return isinstance(exc, PicoError)
