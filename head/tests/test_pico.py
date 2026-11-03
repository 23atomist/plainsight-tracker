import asyncio
import logging
import time

import pytest

from plainsight_head.pico import PicoError, PicoLink, PicoTimeout
from tests.fakes import FakeSerial


async def make_link(fake, **kw):
    seen = {"status": [], "events": [], "link": []}
    link = PicoLink("/dev/fake", 115200, on_status=seen["status"].append, on_event=seen["events"].append,
                    on_link=seen["link"].append, serial_factory=lambda p, b: fake, **kw)
    await link.start()
    return link, seen


async def test_command_returns_data_lines_and_ok():
    fake = FakeSerial(); link, _ = await make_link(fake)
    assert await link.command("VER") == ["V plainsight-ptz 0.1.0"]
    assert fake.sent[-1] == "VER"
    await link.close()


async def test_err_reply_raises_with_reason():
    fake = FakeSerial(); link, _ = await make_link(fake)
    with pytest.raises(PicoError) as e:
        await link.command("BOGUS")
    assert e.value.reason == "unknown command"
    await link.close()


async def test_timeout_when_no_terminal_line():
    fake = FakeSerial(); fake.reply_override["VER"] = ""   # swallow
    link, _ = await make_link(fake)
    with pytest.raises(PicoTimeout):
        await link.command("VER", timeout_s=0.2)
    await link.close()


async def test_command_refuses_embedded_newlines():
    fake = FakeSerial(); link, _ = await make_link(fake)
    for line in ("STOP\nESTOP", "STOP\r", "CFG global\n x 1"):
        with pytest.raises(PicoError) as e:
            await link.command(line)
        assert e.value.reason == "line contains a newline"
    assert fake.sent == []
    await link.close()


async def test_async_lines_route_to_callbacks_not_replies():
    fake = FakeSerial(); link, seen = await make_link(fake)
    fake.emit_status(); fake.emit_raw(b"*E homed tilt\n")
    await asyncio.sleep(0.05)
    assert len(seen["status"]) == 1 and seen["events"][0].name == "homed"
    assert await link.command("VER") == ["V plainsight-ptz 0.1.0"]   # queue not polluted
    await link.close()


async def test_garbled_lines_are_skipped_and_reader_survives():
    fake = FakeSerial(); link, seen = await make_link(fake)
    fake.emit_raw(b"*S pos=1.0,2.0 vel=\n\xff\xfe garbage\n"); fake.emit_status()
    await asyncio.sleep(0.05)
    assert len(seen["status"]) == 1
    await link.close()


class CountingFactory:
    def __init__(self, fake, fail_first=0):
        self.fake, self.calls, self.fail_first = fake, 0, fail_first

    def __call__(self, port, baud):
        self.calls += 1
        if self.calls <= self.fail_first:
            raise OSError("no such port")
        self.fake.is_open = True
        return self.fake


async def test_link_loss_and_reconnect():
    fake = FakeSerial(); reconnected = []; factory = CountingFactory(fake)
    seen = {"link": []}
    async def on_reconnect(): reconnected.append(1)
    link = PicoLink("/dev/fake", 115200, on_status=lambda s: None, on_event=lambda e: None,
                    on_link=seen["link"].append, serial_factory=factory,
                    stale_s=0.1, reconnect_s=0.05, on_reconnect=on_reconnect)
    await link.start()
    link.expect_stream = True
    down_errors = []
    for _ in range(40):                           # no status lines -> stale -> drop
        await asyncio.sleep(0.01)
        if not link.connected:
            try: await link.command("VER")
            except PicoError as e: down_errors.append(e.reason)
            break
    assert False in seen["link"] and down_errors == ["link down"]
    await asyncio.sleep(0.3)                      # reopens on its own, no emit_status()
    assert seen["link"][-1] is True and link.connected and reconnected == [1]
    assert factory.calls == 2 and link.expect_stream is False
    await link.close()


async def test_stale_drop_closes_port_and_calls_factory_again():
    fake = FakeSerial(); factory = CountingFactory(fake)
    closed = []
    orig = fake.close
    fake.close = lambda: (closed.append(1), orig())
    link, seen = await make_link(fake, stale_s=0.1, reconnect_s=0.05)
    link._factory = factory
    link.expect_stream = True
    await asyncio.sleep(0.4)
    assert closed and factory.calls >= 1 and seen["link"][:3] == [True, False, True]
    await link.close()


async def test_start_tolerates_absent_port():
    fake = FakeSerial(); factory = CountingFactory(fake, fail_first=2)
    seen = []
    link = PicoLink("/dev/fake", 115200, on_status=lambda s: None, on_event=lambda e: None,
                    on_link=seen.append, serial_factory=factory, reconnect_s=0.05)
    await link.start()
    assert link.connected is False and seen == [False]
    await asyncio.sleep(0.4)
    assert link.connected and seen == [False, True] and factory.calls == 3
    assert await link.command("VER") == ["V plainsight-ptz 0.1.0"]
    await link.close()


async def test_command_inside_on_reconnect_succeeds():
    fake = FakeSerial(); results = []
    link_ref = {}
    async def on_reconnect(): results.append(await link_ref["l"].command("VER"))
    link, _ = await make_link(fake, reconnect_s=0.05, on_reconnect=on_reconnect)
    link_ref["l"] = link
    fake.fail_next_reads(1)
    await asyncio.sleep(0.3)
    assert results == [["V plainsight-ptz 0.1.0"]]
    await link.close()


async def test_garbled_line_during_command_does_not_pollute_data():
    fake = FakeSerial(); link, _ = await make_link(fake)
    fake.reply_override["CFG"] = ""
    task = asyncio.create_task(link.command("CFG"))
    await asyncio.sleep(0.05)
    fake.emit_raw(b"\xff\xfe garbage\nC pan maxv 1\nok\n")
    assert await task == ["C pan maxv 1"]
    await link.close()


async def test_queued_command_fails_cleanly_when_link_drops():
    fake = FakeSerial(); fake.reply_override["VER"] = ""
    link, _ = await make_link(fake, reconnect_s=5.0)
    a = asyncio.create_task(link.command("VER", timeout_s=5.0))
    await asyncio.sleep(0.05)
    b = asyncio.create_task(link.command("STATUS"))
    await asyncio.sleep(0.02)
    fake.fail_next_reads(1)
    for t in (a, b):
        with pytest.raises(PicoError) as e:
            await t
        assert e.value.reason == "link down"
    await link.close()


async def test_close_racing_stale_teardown_is_clean():
    for _ in range(5):
        fake = FakeSerial(timeout=0.1)
        link, _ = await make_link(fake, stale_s=0.1, reconnect_s=0.05)
        link.expect_stream = True
        for _ in range(100):
            await asyncio.sleep(0.005)
            if not link.connected:
                break
        await link.close()


async def test_read_error_closes_reopens_and_commands_work_again():
    fake = FakeSerial(); link, seen = await make_link(fake, reconnect_s=0.05)
    fake.fail_next_reads(1)
    await asyncio.sleep(0.3)
    assert seen["link"] == [True, False, True] and link.connected
    assert await link.command("VER") == ["V plainsight-ptz 0.1.0"]
    await link.close()


async def test_link_down_errors_are_picolinkdown():
    from plainsight_head.pico import PicoLinkDown

    fake = FakeSerial(); link, _ = await make_link(fake, reconnect_s=5.0)
    fake.fail_next_reads(1)
    for _ in range(100):
        await asyncio.sleep(0.01)
        if not link.connected:
            break
    with pytest.raises(PicoLinkDown) as e:
        await link.command("VER")
    assert isinstance(e.value, PicoError) and e.value.reason == "link down"
    await link.close()


async def test_status_round_trip_parses_the_reply():
    fake = FakeSerial(); fake.model["pan"].update(mode="V", vel=2.0)
    link, _ = await make_link(fake)
    st = await link.status()
    assert st.axes["pan"].mode == "V" and st.axes["pan"].vel == 2.0 and fake.sent == ["STATUS"]
    fake.reply_override["STATUS"] = "ok"
    from plainsight_head.protocol import ProtocolError
    with pytest.raises(ProtocolError):
        await link.status()
    await link.close()


async def test_command_waiting_behind_a_held_lock_times_out_unsent():
    fake = FakeSerial(); link, _ = await make_link(fake)
    await link._cmd_lock.acquire()  # a stuck holder (a write that never returns)
    try:
        with pytest.raises(PicoTimeout) as e:
            await asyncio.wait_for(link.command("VER", timeout_s=0.2), 2.0)
        assert "not sent" in e.value.reason
    finally:
        link._cmd_lock.release()
    assert fake.sent == []
    assert await link.command("VER") == ["V plainsight-ptz 0.1.0"]  # the lock was not leaked
    await link.close()


def test_pyserial_is_opened_with_a_write_timeout(monkeypatch):
    import serial

    from plainsight_head import pico

    seen = {}
    monkeypatch.setattr(serial, "Serial", lambda *a, **kw: seen.update(args=a, kw=kw) or "port")
    assert pico._pyserial_factory("/dev/ttyACM0", 115200) == "port"
    assert seen["args"] == ("/dev/ttyACM0", 115200)
    assert seen["kw"]["write_timeout"] == pico.WRITE_TIMEOUT_S == 1.0
    assert issubclass(serial.SerialTimeoutException, OSError)  # so command() maps it to PicoError


def _warnings(caplog, logger):
    return [r for r in caplog.records if r.name == logger and r.levelno >= logging.WARNING]


async def test_absent_pico_for_3s_logs_at_most_two_warnings_and_no_traceback(caplog):
    fake, gone = FakeSerial(), {"until": None}

    def factory(port, baud):
        if time.monotonic() < gone["until"]:  # runs in a worker thread
            raise FileNotFoundError(port)
        fake.is_open = True
        return fake

    gone["until"] = time.monotonic() + 3.0
    caplog.set_level(logging.INFO, logger="plainsight_head.pico")
    link = PicoLink("/dev/fake", 115200, on_status=lambda s: None, on_event=lambda e: None,
                    on_link=lambda up: None, serial_factory=factory, reconnect_s=0.05)
    await link.start()
    await asyncio.sleep(3.2)
    assert link.connected
    fake.emit_status()
    await asyncio.sleep(0.05)
    await link.close()
    warnings = _warnings(caplog, "plainsight_head.pico")
    assert 1 <= len(warnings) <= 2, [r.getMessage() for r in warnings]
    assert not any(r.exc_info for r in warnings)
    assert any("back after" in r.getMessage() for r in caplog.records)


async def test_supervisor_survives_a_failing_teardown_and_reconnects(caplog):
    fake = FakeSerial(); factory = CountingFactory(fake)

    def bad_close():
        fake.is_open = False
        raise RuntimeError("driver bug in close()")

    fake.close = bad_close
    link, seen = await make_link(fake, reconnect_s=0.05)
    link._factory = factory
    fake.fail_next_reads(1)
    for _ in range(100):
        await asyncio.sleep(0.01)
        if seen["link"][-1] is True and factory.calls >= 1:
            break
    assert seen["link"] == [True, False, True] and link.connected
    assert link._supervisor is not None and not link._supervisor.done()
    assert await link.command("VER") == ["V plainsight-ptz 0.1.0"]
    assert any("teardown failed" in r.getMessage() for r in caplog.records)
    await link.close()


async def test_supervisor_survives_an_unexpected_exception_in_a_step(caplog, monkeypatch):
    fake = FakeSerial()
    link, seen = await make_link(fake, reconnect_s=0.05)
    real_open, calls = link._open, []

    async def flaky_open():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("bug")
        return await real_open()

    monkeypatch.setattr(link, "_open", flaky_open)
    fake.fail_next_reads(1)
    for _ in range(100):
        await asyncio.sleep(0.01)
        if link.connected and len(calls) >= 2:
            break
    assert link.connected and len(calls) == 2
    assert any("supervisor step failed" in r.getMessage() and r.exc_info for r in caplog.records)
    await link.close()


async def test_write_failure_is_a_lost_link():
    from plainsight_head.pico import PicoLinkDown

    fake = FakeSerial(); link, _ = await make_link(fake, reconnect_s=5.0)

    def broken_write(data):
        raise OSError("EIO")

    fake.write = broken_write
    with pytest.raises(PicoLinkDown) as e:
        await link.command("VER")
    assert e.value.reason == "write failed: EIO"
    await link.close()



async def test_non_finite_status_lines_are_skipped_and_the_next_good_one_arrives():
    fake = FakeSerial(); link, seen = await make_link(fake)
    good = fake._status_line()
    fake.emit_raw((good.replace("pos=0.000,", "pos=nan,", 1) + "\n").encode())
    fake.emit_raw((good.replace("vel=0.000,", "vel=inf,", 1) + "\n").encode())
    fake.emit_status()
    for _ in range(100):
        if seen["status"]:
            break
        await asyncio.sleep(0.005)
    await asyncio.sleep(0.05)
    assert len(seen["status"]) == 1 and seen["status"][0].axes["pan"].pos == 0.0
    assert link.connected
    await link.close()
