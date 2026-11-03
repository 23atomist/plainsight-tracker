"""WebSocket telemetry fan-out: every tick and event to every client (spec 4.3)."""
from __future__ import annotations

import asyncio
import logging

from aiohttp import WSCloseCode, web

from .state import HeadState

log = logging.getLogger(__name__)

WS_QUEUE_MAX = 50


class WsHub:
    """Read-only telemetry sockets. Each client has its own bounded queue; when a client falls
    behind, its oldest message is dropped, so a slow client never stalls the others."""

    def __init__(self, state: HeadState) -> None:
        self._state = state
        self.clients: set[web.WebSocketResponse] = set()
        self.dropped_total = 0

    async def handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=WS_QUEUE_MAX)
        queue.put_nowait(self._state.tick())

        def push(msg: dict) -> None:
            try:
                queue.put_nowait(msg)
            except asyncio.QueueFull:
                queue.get_nowait()  # drop the oldest
                self.dropped_total += 1
                queue.put_nowait(msg)

        unsubscribe = self._state.subscribe(push)
        self.clients.add(ws)
        writer = asyncio.create_task(_writer(ws, queue), name="ws-writer")
        try:
            async for msg in ws:  # no command path over the socket; read only to see the close
                log.debug("ignoring WS message of type %s", msg.type)
        finally:
            unsubscribe()
            self.clients.discard(ws)
            writer.cancel()
            await asyncio.gather(writer, return_exceptions=True)
        return ws

    async def close_all(self, _app: web.Application | None = None) -> None:
        """Close every client with 1001 (an aiohttp on_shutdown hook)."""
        for ws in list(self.clients):
            await ws.close(code=WSCloseCode.GOING_AWAY, message=b"server shutdown")


async def _writer(ws: web.WebSocketResponse, queue: asyncio.Queue[dict]) -> None:
    try:
        while True:
            await ws.send_json(await queue.get())
    except ConnectionError as exc:  # peer gone or socket closing
        log.info("WS client write failed: %s", exc)
        await ws.close()
    except Exception:
        log.exception("WS writer failed; closing the socket")
        await ws.close()
