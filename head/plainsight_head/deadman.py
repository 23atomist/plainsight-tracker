"""Per-axis jog dead-man: stop an axis whose jog command stopped being refreshed."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

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
            except Exception:
                log.exception("jog dead-man stop failed for %s; will retry", expired)
                continue
            for axis in expired:
                if self._last_touch.get(axis) == stale[axis]:  # not re-touched meanwhile
                    del self._last_touch[axis]
