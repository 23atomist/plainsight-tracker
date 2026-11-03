import asyncio
import logging
import struct
import time

from plainsight_head.imu import BNO055, ImuReader
from tests.fakes import FakeBNO055, FakeClock


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
    clk = FakeClock()
    got = []
    r = ImuReader(lambda: fake, rate_hz=200, on_fully_calibrated=got.append, time_fn=clk.now)
    await r.start()
    await asyncio.sleep(0.05)
    assert got == []  # first attempt failed; the retry waits 5 s
    clk.advance(5.0)
    await asyncio.sleep(0.05)
    await r.close()
    assert got == [fake.offsets]
    assert fake.mode == 0x0C


async def test_offsets_retry_backs_off_5_10_20_40_then_caps_at_60():
    fake = FakeBNO055(cal=(3, 3, 3, 3))
    fake.fail_offsets(100)
    clk = FakeClock()
    got = []
    r = ImuReader(lambda: fake, rate_hz=200, on_fully_calibrated=got.append, time_fn=clk.now)
    await r.start()

    async def attempts_after(advance: float) -> int:
        clk.advance(advance)
        await asyncio.sleep(0.03)  # several 200 Hz samples: at most one attempt is due
        return fake.offsets_reads

    assert await attempts_after(0) == 1
    expected = 1
    for gap in (5, 10, 20, 40, 60, 60):
        assert await attempts_after(gap - 0.5) == expected, gap  # not yet
        expected += 1
        assert await attempts_after(0.5) == expected, gap
    fake.fail_offsets(0)
    await attempts_after(60)
    assert got == [fake.offsets] and fake.offsets_reads == expected + 1
    assert r._cal_retry_s == 5.0  # reset on success
    await r.close()


async def until_open(r: ImuReader) -> None:
    for _ in range(200):
        if r.ok:
            return
        await asyncio.sleep(0.005)
    raise AssertionError("IMU never opened")


async def test_a_slow_i2c_read_does_not_block_the_event_loop():
    fake = FakeBNO055()
    real = fake.read_sample

    def slow_read(now):
        time.sleep(0.3)  # a held bus / kernel adapter timeout
        return real(now)

    fake.read_sample = slow_read
    r = ImuReader(lambda: fake, rate_hz=200)
    await r.start()
    await until_open(r)
    burst = asyncio.create_task(r.burst(2))
    worst = 0.0
    for _ in range(40):  # ~0.4 s of 10 ms sleeps while reads block their worker thread
        t0 = time.monotonic()
        await asyncio.sleep(0.01)
        worst = max(worst, time.monotonic() - t0 - 0.01)
    assert worst < 0.05, worst
    assert len(await burst) == 2
    await r.close()


async def test_sensor_calls_never_overlap():
    fake = FakeBNO055()
    real, active, overlaps = fake.read_sample, [0], []

    def tracked(now):
        active[0] += 1
        overlaps.append(active[0])
        time.sleep(0.002)
        active[0] -= 1
        return real(now)

    fake.read_sample = tracked
    r = ImuReader(lambda: fake, rate_hz=200)
    await r.start()
    await until_open(r)
    await asyncio.gather(r.burst(20), r.burst(20))
    await r.close()
    assert max(overlaps) == 1


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
        await r.load_offsets(bytes(22))
    assert any(rec.levelno == logging.WARNING for rec in caplog.records)


async def test_load_offsets_writes_through_set_offsets():
    fake = FakeBNO055()
    r = ImuReader(lambda: fake, rate_hz=200)
    await r.start()
    await asyncio.sleep(0.02)
    await r.load_offsets(bytes([7] * 22))
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


def _imu_warnings(caplog):
    return [r for r in caplog.records if r.name == "plainsight_head.imu" and r.levelno >= logging.WARNING]


async def test_absent_imu_for_3s_logs_at_most_two_warnings(caplog):
    fake, t_end = FakeBNO055(), time.monotonic() + 3.0

    def open_fn():
        if time.monotonic() < t_end:
            raise FileNotFoundError("/dev/i2c-3")
        return fake

    r = ImuReader(open_fn, rate_hz=200, reopen_s=0.02)
    await r.start()
    await asyncio.sleep(3.2)
    assert r.ok
    await r.close()
    warnings = _imu_warnings(caplog)
    assert 1 <= len(warnings) <= 2 and not any(w.exc_info for w in warnings), warnings


async def test_imu_failing_reads_for_3s_log_at_most_two_warnings(caplog):
    caplog.set_level(logging.INFO, logger="plainsight_head.imu")
    fake = FakeBNO055()
    r = ImuReader(lambda: fake, rate_hz=200, reopen_s=0.02)
    await r.start()
    await until_open(r)
    fake.fail_next(10**9)
    await asyncio.sleep(3.0)
    fake.fail_next(0)
    await asyncio.sleep(0.2)
    assert r.ok
    await r.close()
    warnings = _imu_warnings(caplog)
    assert 1 <= len(warnings) <= 2, [w.getMessage() for w in warnings]
    assert any("IMU back after" in rec.getMessage() for rec in caplog.records)


async def test_sample_time_is_taken_when_the_read_runs_not_when_it_queued():
    clk = FakeClock(100.0)
    r = ImuReader(lambda: FakeBNO055(), rate_hz=200, time_fn=clk.now)
    await r.start()
    await until_open(r)
    await r._bus.acquire()  # another sensor call holds the bus
    burst = asyncio.create_task(r.burst(1))
    await asyncio.sleep(0.02)
    clk.advance(5.0)
    r._bus.release()
    (sample,) = await burst
    assert sample.t == 105.0
    await r.close()
