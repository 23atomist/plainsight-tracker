import asyncio

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


async def test_link_loss_and_reconnect():
    fake = FakeSerial(); reconnected = []
    async def on_reconnect(): reconnected.append(1)
    link, seen = await make_link(fake, stale_s=0.1, reconnect_s=0.05, on_reconnect=on_reconnect)
    link.expect_stream = True
    await asyncio.sleep(0.3)                      # no status lines -> stale
    assert seen["link"][-1] is False and link.connected is False
    with pytest.raises(PicoError): await link.command("VER")
    fake.emit_status(); await asyncio.sleep(0.2)  # factory returns the same fake; it reconnects
    assert seen["link"][-1] is True and reconnected == [1]
    await link.close()
