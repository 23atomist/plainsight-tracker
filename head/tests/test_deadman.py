import asyncio

import pytest

from plainsight_head.deadman import JogDeadman
from tests.fakes import FakeClock


async def test_expired_axes_are_stopped_once():
    clk = FakeClock()
    stopped = []

    async def stop(axes):
        stopped.append(sorted(axes))

    d = JogDeadman(500, stop, time_fn=clk.now, poll_s=0.01)
    await d.start()
    d.touch("pan")
    d.touch("tilt")
    clk.advance(0.3)
    d.touch("pan")
    clk.advance(0.3)
    await asyncio.sleep(0.05)
    assert stopped == [["tilt"]] and d.armed == {"pan"}
    clk.advance(0.3)
    await asyncio.sleep(0.05)
    assert stopped == [["tilt"], ["pan"]] and d.armed == set()
    await d.close()


async def test_clear_disarms_without_stopping():
    stopped = []

    async def stop(axes):
        stopped.append(axes)

    d = JogDeadman(100, stop, poll_s=0.01)
    await d.start()
    d.touch("pan")
    d.clear()
    await asyncio.sleep(0.2)
    assert stopped == [] and d.armed == set()
    await d.close()


async def test_clear_single_axis_leaves_others_armed():
    async def stop(axes):
        pass

    d = JogDeadman(100, stop, poll_s=0.01)
    d.touch("pan")
    d.touch("tilt")
    d.clear("pan")
    assert d.armed == {"tilt"}


async def test_failing_stop_is_retried_and_axes_stay_armed(caplog):
    clk = FakeClock()
    calls = []

    async def stop(axes):
        calls.append(list(axes))
        if len(calls) == 1:
            raise RuntimeError("link down")

    d = JogDeadman(100, stop, time_fn=clk.now, poll_s=0.01)
    await d.start()
    d.touch("pan")
    clk.advance(1.0)
    await asyncio.sleep(0.1)
    assert calls == [["pan"], ["pan"]] and d.armed == set()
    assert "link down" in caplog.text
    await d.close()


async def test_touch_unknown_axis_raises():
    async def stop(axes):
        pass

    d = JogDeadman(100, stop)
    with pytest.raises(ValueError):
        d.touch("roll")


async def test_start_twice_and_close_before_start_are_noops():
    async def stop(axes):
        pass

    d = JogDeadman(100, stop, poll_s=0.01)
    await d.close()
    await d.start()
    await d.start()
    await d.close()
    await d.close()
