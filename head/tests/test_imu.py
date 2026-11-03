import asyncio
import logging
import struct

from plainsight_head.imu import BNO055, ImuReader
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


async def test_burst_is_capped_at_1000():
    r = ImuReader(lambda: FakeBNO055(), rate_hz=200)
    await r.start()
    await asyncio.sleep(0.02)
    assert len(await r.burst(5000)) == 1000
    await r.close()


async def test_burst_when_not_open_returns_empty():
    r = ImuReader(lambda: FakeBNO055())
    assert await r.burst(5) == []


async def test_fully_calibrated_callback_fires_once():
    fake = FakeBNO055(cal=(3, 3, 3, 3))
    got = []
    r = ImuReader(lambda: fake, rate_hz=200, on_fully_calibrated=got.append)
    await r.start()
    await asyncio.sleep(0.05)
    await r.close()
    assert got == [fake.get_offsets()]


async def test_failed_offsets_read_is_retried_and_sensor_stays_in_fusion_mode():
    fake = FakeBNO055(cal=(3, 3, 3, 3))
    fake.fail_offsets(1)
    got = []
    r = ImuReader(lambda: fake, rate_hz=200, on_fully_calibrated=got.append)
    await r.start()
    await asyncio.sleep(0.05)
    await r.close()
    assert got == [fake.offsets]  # first attempt failed, a later sample retried
    assert fake.mode == 0x0C


def test_get_offsets_failure_leaves_fusion_mode():
    fake = FakeBNO055()
    fake.fail_offsets(1)
    try:
        fake.get_offsets()
    except OSError:
        pass
    assert fake.mode == 0x0C


async def test_link_loss_and_recovery():
    fake = FakeBNO055()
    links = []
    r = ImuReader(lambda: fake, rate_hz=200, on_link=links.append, reopen_s=0.1)
    await r.start()
    await asyncio.sleep(0.02)
    fake.fail_next(3)
    await asyncio.sleep(0.05)
    assert links[-1] is False and links.count(False) == 1
    await asyncio.sleep(0.2)
    assert r.ok is True and links[-1] is True
    await r.close()


async def test_two_failures_then_success_keep_link_up():
    fake = FakeBNO055()
    links = []
    r = ImuReader(lambda: fake, rate_hz=200, on_link=links.append, reopen_s=0.1)
    await r.start()
    await asyncio.sleep(0.02)
    fake.fail_next(2)
    await asyncio.sleep(0.1)
    assert r.ok is True and False not in links
    fake.fail_next(2)  # count was reset by the success
    await asyncio.sleep(0.1)
    assert r.ok is True and False not in links
    await r.close()


async def test_open_failures_then_recovery():
    fake = FakeBNO055()
    attempts = []

    def open_fn():
        attempts.append(1)
        if len(attempts) <= 2:
            raise OSError("no bus")
        return fake

    links = []
    r = ImuReader(open_fn, rate_hz=200, on_link=links.append, reopen_s=0.02)
    await r.start()
    await asyncio.sleep(0.2)
    assert len(attempts) == 3 and r.ok is True and links[-1] is True
    await r.close()


async def test_non_oserror_is_logged_and_counts_as_failure(caplog):
    fake = FakeBNO055()
    calls = {"n": 0}
    orig = fake.read_sample

    def boom(now):
        calls["n"] += 1
        if calls["n"] <= 3:
            raise ValueError("bad frame")
        return orig(now)

    fake.read_sample = boom
    links = []
    r = ImuReader(lambda: fake, rate_hz=200, on_link=links.append, reopen_s=0.05)
    with caplog.at_level(logging.ERROR, logger="plainsight_head.imu"):
        await r.start()
        await asyncio.sleep(0.02)
        assert r.ok is False and links[-1] is False
        await asyncio.sleep(0.15)
    assert r.ok is True and r._task is not None and not r._task.done()
    assert any("ValueError" in (rec.exc_text or "") for rec in caplog.records)
    await r.close()


async def test_load_offsets_noop_with_warning_when_closed(caplog):
    r = ImuReader(lambda: FakeBNO055())
    with caplog.at_level(logging.WARNING, logger="plainsight_head.imu"):
        r.load_offsets(bytes(22))
    assert any(rec.levelno == logging.WARNING for rec in caplog.records)


async def test_load_offsets_writes_through_set_offsets():
    fake = FakeBNO055()
    r = ImuReader(lambda: fake, rate_hz=200)
    await r.start()
    await asyncio.sleep(0.02)
    r.load_offsets(bytes([7] * 22))
    assert fake.offsets_writes == [bytes([7] * 22)]
    await r.close()


def test_real_driver_restores_fusion_mode_when_offsets_access_fails(monkeypatch):
    writes = []
    dev = BNO055.__new__(BNO055)
    dev.fusion_mode = 0x0C
    monkeypatch.setattr("plainsight_head.imu.time.sleep", lambda s: None)
    monkeypatch.setattr(dev, "write", lambda reg, *d: writes.append((reg, d)))

    def bad_read(reg, n=1):
        raise OSError("i2c")

    monkeypatch.setattr(dev, "read", bad_read)
    try:
        dev.get_offsets()
    except OSError:
        pass
    assert writes == [(0x3D, (0x00,)), (0x3D, (0x0C,))]
