"""Bounded logging for a resource that stays down: one line on the way down, a summary a minute."""
from __future__ import annotations

import logging
import time
from collections.abc import Callable

SUMMARY_S = 60.0


class OutageLog:
    """Turns a stream of per-attempt failures into a few log lines.

    The first failure after a healthy spell logs one WARNING. Later failures are counted and
    logged as one WARNING summary per `summary_s` while the outage lasts. `recovered()` logs
    one INFO line and re-arms the first-failure warning.
    """

    def __init__(self, logger: logging.Logger, what: str, *, summary_s: float = SUMMARY_S,
                 time_fn: Callable[[], float] = time.monotonic) -> None:
        self._log, self._what = logger, what
        self._summary_s, self._time = summary_s, time_fn
        self._since: float | None = None
        self._last_summary = 0.0
        self._failures = 0
        self._last_reason = ""

    @property
    def down(self) -> bool:
        return self._since is not None

    def failure(self, reason: str) -> None:
        now = self._time()
        self._last_reason = reason
        if self._since is None:
            self._since, self._last_summary, self._failures = now, now, 1
            self._log.warning("%s down: %s", self._what, reason)
            return
        self._failures += 1
        if now - self._last_summary >= self._summary_s:
            self._last_summary = now
            self._log.warning("%s still down after %.0f s (%d failures; last: %s)",
                              self._what, now - self._since, self._failures, reason)
        else:
            self._log.debug("%s still down: %s", self._what, reason)

    def recovered(self) -> None:
        if self._since is None:
            return
        self._log.info("%s back after %.0f s (%d failures)", self._what,
                       self._time() - self._since, self._failures)
        self._since = None
