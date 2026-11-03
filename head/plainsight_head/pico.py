"""Serial transport to the Pico: reader thread, command/reply, link supervision."""
from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Awaitable, Callable
from typing import Any

from .protocol import PicoEvent, PicoStatus, ProtocolError, classify_line, parse_event, parse_status

log = logging.getLogger(__name__)

_TICK_MAX_S = 0.05
_READ_CHUNK = 256


class PicoError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class PicoTimeout(PicoError):
    pass


def _pyserial_factory(port: str, baud: int) -> Any:
    import serial  # imported lazily so tests never need a real port

    return serial.Serial(port, baud, timeout=0.1)


class PicoLink:
    def __init__(
        self,
        port: str,
        baud: int,
        *,
        on_status: Callable[[PicoStatus], None],
        on_event: Callable[[PicoEvent], None],
        on_link: Callable[[bool], None],
        on_reconnect: Callable[[], Awaitable[None]] | None = None,
        serial_factory: Callable[[str, int], Any] = _pyserial_factory,
        stale_s: float = 2.0,
        reconnect_s: float = 1.0,
    ) -> None:
        self._port, self._baud = port, baud
        self._on_status, self._on_event, self._on_link = on_status, on_event, on_link
        self._on_reconnect = on_reconnect
        self._factory = serial_factory
        self._stale_s, self._reconnect_s = stale_s, reconnect_s
        self.expect_stream = False
        self.connected = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._replies: asyncio.Queue[str] = asyncio.Queue()
        self._cmd_lock = asyncio.Lock()
        self._serial: Any = None
        self._thread: threading.Thread | None = None
        self._stop: threading.Event | None = None
        self._gen = 0
        self._reader_died = False
        self._needs_reopen = False
        self._last_status = 0.0
        self._down_at = 0.0
        self._next_try = 0.0
        self._supervisor: asyncio.Task | None = None

    # --- lifecycle ----------------------------------------------------------
    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._serial = await asyncio.to_thread(self._factory, self._port, self._baud)
        self._begin_reading()
        self.connected = True
        self._on_link(True)
        self._supervisor = asyncio.create_task(self._supervise(), name="pico-supervisor")

    async def close(self) -> None:
        if self._supervisor is not None:
            self._supervisor.cancel()
            await asyncio.gather(self._supervisor, return_exceptions=True)
            self._supervisor = None
        self.connected = False
        await asyncio.to_thread(self._end_reading)

    # --- reader thread ------------------------------------------------------
    def _begin_reading(self) -> None:
        self._gen += 1
        self._reader_died = False
        self._last_status = self._loop.time()
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._read_loop, args=(self._serial, self._stop, self._gen),
            name="pico-reader", daemon=True)
        self._thread.start()

    def _end_reading(self) -> None:
        if self._stop is not None:
            self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            if self._thread.is_alive():
                log.warning("pico reader thread did not stop in time")
            self._thread = None
        if self._serial is not None:
            try:
                self._serial.close()
            except OSError:
                log.warning("error closing serial port", exc_info=True)
            self._serial = None

    def _post(self, fn: Callable[..., None], *args: Any) -> None:
        try:
            self._loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:
            log.debug("event loop closed; dropping %s", getattr(fn, "__name__", fn))

    def _read_loop(self, ser: Any, stop: threading.Event, gen: int) -> None:
        buf = bytearray()
        while not stop.is_set():
            try:
                chunk = ser.read(_READ_CHUNK)
            except OSError:
                log.warning("pico serial read failed", exc_info=True)
                self._post(self._reader_failed, gen)
                return
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, _, rest = bytes(buf).partition(b"\n")
                buf = bytearray(rest)
                line = raw.decode("utf-8", errors="replace").strip()
                if line:
                    self._dispatch_line(line, gen)

    def _dispatch_line(self, line: str, gen: int) -> None:
        kind, payload = classify_line(line)
        try:
            if kind == "status":
                self._post(self._deliver_status, gen, parse_status(payload))
            elif kind == "event":
                self._post(self._on_event, parse_event(payload))
            else:
                self._post(self._replies.put_nowait, line)
        except ProtocolError as exc:
            log.warning("dropping malformed %s line %r: %s", kind, line, exc)

    # --- loop-thread handlers ----------------------------------------------
    def _deliver_status(self, gen: int, status: PicoStatus) -> None:
        if gen != self._gen:
            return
        self._last_status = self._loop.time()
        self._on_status(status)

    def _reader_failed(self, gen: int) -> None:
        if gen == self._gen:
            self._reader_died = True

    # --- supervision --------------------------------------------------------
    async def _supervise(self) -> None:
        tick = min(_TICK_MAX_S, self._stale_s / 4, self._reconnect_s / 4)
        while True:
            await asyncio.sleep(tick)
            now = self._loop.time()
            if self.connected:
                if self._reader_died:
                    await self._go_down("reader died", reopen=True)
                elif self.expect_stream and now - self._last_status > self._stale_s:
                    await self._go_down("status stream stale", reopen=False)
            elif self._needs_reopen:
                if now >= self._next_try:
                    await self._try_reopen()
            elif self._last_status > self._down_at:
                await self._come_up()  # port stayed open; the stream resumed

    async def _go_down(self, why: str, *, reopen: bool) -> None:
        log.warning("pico link down: %s", why)
        self.connected = False
        self._down_at = self._loop.time()
        self._needs_reopen = reopen
        self._next_try = self._down_at + self._reconnect_s
        if reopen:
            await asyncio.to_thread(self._end_reading)
        self._on_link(False)

    async def _try_reopen(self) -> None:
        try:
            self._serial = await asyncio.to_thread(self._factory, self._port, self._baud)
        except Exception:
            log.warning("pico reopen failed; retrying", exc_info=True)
            self._next_try = self._loop.time() + self._reconnect_s
            return
        self._needs_reopen = False
        self._begin_reading()
        await self._come_up()

    async def _come_up(self) -> None:
        self.connected = True
        self.expect_stream = False  # the stream died with the link; on_reconnect re-arms it
        self._on_link(True)
        if self._on_reconnect is not None:
            try:
                await self._on_reconnect()
            except Exception:
                log.exception("on_reconnect hook failed")

    # --- commands -----------------------------------------------------------
    async def command(self, line: str, timeout_s: float = 2.0) -> list[str]:
        if not self.connected:
            raise PicoError("link down")
        async with self._cmd_lock:
            while not self._replies.empty():
                log.warning("discarding stray reply %r", self._replies.get_nowait())
            try:
                await asyncio.to_thread(self._serial.write, (line + "\n").encode())
            except OSError as exc:
                self._reader_died = True
                raise PicoError(f"write failed: {exc}") from exc
            data: list[str] = []
            deadline = self._loop.time() + timeout_s
            while True:
                remaining = deadline - self._loop.time()
                try:
                    reply = await asyncio.wait_for(self._replies.get(), max(remaining, 0.0))
                except asyncio.TimeoutError:
                    raise PicoTimeout(f"no reply to {line!r} within {timeout_s}s") from None
                if reply == "ok":
                    return data
                if reply == "err" or reply.startswith("err "):
                    raise PicoError(reply[4:])
                data.append(reply)
