import asyncio
import struct

from plainsight_head.imu import BNO055, ImuReader, ImuSample  # noqa: F401
from tests.fakes import FakeBNO055


def test_read_sample_decodes_register_block(monkeypatch):
    raw = struct.pack("<hhh", 360 * 16, 1 * 16, -2 * 16) + struct.pack("<hhhh", 16384, 0, 0, 0) \
        + struct.pack("<hhh", 0, 0, 100) + struct.pack("<hhh", 0, 0, 981) + bytes([28, 0b11_10_01_00])
    dev = BNO055.__new__(BNO055)
    monkeypatch.setattr(dev, "read", lambda reg, n=1: raw)
    s = dev.read_sample(now=5.0)
    assert (s.heading, s.roll, s.pitch) == (0.0, 1.0, -2.0)  # 360 -> 0
    assert s.quat == (1.0, 0.0, 0.0, 0.0) and s.gravity == (0.0, 0.0, 9.81) and s.linacc == (0.0, 0.0, 1.0)
    assert s.cal == (3, 2, 1, 0) and s.temp_c == 28


async def test_reader_publishes_latest_and_burst():
    fake = FakeBNO055(heading=90.0)
    r = ImuReader(lambda: fake, rate_hz=200)
    await r.start()
    await asyncio.sleep(0.05)
    assert r.ok and r.latest.heading == 90.0
    assert len(await r.burst(50)) == 50
    await r.close()


async def test_fully_calibrated_callback_fires_once():
    fake = FakeBNO055(cal=(3, 3, 3, 3))
    got = []
    r = ImuReader(lambda: fake, rate_hz=200, on_fully_calibrated=got.append)
    await r.start()
    await asyncio.sleep(0.05)
    await r.close()
    assert got == [fake.get_offsets()]


async def test_link_loss_and_recovery():
    fake = FakeBNO055()
    links = []
    r = ImuReader(lambda: fake, rate_hz=200, on_link=links.append)
    await r.start()
    fake.fail_next(3)
    await asyncio.sleep(0.05)
    assert r.ok is False and links[-1] is False
    await asyncio.sleep(1.2)
    assert r.ok is True and links[-1] is True
    await r.close()
