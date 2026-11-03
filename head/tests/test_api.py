"""HTTP and WebSocket API over the real aiohttp app, PicoLink, and FakeSerial."""
import asyncio
import time

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from plainsight_head import __version__
from plainsight_head.api import make_app
from plainsight_head.protocol import AXES

WAIT_S = 2.0


@pytest.fixture
async def client(ctx):
    async with TestClient(TestServer(make_app(ctx))) as c:
        yield c


@pytest.fixture
async def ws(client):
    sock = await client.ws_connect("/ws")
    first = await sock.receive_json(timeout=WAIT_S)
    assert first["type"] == "tick"
    try:
        yield sock
    finally:
        await sock.close()


async def next_event(sock, name: str) -> dict:
    deadline = time.monotonic() + WAIT_S
    while True:
        msg = await sock.receive_json(timeout=max(deadline - time.monotonic(), 0.01))
        if msg["type"] == "event" and msg["name"] == name:
            return msg


async def wait_for(cond, what: str) -> None:
    deadline = time.monotonic() + WAIT_S
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.01)


async def post(client, path: str, body=None, status: int = 200) -> dict:
    resp = await client.post(path, json=body) if body is not None else await client.post(path)
    data = await resp.json()
    assert resp.status == status, data
    return data


async def get(client, path: str, status: int = 200) -> dict:
    resp = await client.get(path)
    data = await resp.json()
    assert resp.status == status, data
    return data


async def test_healthz_and_version(client, ctx):
    h = await get(client, "/healthz")
    assert h == {"ok": True, "pico": True, "imu": True, "estop": False,
                 "wsClients": 0, "wsDroppedTotal": 0, "version": __version__}
    assert await get(client, "/api/version") == {"head": __version__, "pico": ctx.pico_version}
    assert isinstance(ctx.pico_version, str) and ctx.pico_version


async def test_state_returns_latest_tick(client):
    state = await get(client, "/api/state")
    sock = await client.ws_connect("/ws")
    try:
        tick = await sock.receive_json(timeout=WAIT_S)
    finally:
        await sock.close()
    assert state["type"] == tick["type"] == "tick"
    assert set(state) == set(tick)
    assert set(state["axes"]) == set(AXES)
    assert set(state["axes"]["pan"]) == set(tick["axes"]["pan"])


async def test_goto_sends_move_and_returns_202(client, ctx):
    assert await post(client, "/api/goto", {"pan": 10, "tilt": 20}, 202) == {"ok": True}
    assert "MOVE pan 10.00000 tilt 20.00000" in ctx.fake.sent


async def test_goto_while_moving_is_accepted(client, ctx):
    ctx.fake.model["pan"]["vel"] = 3.0
    await ctx.status_now()
    assert ctx.state.pico.axes["pan"].vel != 0
    await post(client, "/api/goto", {"pan": -5}, 202)
    assert "MOVE pan -5.00000" in ctx.fake.sent


async def test_track_sends_track_pairs(client, ctx):
    await post(client, "/api/track", {"pan": {"pos": 1, "vel": 0.5}})
    assert "TRACK pan 1.00000 0.50000" in ctx.fake.sent


@pytest.mark.parametrize("body", [
    {"pan": {"pos": float("nan"), "vel": 0}},
    {"pan": {"pos": "1", "vel": 0}},
    {"yaw": {"pos": 1, "vel": 0}},
    {},
    {"tilt": {"pos": 1, "vel": float("inf")}},
    {"pan": {"pos": 1, "vel": 0, "acc": 1}},
    {"pan": 1},
    {"pan": {"pos": True, "vel": 0}},
])
async def test_track_rejects_bad_bodies_and_sends_nothing(client, ctx, body):
    data = await post(client, "/api/track", body, 400)
    assert data["ok"] is False and data["error"]
    assert not [line for line in ctx.fake.sent if line.startswith("TRACK")]


async def test_jog_arms_deadman_and_zero_disarms(client, ctx):
    await post(client, "/api/jog", {"pan": 2})
    assert "JOG pan 2.00000" in ctx.fake.sent
    assert ctx.deadman.armed == {"pan"}
    await post(client, "/api/jog", {"pan": 0})
    assert "JOG pan 0.00000" in ctx.fake.sent
    assert ctx.deadman.armed == set()


async def test_deadman_expiry_sends_stop(client, ctx):
    await post(client, "/api/jog", {"pan": 2})
    t0 = time.monotonic()
    await wait_for(lambda: "STOP pan" in ctx.fake.sent, "dead-man STOP pan")
    assert time.monotonic() - t0 >= ctx.cfg.jog_deadman_ms / 1000 * 0.9
    assert ctx.deadman.armed == set()


async def test_stop_clears_deadman(client, ctx):
    await post(client, "/api/jog", {"pan": 2, "tilt": 1})
    assert ctx.deadman.armed == {"pan", "tilt"}
    await post(client, "/api/stop", {"axes": ["pan"]})
    assert ctx.fake.sent[-1] == "STOP pan"
    assert ctx.deadman.armed == {"tilt"}
    await post(client, "/api/stop")
    assert ctx.fake.sent[-1] == "STOP"
    assert ctx.deadman.armed == set()
    await post(client, "/api/stop", {"axes": ["yaw"]}, 400)
    assert ctx.fake.sent[-1] == "STOP"


async def test_estop_latches_and_motion_returns_423(client, ctx, ws):
    await post(client, "/api/jog", {"pan": 2})
    await post(client, "/api/estop")
    assert ctx.fake.sent[-1] == "ESTOP"
    assert ctx.state.estop is True and ctx.deadman.armed == set()
    assert (await next_event(ws, "estop"))["type"] == "event"
    sent_before = len(ctx.fake.sent)
    for path, body in [("/api/goto", {"pan": 1}), ("/api/track", {"pan": {"pos": 1, "vel": 0}}),
                       ("/api/jog", {"pan": 1}), ("/api/home", {})]:
        data = await post(client, path, body, 423)
        assert data["ok"] is False and data["error"]
    assert len(ctx.fake.sent) == sent_before
    ctx.state.set_pico_link(False)
    await post(client, "/api/goto", {"pan": 1}, 423)  # the latch wins over a down link
    ctx.state.set_pico_link(True)
    await post(client, "/api/stop")
    assert ctx.fake.sent[-1] == "STOP"
    assert (await get(client, "/healthz"))["estop"] is True
    await post(client, "/api/estop/clear")
    assert ctx.state.estop is False
    assert (await next_event(ws, "estop_cleared"))["type"] == "event"
    await post(client, "/api/goto", {"pan": 1}, 202)
    assert ctx.fake.sent[-1] == "MOVE pan 1.00000"


async def test_link_down_returns_503(client, ctx):
    ctx.state.set_pico_link(False)
    data = await post(client, "/api/goto", {"pan": 1}, 503)
    assert data["ok"] is False and data["error"]
    assert not [line for line in ctx.fake.sent if line.startswith("MOVE")]
    state = await get(client, "/api/state")
    assert "axes" not in state and state["link"]["pico"] is False
    assert (await get(client, "/healthz"))["pico"] is False


async def test_home_defaults_and_event_forwarding(client, ctx, ws):
    await post(client, "/api/home", {}, 202)
    assert ctx.fake.sent[-1] == "HOME"
    await post(client, "/api/home", {"axes": ["tilt"]}, 202)
    assert ctx.fake.sent[-1] == "HOME tilt"
    ctx.fake.emit_raw(b"*E homed tilt\n")
    ev = await next_event(ws, "homed")
    assert ev["axis"] == "tilt" and ev["detail"] is None and isinstance(ev["t"], int)


async def test_setpos_sets_host_ref_and_409_when_moving(client, ctx):
    await post(client, "/api/setpos", {"pan": 12.5, "tilt": 3})
    assert "SETPOS tilt 3.00000" in ctx.fake.sent and "SETPOS pan 12.50000" in ctx.fake.sent
    assert ctx.fake.sent.index("SETPOS tilt 3.00000") < ctx.fake.sent.index("SETPOS pan 12.50000")
    assert ctx.state.ref.source == "host"
    assert (await get(client, "/api/state"))["ref"]["pan"] == "host"

    ctx.fake.model["pan"]["vel"] = 1.0
    await ctx.status_now()
    sent_before = len(ctx.fake.sent)
    data = await post(client, "/api/setpos", {"pan": 1}, 409)
    assert data["ok"] is False and data["error"]
    assert len(ctx.fake.sent) == sent_before

    ctx.fake.model["pan"]["vel"] = 0.0
    await ctx.status_now()
    ctx.fake.reply_override["SETPOS"] = "err axis moving"
    await post(client, "/api/setpos", {"pan": 1}, 409)
    assert ctx.fake.sent[-1] == "SETPOS pan 1.00000"


async def test_enable_off_clears_ref(client, ctx):
    await post(client, "/api/setpos", {"pan": 1})
    assert ctx.state.ref.source == "host"
    await post(client, "/api/enable", {"on": False})
    assert ctx.fake.sent[-1] == "ENABLE 0"
    assert ctx.state.ref.source == "none"
    await post(client, "/api/enable", {"on": True})
    assert ctx.fake.sent[-1] == "ENABLE 1"
    await post(client, "/api/enable", {"on": 1}, 400)
    assert ctx.fake.sent[-1] == "ENABLE 1"


async def test_reference_returns_202_and_event(client, ctx_imu_ready, ws):
    ctx = ctx_imu_ready
    ctx.ref_override(heading_window_s=0.5)
    assert await post(client, "/api/reference", {}, 202) == {"ok": True}
    await wait_for(lambda: ctx.ref.busy, "reference to start")
    assert (await post(client, "/api/reference", None, 409))["error"] == "reference busy"
    assert (await post(client, "/api/setpos", {"pan": 1}, 409))["error"] == "reference busy"
    ev = await next_event(ws, "pan_reference")
    assert ev["detail"]["source"] == "imu"
    assert ctx.state.ref.source == "imu"
    assert [line for line in ctx.fake.sent if line.startswith("SETPOS")] == ["SETPOS pan 0.00000"]


async def test_imu_burst_shape_and_clamp(client, ctx):
    data = await get(client, "/api/imu?n=5000")
    assert data["n"] == 1000 and len(data["samples"]) == 1000
    s = data["samples"][0]
    assert set(s) == {"t", "heading", "roll", "pitch", "quat", "gravity", "linacc", "cal", "tempC"}
    assert set(s["cal"]) == {"sys", "gyr", "acc", "mag"}
    assert len(s["quat"]) == 4 and len(s["gravity"]) == 3 and len(s["linacc"]) == 3
    assert (await get(client, "/api/imu?n=0"))["n"] == 1
    assert len((await get(client, "/api/imu"))["samples"]) == 100
    await get(client, "/api/imu?n=abc", 400)
    await ctx.imu.close()
    assert await get(client, "/api/imu?n=5", 503) == {"ok": False, "error": "imu not ok"}


async def test_config_get_set_guard_and_save(client, ctx, ws):
    cfg = await get(client, "/api/config")
    assert set(cfg) == {*AXES, "global", "head"}
    assert cfg["pan"]["maxv"] == 100.0
    assert cfg["head"]["port"] == ctx.cfg.port and cfg["head"]["jog_deadman_ms"] == ctx.cfg.jog_deadman_ms

    await post(client, "/api/config", {"scope": "pan", "key": "vmax", "value": 20})
    assert ctx.fake.sent[-1] == "CFG pan vmax 20"
    ev = await next_event(ws, "config")
    assert ev["detail"] == {"scope": "pan", "key": "vmax", "value": 20}

    sent_before = len(ctx.fake.sent)
    for body in [{"scope": "global", "key": "track_timeout_ms", "value": 900},
                 {"scope": "pan", "key": "socket", "value": 1},
                 {"scope": "pan", "key": "host_baud", "value": 9600}]:
        data = await post(client, "/api/config", body, 403)
        assert data == {"ok": False, "error": "guarded setting; add ?force=1"}
    for body in [{"scope": "pan", "key": "vmax\nESTOP", "value": 1},
                 {"scope": "pan", "key": "vmax", "value": float("nan")},
                 {"scope": "pan", "key": "vmax"}]:
        await post(client, "/api/config", body, 400)
    assert len(ctx.fake.sent) == sent_before

    await post(client, "/api/config?force=1", {"scope": "global", "key": "track_timeout_ms", "value": 900})
    assert ctx.fake.sent[-1] == "CFG global track_timeout_ms 900"

    await post(client, "/api/config", {"scope": "tilt", "key": "acc", "value": 12.5, "save": True})
    assert ctx.fake.sent[-2:] == ["CFG tilt acc 12.5", "SAVE"]


async def test_drivers_parsed(client):
    data = await get(client, "/api/drivers")
    assert data == {"drivers": {ax: {"sg": "0", "cs": "0"} for ax in AXES}}


async def test_ws_sends_latest_tick_on_connect_then_ticks(client, ctx):
    await ctx.streaming(False)
    await ctx.status_now()
    latest = ctx.state.seq
    sock = await client.ws_connect("/ws")
    try:
        first = await sock.receive_json(timeout=WAIT_S)
        assert first["type"] == "tick" and first["seq"] == latest
        assert (await get(client, "/healthz"))["wsClients"] == 1
        ctx.fake.emit_status()
        nxt = await sock.receive_json(timeout=WAIT_S)
        assert nxt["type"] == "tick" and nxt["seq"] == latest + 1
    finally:
        await sock.close()
    await wait_for(lambda: not ctx.state._subs, "the WS subscription to be removed")


async def test_ws_slow_client_drops_oldest_without_blocking_others(client, ctx, monkeypatch):
    await ctx.streaming(False)
    stalled = asyncio.Event()

    async def stall(self, *args, **kwargs):  # a client whose TCP window never opens
        stalled.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(web.WebSocketResponse, "send_json", stall)
    slow = await client.ws_connect("/ws")
    await asyncio.wait_for(stalled.wait(), WAIT_S)
    monkeypatch.undo()  # the slow client's writer stays parked inside stall()

    fast = await client.ws_connect("/ws")
    try:
        first = await fast.receive_json(timeout=WAIT_S)
        seqs = []
        for _ in range(200):
            ctx.fake.emit_status()
            msg = await fast.receive_json(timeout=WAIT_S)
            seqs.append(msg["seq"])
        assert seqs == list(range(first["seq"] + 1, first["seq"] + 201))
        health = await get(client, "/healthz")
        assert health["wsClients"] == 2
        assert health["wsDroppedTotal"] > 0
    finally:
        await fast.close()
        await slow.close()
