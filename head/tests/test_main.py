"""The composition root end to end: real run() over FakeSerial, FakeBNO055 and a real HTTP server."""
import asyncio
import contextlib
import json
import logging
import socket
import time

import aiohttp
import pytest

from plainsight_head.config import HeadConfig
from plainsight_head.main import run
from plainsight_head.persist import JsonStore
from tests.fakes import FakeBNO055, FakeSerial

INIT = ["STATUS", "VER", "CFG", "CFG global track_timeout_ms 1000", "STREAM 100"]
MOTION_VERBS = ("HOME", "MOVE", "MOVER", "TRACK", "JOG", "SETPOS")
WAIT_S = 3.5  # IMU north averages heading for 2 s
STREAM_S = 0.02
OFFSETS = list(range(100, 122))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def until(cond, what: str, timeout: float = WAIT_S) -> None:
    deadline = time.monotonic() + timeout
    while not await _call(cond):
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.01)


async def _call(cond):
    out = cond()
    return await out if asyncio.iscoroutine(out) else out


class Rig:
    """run() as a task, a fake Pico stream, and an HTTP session against the real server."""

    def __init__(self, tmp_path, env: dict | None = None, *, pico_present: bool = True) -> None:
        self.port = free_port()
        self.data = tmp_path / "data"
        self.cfg = HeadConfig.from_env({"HEAD_PORT": str(self.port), "HEAD_DATA_DIR": str(self.data),
                                        **(env or {})})
        self.store = JsonStore(str(self.data))
        self.fake = FakeSerial()
        self.imu_fake = FakeBNO055(heading=90.0, cal=(3, 3, 3, 3))
        self.pico_present = pico_present
        self.hold = lambda: False  # True pauses the fake Pico's status stream
        self.stop = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.http: aiohttp.ClientSession | None = None
        self._streamer: asyncio.Task | None = None

    def serial_factory(self, port: str, baud: int) -> FakeSerial:
        if not self.pico_present:
            raise FileNotFoundError(port)
        self.fake.is_open = True
        return self.fake

    def seed(self, name: str, obj: dict) -> None:
        self.data.mkdir(parents=True, exist_ok=True)
        (self.data / name).write_text(json.dumps(obj))

    def read(self, name: str) -> dict:
        return json.loads((self.data / name).read_text())

    async def __aenter__(self) -> "Rig":
        self.task = asyncio.create_task(run(
            self.cfg, serial_factory=self.serial_factory, imu_open=lambda: self.imu_fake,
            store=self.store, stop_event=self.stop, bind="127.0.0.1"), name="head-run")
        self._streamer = asyncio.create_task(self._stream(), name="test-pico-stream")
        self.http = aiohttp.ClientSession(f"http://127.0.0.1:{self.port}")
        await until(self._server_up, "HTTP server up")
        return self

    async def __aexit__(self, *exc) -> None:
        await self.shutdown()

    async def shutdown(self) -> None:
        self.stop.set()
        try:
            await asyncio.wait_for(asyncio.shield(self.task), 5.0)
        finally:
            self._streamer.cancel()
            await asyncio.gather(self._streamer, return_exceptions=True)
            await self.http.close()

    async def _stream(self) -> None:
        while True:
            await asyncio.sleep(STREAM_S)
            if not self.hold():
                self.fake.emit_status()

    async def _server_up(self) -> bool:
        try:
            async with self.http.get("/healthz") as r:
                return r.status == 200
        except aiohttp.ClientConnectionError:
            return False

    async def get(self, path: str) -> dict:
        async with self.http.get(path) as r:
            assert r.status == 200, await r.text()
            return await r.json()


def booted(caplog) -> bool:
    return any(r.name == "plainsight_head.main" and r.getMessage() == "boot complete"
               for r in caplog.records)


def assert_no_leaked_tasks() -> None:
    left = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    assert left == [], left


async def next_event(sock, name: str, timeout: float = WAIT_S) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        msg = await sock.receive_json(timeout=max(deadline - time.monotonic(), 0.01))
        if msg["type"] == "event" and msg["name"] == name:
            return msg


@pytest.fixture(autouse=True)
def _info_logs(caplog):
    caplog.set_level(logging.INFO, logger="plainsight_head")


async def test_boot_sequence_order(tmp_path, caplog):
    rig = Rig(tmp_path)  # tilt not homed, home_ticks=2, IMU at heading 90 and fully calibrated
    released = asyncio.Event()
    rig.hold = lambda: "HOME tilt" in rig.fake.sent and not released.is_set()
    async with rig:
        await until(lambda: "HOME tilt" in rig.fake.sent, "HOME tilt")
        # homing cannot finish while the stream is held, so this is the server answering mid-boot
        health = await rig.get("/healthz")
        assert health["pico"] is True and health["imu"] is True
        assert not rig.fake.model["tilt"]["homed"]
        released.set()
        await until(lambda: booted(caplog), "boot complete")
        assert rig.fake.sent[:len(INIT) + 1] == [*INIT, "HOME tilt"]
        assert rig.fake.sent.index("SETPOS pan 90.00000") > len(INIT)
        assert rig.fake.model["tilt"]["homed"]
        state = await rig.get("/api/state")
        assert state["ref"]["pan"] == "imu" and state["ref"]["persisted"] is True
        assert state["imu"]["ok"] is True and state["imu"]["heading"] == 90.0
        assert (await rig.get("/api/version"))["pico"] == "plainsight-ptz 0.1.0"
        assert rig.read("pan-reference.json")["source"] == "imu"
        assert rig.read("bno055-offsets.json") == {"offsets": list(range(22))}
    assert_no_leaked_tasks()


async def test_no_auto_home_and_pan_restore_none_sends_no_motion(tmp_path, caplog):
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0", "HEAD_PAN_RESTORE": "none"})
    rig.seed("bno055-offsets.json", {"offsets": OFFSETS})
    async with rig:
        await until(lambda: booted(caplog), "boot complete")
        await asyncio.sleep(0.2)  # give any stray motion command time to show up
        assert rig.fake.sent == INIT
        assert not any(line.split()[0] in MOTION_VERBS for line in rig.fake.sent)
        assert rig.imu_fake.offsets_writes[0] == bytes(OFFSETS)
        assert (await rig.get("/api/state"))["ref"]["pan"] == "none"
    assert rig.fake.sent == [*INIT, "STOP"]
    assert_no_leaked_tasks()


async def test_imu_only_ticks_while_pico_down(tmp_path, caplog):
    rig = Rig(tmp_path, pico_present=False)
    async with rig:
        health = await rig.get("/healthz")
        assert health["pico"] is False
        await until(async_imu_up(rig), "IMU link up")
        sock = await rig.http.ws_connect("/ws")
        try:
            first = await sock.receive_json(timeout=WAIT_S)  # the on-connect tick
            assert first["type"] == "tick"
            arrivals, ticks = [], []
            deadline = time.monotonic() + 1.3
            while time.monotonic() < deadline:
                with contextlib.suppress(asyncio.TimeoutError):
                    msg = await sock.receive_json(timeout=max(deadline - time.monotonic(), 0.01))
                    if msg["type"] == "tick":
                        arrivals.append(time.monotonic())
                        ticks.append(msg)
        finally:
            await sock.close()
        assert 2 <= len(ticks) <= 3, ticks
        gaps = [b - a for a, b in zip(arrivals, arrivals[1:])]
        assert all(0.35 < g < 0.7 for g in gaps), gaps
        for tick in ticks:
            assert "axes" not in tick and "enabled" not in tick
            assert tick["link"] == {"pico": False, "imu": True}
            assert tick["imu"]["ok"] is True and tick["imu"]["heading"] == 90.0
        assert [t["seq"] for t in ticks] == list(range(ticks[0]["seq"], ticks[0]["seq"] + len(ticks)))
    assert rig.fake.sent == []
    assert_no_leaked_tasks()


def async_imu_up(rig):
    async def check() -> bool:
        return (await rig.get("/healthz"))["imu"] is True
    return check


async def _boot_referenced_then_reboot_pico(rig: Rig, caplog, *, stale_file: bool):
    """Boot restoring pan 12.5 from the file, then power-cycle the Pico; returns (mark, events)."""
    await until(lambda: booted(caplog), "boot complete")
    assert rig.fake.sent == [*INIT, "SETPOS pan 12.50000"]

    async def pan_homed() -> bool:
        st = await rig.get("/api/state")
        return st["ref"]["pan"] == "host" and st["axes"]["pan"]["homed"]
    await until(pan_homed, "pan referenced and homed")
    if stale_file:
        rig.seed("pan-reference.json", {"pos": 12.5, "source": "host", "t": time.time() - 10**7})
    sock = await rig.http.ws_connect("/ws")
    events = []
    try:
        mark = len(rig.fake.sent)
        rig.fake.fail_next_reads(1)  # the link drops ...
        rig.fake.reboot()            # ... because the Pico power-cycled
        await until(lambda: "STREAM 100" in rig.fake.sent[mark:], "re-init after reconnect")
        events.append(await next_event(sock, "pan_reference"))
        if not stale_file:
            events.append(await next_event(sock, "pan_reference"))
    finally:
        await sock.close()
    return mark, [e["detail"] for e in events]


async def test_reconnect_after_pico_reboot_restores_a_fresh_persisted_reference(tmp_path, caplog):
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0"})
    rig.seed("pan-reference.json", {"pos": 12.5, "source": "host", "t": time.time()})
    async with rig:
        mark, details = await _boot_referenced_then_reboot_pico(rig, caplog, stale_file=False)
        assert details == [{"source": "none", "reason": "pan unhomed"},
                           {"source": "host", "pan": 12.5, "previous": None}]
        state = await rig.get("/api/state")
        assert state["ref"]["pan"] == "host" and state["link"]["pico"] is True
        await asyncio.sleep(0.2)  # rule 2 only: a SETPOS (no motion), no homing, no IMU north
        assert rig.fake.sent[mark:] == [*INIT, "SETPOS pan 12.50000"]
    assert_no_leaked_tasks()


async def test_reconnect_after_pico_reboot_without_a_fresh_file_drops_the_reference(tmp_path, caplog):
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0"})
    rig.seed("pan-reference.json", {"pos": 12.5, "source": "host", "t": time.time()})
    async with rig:
        mark, details = await _boot_referenced_then_reboot_pico(rig, caplog, stale_file=True)
        assert details == [{"source": "none", "reason": "pan unhomed"}]
        state = await rig.get("/api/state")
        assert state["ref"]["pan"] == "none" and state["link"]["pico"] is True
        await asyncio.sleep(0.2)  # nothing else follows the re-init: no homing, no referencing
        assert rig.fake.sent[mark:] == INIT
    assert_no_leaked_tasks()


async def test_shutdown_stops_and_persists(tmp_path, caplog):
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0"})
    rig.seed("pan-reference.json", {"pos": 10.0, "source": "host", "t": time.time()})
    async with rig:
        await until(lambda: booted(caplog), "boot complete")
        rig.fake.model["pan"]["pos"] = 33.0  # pan moved since the file was last written

        async def pan_at_33() -> bool:
            return (await rig.get("/api/state"))["axes"]["pan"]["pos"] == 33.0
        await until(pan_at_33, "pan at 33")
        assert rig.read("pan-reference.json")["pos"] == 10.0
        rig.fake.reply_override["STOP"] = ""  # unanswered: shutdown sits in its 1 s STOP wait
        mark = len(rig.fake.sent)
        rig.stop.set()
        await until(lambda: "STOP" in rig.fake.sent[mark:], "shutdown STOP")
        async with aiohttp.ClientSession() as s:  # mid-shutdown, motion must be refused
            try:
                async with s.post(f"http://127.0.0.1:{rig.port}/api/jog", json={"pan": 5}) as r:
                    assert r.status == 503, await r.text()
            except aiohttp.ClientConnectionError:
                pass
        await rig.shutdown()
        assert rig.task.done() and rig.task.exception() is None
        assert rig.fake.sent[mark:] == ["STOP"]
        last_stop = len(rig.fake.sent) - 1 - rig.fake.sent[::-1].index("STOP")
        assert not any(line.split()[0] in MOTION_VERBS for line in rig.fake.sent[last_stop:])
        saved = rig.read("pan-reference.json")
        assert saved["pos"] == 33.0 and saved["source"] == "host"
        assert rig.imu_fake.closed and not rig.fake.is_open
        async with aiohttp.ClientSession() as s:
            with pytest.raises(aiohttp.ClientConnectionError):
                await s.get(f"http://127.0.0.1:{rig.port}/healthz")
    assert_no_leaked_tasks()


async def test_shutdown_closes_hardware_even_if_a_step_fails(tmp_path, caplog, monkeypatch):
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0", "HEAD_PAN_RESTORE": "none"})
    async with rig:
        await until(lambda: booted(caplog), "boot complete")
        from plainsight_head.reference import PanReference

        async def boom(self) -> None:
            raise RuntimeError("persist exploded")
        monkeypatch.setattr(PanReference, "persist_now", boom)
    assert rig.task.exception() is None
    assert rig.fake.sent[-1] == "STOP"
    assert rig.imu_fake.closed and not rig.fake.is_open
    assert any("persist pan failed" in r.getMessage() for r in caplog.records)
    assert_no_leaked_tasks()



def stall_server(monkeypatch, where: str) -> asyncio.Event:
    """Wrap main.make_app so the app stalls shutdown: a held-open handler or a hung on_shutdown."""
    from plainsight_head import main as main_mod

    entered = asyncio.Event()

    async def hang(*_args):
        entered.set()
        await asyncio.Event().wait()

    def make_app(ctx):
        app = main_mod_make_app(ctx)
        if where == "handler":
            app.router.add_get("/hang", hang)
        else:
            app.on_shutdown.insert(0, hang)
        return app

    main_mod_make_app = main_mod.make_app
    monkeypatch.setattr(main_mod, "make_app", make_app)
    return entered


async def stop_and_time_stop(rig: Rig) -> float:
    mark = len(rig.fake.sent)
    t0 = time.monotonic()
    rig.stop.set()
    await until(lambda: "STOP" in rig.fake.sent[mark:], "shutdown STOP", timeout=5.0)
    return time.monotonic() - t0


@pytest.mark.parametrize("where", ["handler", "on_shutdown"])
async def test_stalled_http_close_does_not_delay_stop(tmp_path, caplog, monkeypatch, where):
    entered = stall_server(monkeypatch, where)
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0", "HEAD_PAN_RESTORE": "none"})
    async with rig:
        await until(lambda: booted(caplog), "boot complete")
        held = None
        if where == "handler":
            held = asyncio.create_task(rig.http.get("/hang"))
            await until(entered.is_set, "handler entered")
        assert await stop_and_time_stop(rig) < 3.0
        await asyncio.wait_for(asyncio.shield(rig.task), 5.0)
        if held is not None:
            with pytest.raises(aiohttp.ClientError):
                await held
    assert rig.task.exception() is None
    assert rig.fake.sent[-1] == "STOP"
    assert rig.imu_fake.closed and not rig.fake.is_open
    assert_no_leaked_tasks()


# --- C1: motion that survives a link drop or a restart is stopped ---------------------------

@pytest.fixture
def heads(monkeypatch):
    """Every main.Head that run() builds, so a test can inspect its dead-man."""
    from plainsight_head import main as main_mod

    built = []

    class Recording(main_mod.Head):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            built.append(self)

    monkeypatch.setattr(main_mod, "Head", Recording)
    return built


async def post_json(rig: Rig, path: str, body=None) -> tuple[int, dict]:
    async with rig.http.post(path, json=body) as r:
        return r.status, await r.json()


async def drop_link(rig: Rig, *, stay_down: bool = False) -> int:
    """Fail one read (the Pico keeps power and keeps jogging); returns the `sent` mark."""
    if stay_down:
        rig.pico_present = False
    mark = len(rig.fake.sent)
    rig.fake.fail_next_reads(1)

    async def down() -> bool:
        return (await rig.get("/healthz"))["pico"] is False
    await until(down, "pico link down")
    return mark


async def test_jog_across_a_link_flap_is_stopped_on_reconnect(tmp_path, caplog, heads):
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0", "HEAD_PAN_RESTORE": "none"})
    async with rig:
        await until(lambda: booted(caplog), "boot complete")
        head = heads[0]
        assert (await post_json(rig, "/api/jog", {"pan": 2}))[0] == 200
        assert rig.fake.model["pan"]["mode"] == "V"
        mark = await drop_link(rig)
        await asyncio.sleep(0.7)  # the 500 ms dead-man expires while the link is down
        assert head.deadman.armed == {"pan"}  # a failed STOP must not disarm it
        await until(lambda: "STOP pan" in rig.fake.sent[mark:], "STOP pan after reconnect")
        await until(lambda: head.deadman.armed == set(), "dead-man disarmed")
        assert rig.fake.model["pan"]["mode"] == "I" and rig.fake.model["pan"]["vel"] == 0.0
    failures = [r for r in caplog.records if "jog dead-man: STOP pan failed" in r.getMessage()]
    assert len(failures) == 1, [r.getMessage() for r in failures]  # one line, not one per poll
    assert_no_leaked_tasks()


async def test_armed_jog_is_stopped_by_init_on_reconnect(tmp_path, caplog, heads):
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0", "HEAD_PAN_RESTORE": "none",
                         "HEAD_JOG_DEADMAN_MS": "10000"})  # the dead-man cannot be what stops it
    async with rig:
        await until(lambda: booted(caplog), "boot complete")
        head = heads[0]
        await post_json(rig, "/api/jog", {"tilt": -1.5})
        mark = await drop_link(rig)
        await until(lambda: "STATUS" in rig.fake.sent[mark:], "re-init after reconnect")
        await until(lambda: "STREAM 100" in rig.fake.sent[mark:], "re-init complete")
        after = rig.fake.sent[mark:]
        assert after[:2] == ["STATUS", "STOP tilt"], after
        assert head.deadman.armed == set()
        assert rig.fake.model["tilt"]["mode"] == "I"


async def test_estop_while_link_down_is_resent_on_reconnect(tmp_path, caplog, heads):
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0", "HEAD_PAN_RESTORE": "none"})
    async with rig:
        await until(lambda: booted(caplog), "boot complete")
        head = heads[0]
        await post_json(rig, "/api/jog", {"pan": 2})
        mark = await drop_link(rig, stay_down=True)
        await until(lambda: not head.state.pico_link, "link down in state")
        status, body = await post_json(rig, "/api/estop")
        assert status == 503 and body["error"] == "pico link down"
        assert head.state.estop is True
        assert head.deadman.armed == {"pan"}  # ESTOP did not go through; keep guarding the jog
        rig.pico_present = True
        await until(lambda: "ESTOP" in rig.fake.sent[mark:], "ESTOP re-sent on reconnect")
        await until(lambda: head.deadman.armed == set(), "dead-man cleared after ESTOP")
        assert rig.fake.model["pan"]["mode"] == "I"
        assert (await rig.get("/healthz"))["estop"] is True  # the head's latch is unchanged


async def test_fresh_process_stops_an_orphan_jog_at_init(tmp_path, caplog):
    rig = Rig(tmp_path, {"HEAD_AUTO_HOME": "0", "HEAD_PAN_RESTORE": "none"})
    rig.fake.model["pan"].update(mode="V", vel=2.0)  # left jogging by a SIGKILLed predecessor
    async with rig:
        await until(lambda: booted(caplog), "boot complete")
        assert rig.fake.sent[:2] == ["STATUS", "STOP pan"]
        assert rig.fake.sent[2:] == INIT[1:]
        assert rig.fake.model["pan"]["mode"] == "I"
    assert_no_leaked_tasks()


async def test_boot_skips_home_tilt_while_estop_latched(tmp_path, caplog, monkeypatch):
    from plainsight_head import main as main_mod

    real_boot = main_mod.Head.boot

    async def latched_boot(self):
        self.state.set_estop(True)  # the operator hit E-STOP before boot reached the homing
        await real_boot(self)
    monkeypatch.setattr(main_mod.Head, "boot", latched_boot)
    rig = Rig(tmp_path, {"HEAD_PAN_RESTORE": "none"})  # auto-home on, tilt not homed
    async with rig:
        await until(lambda: booted(caplog), "boot complete")
        assert "HOME tilt" not in rig.fake.sent and rig.fake.sent == INIT
        assert any("E-STOP is latched; skipping HOME tilt" in r.getMessage() for r in caplog.records)
