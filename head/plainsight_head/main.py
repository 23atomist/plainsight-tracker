"""Composition root: wires the components, runs the boot sequence (spec 5.1), shuts down cleanly."""
from __future__ import annotations

import asyncio
import logging
import os
import signal
from collections.abc import Awaitable, Callable
from typing import Any

from aiohttp import web

from .api import HeadContext, make_app, pico_stop_axes
from .config import HeadConfig
from .deadman import JogDeadman
from .imu import BNO055, OFFSETS_LEN, ImuReader
from .persist import JsonStore
from .pico import PicoError, PicoLink
from .protocol import PicoEvent, PicoStatus, ProtocolError, parse_cfg_lines
from .reference import PanReference
from .state import HeadState

log = logging.getLogger(__name__)

OFFSETS_FILE = "bno055-offsets.json"
FIRST_STATUS_WAIT_S = 3.0
HOME_WAIT_S = 60.0
HOMED_STATUS_WAIT_S = 2.0  # the `homed` event precedes the status line that shows it
IMU_ONLY_TICK_S = 0.5
SHUTDOWN_STOP_S = 1.0
HTTP_SHUTDOWN_S = 0.5  # aiohttp waits this twice per busy connection (finish, then cancel)
HTTP_FORCE_S = 0.1  # must be > 0: aiohttp treats a 0 timeout as "wait forever"
HTTP_CLOSE_CAP_S = 2.0  # the whole server close, so it can never hold back STOP
STATUS_POLL_S = 0.05
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
_HOME_DONE = ("homed", "home_failed")


class Head:
    """Every component, wired the way tests/fakes.py HeadCtx wires them."""

    def __init__(self, cfg: HeadConfig, serial_factory: Callable[[str, int], Any] | None,
                 imu_open: Callable[[], Any], store: JsonStore) -> None:
        self.cfg, self.store = cfg, store
        self.state = HeadState(cfg)
        self._tilt_home: asyncio.Future[str] | None = None
        factory = {} if serial_factory is None else {"serial_factory": serial_factory}  # else pyserial
        self.link = PicoLink(cfg.serial, cfg.baud, on_status=self._on_status,
                             on_event=self._on_pico_event, on_link=self._on_pico_link,
                             on_reconnect=self.init_pico, **factory)
        self.imu = ImuReader(self._opener(imu_open), on_fully_calibrated=self._save_offsets,
                             on_link=self.state.set_imu_link)
        self.ref = PanReference(cfg, self.link, self.imu, self.state, store,
                                on_event=self._on_ref_event)
        self.deadman = JogDeadman(cfg.jog_deadman_ms, pico_stop_axes(self.link))
        self.ctx = HeadContext(cfg, self.link, self.imu, self.state, self.deadman, self.ref)

    # --- callbacks ----------------------------------------------------------
    def _merge_imu(self) -> None:
        if self.imu.latest is not None:
            self.state.on_imu(self.imu.latest)

    def _on_status(self, st: PicoStatus) -> None:
        self._merge_imu()
        self.state.on_pico_status(st)
        self.ref.on_status(st)

    def _on_pico_event(self, ev: PicoEvent) -> None:
        self.state.publish_event(ev.name, ev.axis, ev.detail)
        fut = self._tilt_home
        if ev.axis == "tilt" and ev.name in _HOME_DONE and fut is not None and not fut.done():
            fut.set_result(ev.name)

    def _on_pico_link(self, up: bool) -> None:
        self.state.set_pico_link(up)
        self.state.publish_event("pico_link", None, {"up": up})

    def _on_ref_event(self, name: str, detail: dict) -> None:
        self.state.publish_event(name, None, detail)

    # --- IMU calibration offsets ------------------------------------------
    def _opener(self, imu_open: Callable[[], Any]) -> Callable[[], Any]:
        """Open the sensor and write the saved offsets to it, on every (re)open."""
        def open_with_offsets() -> Any:
            dev = imu_open()
            offsets = self._load_offsets()
            if offsets is not None:
                try:
                    dev.set_offsets(offsets)
                    log.info("IMU: restored calibration offsets from %s", OFFSETS_FILE)
                except Exception:
                    log.exception("IMU: writing saved calibration offsets failed")
            return dev

        return open_with_offsets

    def _load_offsets(self) -> bytes | None:
        saved = self.store.read(OFFSETS_FILE)
        if saved is None:
            return None
        values = saved.get("offsets") if isinstance(saved, dict) else None
        if (not isinstance(values, list) or len(values) != OFFSETS_LEN
                or not all(type(v) is int and 0 <= v <= 255 for v in values)):
            log.warning("%s: ignoring malformed contents %r", OFFSETS_FILE, saved)
            return None
        return bytes(values)

    def _save_offsets(self, data: bytes) -> None:
        try:
            self.store.write(OFFSETS_FILE, {"offsets": list(data)})
        except OSError:
            log.exception("writing %s failed", OFFSETS_FILE)
            return
        log.info("IMU fully calibrated; offsets saved to %s", OFFSETS_FILE)

    # --- Pico init (first connect and every reconnect) ---------------------
    async def init_pico(self) -> None:
        cfg, link = self.cfg, self.link
        try:
            ver = await link.command("VER")
            self.ctx.pico_version = ver[0].removeprefix("V ") if ver else ""
            log.info("pico: version %s", self.ctx.pico_version or "(none reported)")
            _log_pico_cfg(await link.command("CFG"))
            await link.command(f"CFG global track_timeout_ms {cfg.track_timeout_ms}")
            await link.command(f"STREAM {cfg.stream_ms}")
            log.info("pico: initialised, streaming every %d ms", cfg.stream_ms)
        except PicoError as exc:
            log.warning("pico init failed (%s); the link supervisor will retry", exc.reason)
        finally:
            # Also after a failure: no stream then goes stale, the link recycles, init re-runs.
            link.expect_stream = True

    # --- boot (spec 5.1 steps 4-6) -------------------------------------------
    async def boot(self) -> None:
        log.info("boot: waiting up to %.0f s for the first Pico status", FIRST_STATUS_WAIT_S)
        if not await self._first_status():
            log.warning("boot: no Pico status yet; skipping auto-home")
        elif self.cfg.auto_home and not self.state.pico.axes["tilt"].homed:
            await self._home_tilt()
        log.info("boot: restoring the pan reference")
        result = await self.ref.restore_at_boot()
        log.info("boot: pan reference %s%s", result.source,
                 f" ({result.reason})" if result.reason else "")

    async def _first_status(self) -> bool:
        return await _wait_until(lambda: self.state.pico is not None, FIRST_STATUS_WAIT_S)

    def _tilt_homed(self) -> bool:
        return self.state.pico is not None and self.state.pico.axes["tilt"].homed

    async def _home_tilt(self) -> None:
        log.info("boot: tilt not homed; HOME tilt")
        self._tilt_home = asyncio.get_running_loop().create_future()
        try:
            await self.link.command("HOME tilt")
            outcome = await asyncio.wait_for(self._tilt_home, HOME_WAIT_S)
        except PicoError as exc:
            log.warning("boot: HOME tilt refused: %s; continuing", exc.reason)
        except asyncio.TimeoutError:
            log.warning("boot: tilt homing gave no result within %.0f s; continuing", HOME_WAIT_S)
        else:
            if outcome != "homed":
                log.warning("boot: tilt %s; continuing", outcome)
            elif await _wait_until(self._tilt_homed, HOMED_STATUS_WAIT_S):
                log.info("boot: tilt homed")
            else:
                log.warning("boot: tilt homed event, but no status confirmed it; continuing")
        finally:
            self._tilt_home = None

    async def imu_only_ticks(self) -> None:
        """While the Pico is down no status drives telemetry; publish the IMU at 2 Hz instead."""
        while True:
            await asyncio.sleep(IMU_ONLY_TICK_S)
            if not self.state.pico_link:
                self._merge_imu()
                self.state.publish_imu_only()

    # --- shutdown -----------------------------------------------------------------
    async def stop_motion(self) -> None:
        try:
            await asyncio.wait_for(self.link.command("STOP"), SHUTDOWN_STOP_S)
        except (PicoError, asyncio.TimeoutError) as exc:
            log.warning("shutdown: STOP not confirmed: %s", getattr(exc, "reason", "timeout"))


async def _wait_until(cond: Callable[[], bool], timeout_s: float) -> bool:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    while not cond() and loop.time() < deadline:
        await asyncio.sleep(STATUS_POLL_S)
    return cond()


def _log_pico_cfg(lines: list[str]) -> None:
    try:
        scopes = parse_cfg_lines(lines)
    except ProtocolError as exc:
        log.warning("pico CFG: unparseable dump (%s): %r", exc, lines)
        return
    for scope, values in scopes.items():
        log.info("pico CFG %s: %s", scope, " ".join(f"{k}={v:g}" for k, v in values.items()))


async def _cancel(*tasks: asyncio.Task | None) -> None:
    live = [t for t in tasks if t is not None]
    for task in live:
        task.cancel()
    for task in live:
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("task %s failed", task.get_name())


async def run(cfg: HeadConfig, *, serial_factory: Callable[[str, int], Any] | None = None,
              imu_open: Callable[[], Any] | None = None, store: JsonStore | None = None,
              stop_event: asyncio.Event | None = None, bind: str = "0.0.0.0") -> None:
    stop_event = stop_event if stop_event is not None else asyncio.Event()
    head = Head(cfg, serial_factory,
                imu_open or (lambda: BNO055(cfg.i2c_bus, cfg.imu_address)),
                store if store is not None else JsonStore(cfg.data_dir))
    runner = web.AppRunner(make_app(head.ctx), shutdown_timeout=HTTP_SHUTDOWN_S)
    tasks: dict[str, asyncio.Task] = {}
    try:
        log.info("startup 1/6: Pico link on %s", cfg.serial)
        await head.link.start()
        if head.link.connected:  # PicoLink runs on_reconnect only for later connects
            await head.init_pico()
        log.info("startup 2/6: IMU reader")
        await head.imu.start()
        # The dead-man and the IMU-only ticker start before the server takes its first request:
        # a jog must never be unguarded, and an absent Pico must not leave telemetry silent.
        await head.deadman.start()
        tasks["ticker"] = asyncio.create_task(head.imu_only_ticks(), name="imu-only-ticks")
        log.info("startup 3/6: HTTP server on %s:%d", bind, cfg.port)
        await runner.setup()
        await web.TCPSite(runner, bind, cfg.port).start()
        tasks["boot"] = asyncio.create_task(_boot(head, tasks), name="head-boot")
        await stop_event.wait()
        log.info("shutdown requested")
    finally:
        await _shutdown(head, runner, tasks)


async def _boot(head: Head, tasks: dict[str, asyncio.Task]) -> None:
    try:
        await head.boot()
    except Exception:
        log.exception("boot failed; the head stays up for manual control")
    tasks["persistence"] = asyncio.create_task(head.ref.run_persistence(), name="pan-persistence")
    log.info("boot complete")


async def _shutdown(head: Head, runner: web.AppRunner, tasks: dict[str, asyncio.Task]) -> None:
    # Stop taking requests first, so no command can reach the Pico after the final STOP,
    # and no jog can arrive once the dead-man is gone.
    await _chain([
        ("cancel boot", lambda: _cancel(tasks.get("boot"))),  # boot must not send after STOP
        ("close HTTP server", lambda: _close_server(runner)),
        ("STOP", head.stop_motion),
        ("persist pan", head.ref.persist_now),
        ("stop tickers", lambda: _cancel(tasks.get("ticker"), tasks.get("persistence"))),
        ("close dead-man", head.deadman.close),
        ("close IMU", head.imu.close),
        ("close Pico link", head.link.close),
    ])
    log.info("shutdown complete")


async def _close_server(runner: web.AppRunner) -> None:
    """Stop the site, close WS clients, cancel API tasks: bounded, since STOP waits on it."""
    if runner.server is None:  # setup() never ran
        return
    try:
        await asyncio.wait_for(runner.cleanup(), HTTP_CLOSE_CAP_S)
    except asyncio.TimeoutError:
        log.warning("shutdown: HTTP server did not close within %.0f s; forcing it", HTTP_CLOSE_CAP_S)
        server = runner.server
        if server is not None:
            await server.shutdown(HTTP_FORCE_S)  # cancel every connection's handler now
        await runner.app.cleanup()  # on_cleanup cancels API tasks (an IMU reference) before STOP


async def _chain(steps: list[tuple[str, Callable[[], Awaitable[Any]]]]) -> None:
    """Run every step in order; a failing (or cancelled) step never skips the ones after it."""
    if not steps:
        return
    (name, step), rest = steps[0], steps[1:]
    try:
        await step()
    except Exception:
        log.exception("shutdown: %s failed", name)
    finally:
        await _chain(rest)


def main() -> None:
    cfg = HeadConfig.from_env(os.environ)
    logging.basicConfig(level=cfg.log_level, format=LOG_FORMAT)

    async def serve() -> None:
        stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop_event.set)
        await run(cfg, stop_event=stop_event)

    asyncio.run(serve())
