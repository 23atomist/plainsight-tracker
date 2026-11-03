"""Serial transport to the Pico: reader thread, command/reply, link supervision."""
from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Awaitable, Callable
from typing import Any

from .outage import OutageLog
from .protocol import PicoEvent, PicoStatus, ProtocolError, classify_line, parse_event, parse_status

log = logging.getLogger(__name__)

_TICK_MAX_S = 0.05
_READ_CHUNK = 256
WRITE_TIMEOUT_S = 1.0


class PicoError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class PicoTimeout(PicoError):
    pass


class PicoLinkDown(PicoError):
    """The serial link is down (or dropped while the command waited); nothing reached the Pico."""

    def __init__(self, reason: str = "link down") -> None:
        super().__init__(reason)


def _pyserial_factory(port: str, baud: int) -> Any:
    import serial  # imported lazily so tests never need a real port

    # write_timeout: a stuck USB endpoint raises SerialTimeoutException (an OSError) instead of
    # blocking the write, and so the command lock, forever.
    return serial.Serial(port, baud, timeout=0.1, write_timeout=WRITE_TIMEOUT_S)


class PicoLink:
    """Serial link to the Pico.

    Any link loss (read error or a stale status stream) closes the port and
    retries `serial_factory` every `reconnect_s`; so does a failed first open
    in `start()`. After ANY successful (re)open the link is up: `on_link(True)`
    fires, `expect_stream` is cleared, and `await on_reconnect()` runs.
    `on_reconnect` MUST re-send STREAM and set `expect_stream = True` again;
    the caller owns that. `command()` may be used from inside `on_reconnect`.
    """

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
        self._replies: asyncio.Queue[str | None] = asyncio.Queue()  # None = link dropped
        self._cmd_lock = asyncio.Lock()
        self._serial: Any = None
        self._thread: threading.Thread | None = None
        self._stop: threading.Event | None = None
        self._gen = 0
        self._reader_died = False
        self._reader_error = ""
        self._outage = OutageLog(log, f"pico link ({port})")
        self._last_status = 0.0
        self._next_try = 0.0
        self._supervisor: asyncio.Task | None = None
        self._teardowns: set[asyncio.Future] = set()

    # --- lifecycle ----------------------------------------------------------
    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        if await self._open():
            await self._come_up(first=True)
        else:  # absent port at boot is not fatal; the supervisor keeps retrying
            self._on_link(False)
        self._supervisor = asyncio.create_task(self._supervise(), name="pico-supervisor")

    async def close(self) -> None:
        if self._supervisor is not None:
            self._supervisor.cancel()
            await asyncio.gather(self._supervisor, return_exceptions=True)
            self._supervisor = None
        self.connected = False
        self._schedule_teardown()
        if self._teardowns:  # failures are logged by _teardown_done
            await asyncio.gather(*self._teardowns, return_exceptions=True)

    # --- reader thread / teardown --------------------------------------------
    def _begin_reading(self) -> None:
        self._gen += 1
        self._reader_died = False
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._read_loop, args=(self._serial, self._stop, self._gen),
            name="pico-reader", daemon=True)
        self._thread.start()

    def _schedule_teardown(self) -> None:
        """Detach the reader/port on the loop thread, then finish them off-thread."""
        thread, stop, ser = self._thread, self._stop, self._serial
        self._thread = self._stop = self._serial = None
        if thread is None and ser is None:
            return
        fut = asyncio.ensure_future(asyncio.to_thread(self._teardown, thread, stop, ser))
        self._teardowns.add(fut)
        fut.add_done_callback(self._teardown_done)

    def _teardown_done(self, fut: asyncio.Future) -> None:
        self._teardowns.discard(fut)
        if not fut.cancelled() and fut.exception() is not None:
            log.error("pico port teardown failed", exc_info=fut.exception())

    @staticmethod
    def _teardown(thread: threading.Thread | None, stop: threading.Event | None, ser: Any) -> None:
        if stop is not None:
            stop.set()
        if thread is not None:
            thread.join(timeout=2.0)
            if thread.is_alive():
                log.warning("pico reader thread did not stop in time")
        if ser is not None:
            try:
                ser.close()
            except OSError:
                log.warning("error closing serial port", exc_info=True)

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
            except OSError as exc:
                log.debug("pico serial read failed", exc_info=True)
                self._post(self._reader_failed, gen, f"read failed: {exc}")
                return
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, _, rest = bytes(buf).partition(b"\n")
                buf = bytearray(rest)
                self._dispatch_line(raw.decode("utf-8", errors="replace").strip(), gen)

    def _dispatch_line(self, line: str, gen: int) -> None:
        if not line:
            log.warning("dropping blank line from pico")
            return
        if "\ufffd" in line:
            log.warning("dropping garbled line %r", line)
            return
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
        self._outage.recovered()  # the first status after an outage, not the reopen, ends it
        self._on_status(status)

    def _reader_failed(self, gen: int, why: str) -> None:
        if gen == self._gen:
            self._reader_died = True
            self._reader_error = why

    # --- supervision --------------------------------------------------------
    async def _supervise(self) -> None:
        tick = min(_TICK_MAX_S, self._stale_s / 4, self._reconnect_s / 4)
        while True:
            await asyncio.sleep(tick)
            try:
                await self._supervise_once()
            except Exception:  # never let one bad step end reconnects and stale detection
                log.exception("pico link supervisor step failed; retrying in %ss", self._reconnect_s)
                await asyncio.sleep(self._reconnect_s)

    async def _supervise_once(self) -> None:
        now = self._loop.time()
        if self.connected:
            if self._reader_died:
                self._go_down(f"reader died ({self._reader_error})")
            elif self.expect_stream and now - self._last_status > self._stale_s:
                self._go_down("status stream stale")
        elif self._serial is None and now >= self._next_try:
            if self._teardowns:  # never reopen while the old port is still closing
                await asyncio.gather(*self._teardowns, return_exceptions=True)
            if await self._open():
                await self._come_up()

    def _go_down(self, why: str) -> None:
        self._outage.failure(why)
        self.connected = False
        self._next_try = self._loop.time() + self._reconnect_s
        self._replies.put_nowait(None)  # wake any command waiting on a reply
        self._schedule_teardown()
        self._on_link(False)

    async def _open(self) -> bool:
        """Open the port and start the reader; False (and a retry time) on failure."""
        fut = asyncio.ensure_future(asyncio.to_thread(self._factory, self._port, self._baud))
        try:
            ser = await asyncio.shield(fut)
        except asyncio.CancelledError:
            fut.add_done_callback(self._close_orphan)
            raise
        except Exception as exc:
            log.debug("pico open failed", exc_info=True)
            self._outage.failure(f"open failed ({type(exc).__name__}: {exc}); retrying every "
                                 f"{self._reconnect_s:g} s")
            self._next_try = self._loop.time() + self._reconnect_s
            return False
        try:
            ser.reset_input_buffer()
        except OSError:
            log.warning("reset_input_buffer failed", exc_info=True)
        self._serial = ser
        self._begin_reading()
        return True

    @staticmethod
    def _close_orphan(fut: asyncio.Future) -> None:
        if not fut.cancelled() and fut.exception() is None:
            try:
                fut.result().close()
            except OSError:
                log.warning("error closing orphaned port", exc_info=True)

    async def _come_up(self, *, first: bool = False) -> None:
        self.connected = True
        self._last_status = self._loop.time()
        self.expect_stream = False
        self._on_link(True)
        if self._on_reconnect is not None and not first:
            try:
                await self._on_reconnect()
            except Exception:
                log.exception("on_reconnect hook failed")

    # --- commands -----------------------------------------------------------
    async def command(self, line: str, timeout_s: float = 2.0) -> list[str]:
        if "\n" in line or "\r" in line:  # one command per line; never let a caller inject a second
            raise PicoError("line contains a newline")
        if not self.connected:
            raise PicoLinkDown()
        try:
            async with asyncio.timeout(timeout_s):  # bounds the wait behind other commands
                await self._cmd_lock.acquire()
        except TimeoutError:
            raise PicoTimeout(f"{line!r} waited {timeout_s}s for the link; not sent") from None
        try:
            return await self._exchange(line, timeout_s)
        finally:
            self._cmd_lock.release()

    async def _exchange(self, line: str, timeout_s: float) -> list[str]:
        """Write one command and collect its reply; the caller holds `_cmd_lock`."""
        ser = self._serial
        if not self.connected or ser is None:
            raise PicoLinkDown()
        while not self._replies.empty():
            stray = self._replies.get_nowait()
            if stray is not None:
                log.warning("discarding stray reply %r", stray)
        try:
            await asyncio.to_thread(ser.write, (line + "\n").encode())
        except OSError as exc:
            self._reader_died, self._reader_error = True, f"write failed: {exc}"
            raise PicoError(f"write failed: {exc}") from exc
        data: list[str] = []
        deadline = self._loop.time() + timeout_s
        while True:
            remaining = deadline - self._loop.time()
            try:
                reply = await asyncio.wait_for(self._replies.get(), max(remaining, 0.0))
            except asyncio.TimeoutError:
                raise PicoTimeout(f"no reply to {line!r} within {timeout_s}s") from None
            if reply is None:
                raise PicoLinkDown()
            if reply == "ok":
                return data
            if reply == "err" or reply.startswith("err "):
                raise PicoError(reply[4:])
            data.append(reply)

    async def status(self, timeout_s: float = 2.0) -> PicoStatus:
        """One `STATUS` round trip. ProtocolError if the reply is missing or unparseable."""
        lines = await self.command("STATUS", timeout_s)
        if not lines:
            raise ProtocolError("STATUS: no status line in the reply")
        return parse_status(lines[0])
