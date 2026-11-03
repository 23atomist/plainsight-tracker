"""aiohttp application: the HTTP command routes and WebSocket telemetry fan-out (spec 4.2, 4.3)."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from collections.abc import Awaitable, Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from typing import Any

from aiohttp import WSCloseCode, web

from . import __version__
from .config import HeadConfig
from .deadman import JogDeadman
from .imu import ImuReader, ImuSample
from .pico import PicoError, PicoLink, PicoLinkDown, PicoTimeout
from .protocol import AXES, ProtocolError, fmt_axes, parse_cfg_lines, parse_drv_lines
from .reference import PanReference
from .state import EstopLatched, HeadState, guard_head_motion

log = logging.getLogger(__name__)

WS_QUEUE_MAX = 50
IMU_BURST_DEFAULT = 100
IMU_BURST_MAX = 1000
TRACK_AXES = ("pan", "tilt")
GUARDED_KEYS = ("socket", "host_baud")
COMMAND_TIMEOUT_S = 2.0
SAFETY_TIMEOUT_S = 5.0  # STOP and ESTOP may queue behind another command's full 2 s timeout
_TOKEN = re.compile(r"[A-Za-z0-9_]+")


@dataclass
class HeadContext:
    cfg: HeadConfig
    pico: PicoLink
    imu: ImuReader
    state: HeadState
    deadman: JogDeadman
    ref: PanReference
    pico_version: str = ""


@dataclass
class _ApiState:
    ws_clients: set[web.WebSocketResponse] = field(default_factory=set)
    ws_dropped_total: int = 0
    tasks: set[asyncio.Task] = field(default_factory=set)


CTX = web.AppKey("ctx", HeadContext)
API = web.AppKey("api", _ApiState)


class HTTPLocked(web.HTTPClientError):
    status_code = 423


def _error(cls: type[web.HTTPException], text: str) -> web.HTTPException:
    return cls(text=json.dumps({"ok": False, "error": text}), content_type="application/json")


def _ok(status: int = 200) -> web.Response:
    return web.json_response({"ok": True}, status=status)


def pico_stop_axes(pico: PicoLink) -> Callable[[list[str]], Awaitable[None]]:
    """The jog dead-man's stop action: `STOP <axes>`.

    Every failure propagates, PicoLinkDown included: the Pico has no host-disconnect stop and
    JOG no timeout of its own, so a jog survives a link drop. The dead-man keeps the axis armed
    and retries each poll until a STOP goes through (main.init_pico also stops it on reconnect).
    """
    async def stop_axes(axes: list[str]) -> None:
        await pico.command("STOP " + " ".join(axes))

    return stop_axes


# --- validation ---------------------------------------------------------------
def _number(value: Any, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _error(web.HTTPBadRequest, f"{what}: expected a number")
    try:
        out = float(value)
    except OverflowError:
        out = math.inf
    if not math.isfinite(out):
        raise _error(web.HTTPBadRequest, f"{what}: expected a finite number")
    return out


def expect_axes(body: dict, allowed: tuple, kind: str) -> dict:
    """Validate `{axis: number}` (scalar) or `{axis: {"pos", "vel"}}` (pair) bodies."""
    if not body:
        raise _error(web.HTTPBadRequest, "no axes given")
    out: dict[str, Any] = {}
    for ax, value in body.items():
        if ax not in allowed:
            raise _error(web.HTTPBadRequest, f"unknown axis {ax!r}; allowed: {', '.join(allowed)}")
        if kind == "scalar":
            out[ax] = _number(value, ax)
        elif not isinstance(value, dict) or set(value) != {"pos", "vel"}:
            raise _error(web.HTTPBadRequest, f"{ax}: expected {{\"pos\": n, \"vel\": n}}")
        else:
            out[ax] = (_number(value["pos"], f"{ax}.pos"), _number(value["vel"], f"{ax}.vel"))
    return out


def _expect_keys(body: dict, allowed: tuple) -> None:
    extra = sorted(set(body) - set(allowed))
    if extra:
        raise _error(web.HTTPBadRequest, f"unknown keys: {', '.join(extra)}")


def _axis_list(body: dict) -> list[str]:
    """The optional `axes` list of /api/stop and /api/home; [] means all."""
    _expect_keys(body, ("axes",))
    axes = body.get("axes", [])
    if not isinstance(axes, list) or any(a not in AXES for a in axes):
        raise _error(web.HTTPBadRequest, f"axes: expected a list drawn from {', '.join(AXES)}")
    return list(dict.fromkeys(axes))


async def _body(request: web.Request, *, required: bool = True) -> dict:
    if not request.can_read_body:
        if required:
            raise _error(web.HTTPBadRequest, "JSON body required")
        return {}
    try:
        body = await request.json()
    except ValueError as exc:
        raise _error(web.HTTPBadRequest, f"invalid JSON: {exc}") from None
    if not isinstance(body, dict):
        raise _error(web.HTTPBadRequest, "body must be a JSON object")
    return body


# --- Pico calls -----------------------------------------------------------------
@contextmanager
def _pico_errors(*, setpos: bool = False) -> Iterator[None]:
    try:
        yield
    except PicoTimeout as exc:
        log.warning("pico timeout: %s", exc.reason)
        raise _error(web.HTTPGatewayTimeout, exc.reason) from exc
    except PicoError as exc:
        log.warning("pico refused: %s", exc.reason)
        if isinstance(exc, PicoLinkDown):
            raise _error(web.HTTPServiceUnavailable, "pico link down") from exc
        if setpos and ("moving" in exc.reason or "stopped" in exc.reason):
            raise _error(web.HTTPConflict, exc.reason) from exc
        raise _error(web.HTTPBadRequest, exc.reason) from exc


async def _command(ctx: HeadContext, line: str, timeout_s: float = COMMAND_TIMEOUT_S) -> list[str]:
    with _pico_errors():
        return await ctx.pico.command(line, timeout_s)


def _guard_motion(ctx: HeadContext) -> None:
    try:
        guard_head_motion(ctx.state)
    except EstopLatched:
        raise _error(HTTPLocked, "estop latched; POST /api/estop/clear") from None
    if not ctx.state.pico_link:
        raise _error(web.HTTPServiceUnavailable, "pico link down")


async def send_motion(ctx: HeadContext, line: str) -> list[str]:
    _guard_motion(ctx)
    return await _command(ctx, line)


# --- motion routes ----------------------------------------------------------------
async def _send_superseding(ctx: HeadContext, line: str, axes: Iterable[str]) -> list[str]:
    """Send a command that replaces any jog on `axes`, then disarm their dead-man timers.

    Otherwise the dead-man would STOP the axis mid-move. A jog re-armed while the command was
    queued is newer than it and keeps its timer. After a timeout the timers stay armed.
    """
    snap = ctx.deadman.snapshot()
    data = await send_motion(ctx, line)
    ctx.deadman.clear_unchanged(snap, axes)
    return data


async def goto(request: web.Request) -> web.Response:
    values = expect_axes(await _body(request), AXES, "scalar")
    await _send_superseding(request.app[CTX], "MOVE " + fmt_axes(values), values)
    return _ok(202)


async def track(request: web.Request) -> web.Response:
    values = expect_axes(await _body(request), TRACK_AXES, "pair")
    await _send_superseding(request.app[CTX], "TRACK " + fmt_axes(values), values)
    return _ok()


async def jog(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    values = expect_axes(await _body(request), AXES, "scalar")
    _guard_motion(ctx)
    was_armed = ctx.deadman.armed
    moving = [ax for ax, rate in values.items() if rate != 0]
    for ax in moving:  # arm before the send: once written, the Pico may be jogging
        ctx.deadman.touch(ax)
    try:
        await _command(ctx, "JOG " + fmt_axes(values))
    except web.HTTPGatewayTimeout:
        raise  # the JOG may have reached the Pico; leave the dead-man armed
    except web.HTTPException:
        for ax in moving:
            if ax not in was_armed:
                ctx.deadman.clear(ax)
        raise
    for ax, rate in values.items():
        if rate == 0:
            ctx.deadman.clear(ax)
    return _ok()


async def home(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    axes = _axis_list(await _body(request, required=False))
    if axes:
        await _send_superseding(ctx, " ".join(["HOME", *axes]), axes)
        return _ok(202)
    snap = ctx.deadman.snapshot()
    await send_motion(ctx, "HOME")
    if snap:  # bare HOME homes the axes with an endstop; ask the Pico which ones started
        await _clear_homing(ctx, snap)
    return _ok(202)


async def _clear_homing(ctx: HeadContext, snap: dict[str, float]) -> None:
    try:
        st = await ctx.pico.status()
    except (PicoError, ProtocolError) as exc:
        log.warning("HOME: could not read which axes are homing (%s); jog timers stay armed", exc)
        return
    ctx.deadman.clear_unchanged(snap, [ax for ax in snap if st.axes[ax].mode == "H"])


async def setpos(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    values = expect_axes(await _body(request), AXES, "scalar")
    _guard_motion(ctx)
    if ctx.ref.busy:
        raise _error(web.HTTPConflict, "reference busy")
    _refuse_moving(ctx, values)
    others = {ax: v for ax, v in values.items() if ax != "pan"}
    with _pico_errors(setpos=True):
        if others:
            await ctx.pico.command("SETPOS " + fmt_axes(others))
        if "pan" in values:
            await ctx.ref.set_from_host(values["pan"])
    return _ok()


def _refuse_moving(ctx: HeadContext, axes: dict) -> None:
    pico = ctx.state.pico
    if pico is None:
        return
    for ax in axes:
        st = pico.axes[ax]
        if st.vel != 0 or st.mode in ("H", "V"):
            raise _error(web.HTTPConflict, f"{ax} is moving; stop it first")


async def reference(request: web.Request) -> web.Response:
    ctx, api = request.app[CTX], request.app[API]
    body = await _body(request, required=False)
    _expect_keys(body, ("timeoutS",))
    timeout_s = ctx.cfg.ref_timeout_s
    if "timeoutS" in body:
        timeout_s = _number(body["timeoutS"], "timeoutS")
        if timeout_s <= 0:
            raise _error(web.HTTPBadRequest, "timeoutS: expected a positive number")
    _guard_motion(ctx)
    if ctx.ref.busy:
        raise _error(web.HTTPConflict, "reference busy")
    task = asyncio.create_task(ctx.ref.reference_from_imu(timeout_s), name="api-reference")
    api.tasks.add(task)
    task.add_done_callback(_reference_done(api))
    return _ok(202)


def _reference_done(api: _ApiState) -> Callable[[asyncio.Task], None]:
    def done(task: asyncio.Task) -> None:
        api.tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("IMU north reference crashed", exc_info=task.exception())

    return done


# --- non-motion routes ---------------------------------------------------------------
async def stop(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    axes = _axis_list(await _body(request, required=False))
    await _command(ctx, " ".join(["STOP", *axes]), SAFETY_TIMEOUT_S)
    if axes:
        for ax in axes:
            ctx.deadman.clear(ax)
    else:
        ctx.deadman.clear()
    return _ok()


async def estop(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    # Latch before the round trip: ESTOP may queue behind an in-flight command, and motion
    # requests arriving meanwhile must be refused, not queued to go out after it.
    ctx.state.set_estop(True)
    ctx.state.publish_event("estop")
    log.warning("E-STOP latched")
    await _command(ctx, "ESTOP", SAFETY_TIMEOUT_S)
    # Only now: if ESTOP did not go through, the dead-man keeps retrying STOP for any jog, and
    # main.init_pico re-sends ESTOP when the link comes back while the latch is set.
    ctx.deadman.clear()
    return _ok()


async def estop_clear(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    ctx.state.set_estop(False)
    ctx.state.publish_event("estop_cleared")
    log.info("E-STOP latch cleared")
    return _ok()


async def enable(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    body = await _body(request)
    _expect_keys(body, ("on",))
    on = body.get("on")
    if not isinstance(on, bool):
        raise _error(web.HTTPBadRequest, "on: expected true or false")
    try:
        await _command(ctx, f"ENABLE {int(on)}")
    finally:  # a failed or timed-out ENABLE 0 may still have disabled the drivers
        if not on:
            ctx.ref.note_enable_off()
    return _ok()


async def get_config(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    scopes = parse_cfg_lines(await _command(ctx, "CFG"))
    return web.json_response({**scopes, "head": asdict(ctx.cfg)})


async def set_config(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    body = await _body(request)
    _expect_keys(body, ("scope", "key", "value", "save"))
    scope, key, save = body.get("scope"), body.get("key"), body.get("save", False)
    for name, token in (("scope", scope), ("key", key)):
        if not isinstance(token, str) or not _TOKEN.fullmatch(token):
            raise _error(web.HTTPBadRequest, f"{name}: expected a [A-Za-z0-9_]+ name")
    if "value" not in body:
        raise _error(web.HTTPBadRequest, "value: required")
    _number(body["value"], "value")
    if not isinstance(save, bool):
        raise _error(web.HTTPBadRequest, "save: expected true or false")
    if (key.lower() in GUARDED_KEYS or scope.lower() == "global") and request.query.get("force") != "1":
        raise _error(web.HTTPForbidden, "guarded setting; add ?force=1")
    await send_motion(ctx, f"CFG {scope} {key} {body['value']!r}")
    if save:
        await _command(ctx, "SAVE")
    ctx.state.publish_event("config", None, {"scope": scope, "key": key, "value": body["value"]})
    return _ok()


async def drivers(request: web.Request) -> web.Response:
    lines = await _command(request.app[CTX], "DRV")
    return web.json_response({"drivers": parse_drv_lines(lines)})


async def imu_burst(request: web.Request) -> web.Response:
    ctx = request.app[CTX]
    try:
        n = int(request.query.get("n", IMU_BURST_DEFAULT))
    except ValueError:
        raise _error(web.HTTPBadRequest, "n: expected an integer") from None
    n = max(1, min(n, IMU_BURST_MAX))
    if not ctx.imu.ok:
        raise _error(web.HTTPServiceUnavailable, "imu not ok")
    try:
        samples = await ctx.imu.burst(n)
    except OSError as exc:
        log.warning("IMU burst failed: %s", exc)
        raise _error(web.HTTPServiceUnavailable, f"imu read failed: {exc}") from exc
    return web.json_response({"n": n, "samples": [_sample_obj(s) for s in samples]})


def _sample_obj(s: ImuSample) -> dict[str, Any]:
    sys_, gyr, acc, mag = s.cal
    return {"t": s.t, "heading": s.heading, "roll": s.roll, "pitch": s.pitch,
            "quat": list(s.quat), "gravity": list(s.gravity), "linacc": list(s.linacc),
            "cal": {"sys": sys_, "gyr": gyr, "acc": acc, "mag": mag}, "tempC": s.temp_c}


async def get_state(request: web.Request) -> web.Response:
    return web.json_response(request.app[CTX].state.tick())


async def version(request: web.Request) -> web.Response:
    return web.json_response({"head": __version__, "pico": request.app[CTX].pico_version})


async def healthz(request: web.Request) -> web.Response:
    ctx, api = request.app[CTX], request.app[API]
    return web.json_response({
        "ok": True, "pico": ctx.state.pico_link, "imu": ctx.state.imu_link, "estop": ctx.state.estop,
        "wsClients": len(api.ws_clients), "wsDroppedTotal": api.ws_dropped_total, "version": __version__,
    })


# --- WebSocket ----------------------------------------------------------------------
async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ctx, api = request.app[CTX], request.app[API]
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=WS_QUEUE_MAX)
    queue.put_nowait(ctx.state.tick())

    def push(msg: dict) -> None:
        try:
            queue.put_nowait(msg)
        except asyncio.QueueFull:
            queue.get_nowait()  # drop the oldest; a slow client must never stall the others
            api.ws_dropped_total += 1
            queue.put_nowait(msg)

    unsubscribe = ctx.state.subscribe(push)
    api.ws_clients.add(ws)
    writer = asyncio.create_task(_ws_writer(ws, queue), name="ws-writer")
    try:
        async for msg in ws:  # no command path over the socket; read only to see the close
            log.debug("ignoring WS message of type %s", msg.type)
    finally:
        unsubscribe()
        api.ws_clients.discard(ws)
        writer.cancel()
        await asyncio.gather(writer, return_exceptions=True)
    return ws


async def _ws_writer(ws: web.WebSocketResponse, queue: asyncio.Queue[dict]) -> None:
    try:
        while True:
            await ws.send_json(await queue.get())
    except ConnectionError as exc:  # peer gone or socket closing
        log.info("WS client write failed: %s", exc)
        await ws.close()
    except Exception:
        log.exception("WS writer failed; closing the socket")
        await ws.close()


async def _close_ws_clients(app: web.Application) -> None:
    for ws in list(app[API].ws_clients):
        await ws.close(code=WSCloseCode.GOING_AWAY, message=b"server shutdown")


async def _cancel_tasks(app: web.Application) -> None:
    tasks = list(app[API].tasks)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def _envelope(exc: web.HTTPException) -> web.Response:
    """aiohttp's own errors (404, 405, 413, ...) as the JSON envelope, status and Allow kept."""
    headers = {"Allow": exc.headers["Allow"]} if "Allow" in exc.headers else None
    return web.json_response({"ok": False, "error": exc.text or exc.reason},
                             status=exc.status, headers=headers)


@web.middleware
async def _json_errors(request: web.Request, handler: Callable) -> web.StreamResponse:
    try:
        return await handler(request)
    except web.HTTPException as exc:
        if exc.status < 400 or exc.content_type == "application/json":
            raise
        return _envelope(exc)
    except ProtocolError as exc:
        log.warning("bad reply from pico on %s: %s", request.path, exc)
        raise _error(web.HTTPBadGateway, f"bad reply from pico: {exc}") from exc
    except Exception as exc:
        log.exception("unhandled error on %s %s", request.method, request.path)
        raise _error(web.HTTPInternalServerError, f"internal error: {exc}") from exc


def make_app(ctx: HeadContext) -> web.Application:
    app = web.Application(middlewares=[_json_errors])
    app[CTX] = ctx
    app[API] = _ApiState()
    app.on_shutdown.append(_close_ws_clients)
    app.on_cleanup.append(_cancel_tasks)
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/version", version)
    app.router.add_get("/api/state", get_state)
    app.router.add_post("/api/goto", goto)
    app.router.add_post("/api/track", track)
    app.router.add_post("/api/jog", jog)
    app.router.add_post("/api/stop", stop)
    app.router.add_post("/api/estop", estop)
    app.router.add_post("/api/estop/clear", estop_clear)
    app.router.add_post("/api/enable", enable)
    app.router.add_post("/api/home", home)
    app.router.add_post("/api/setpos", setpos)
    app.router.add_post("/api/reference", reference)
    app.router.add_get("/api/imu", imu_burst)
    app.router.add_get("/api/config", get_config)
    app.router.add_post("/api/config", set_config)
    app.router.add_get("/api/drivers", drivers)
    return app
