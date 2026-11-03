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


async def _expire_into_blocked_stop(clk, gate, calls, entered):
    async def stop(axes):
        calls.append(list(axes))
        entered.set()
        await gate.wait()

    d = JogDeadman(100, stop, time_fn=clk.now, poll_s=0.01)
    await d.start()
    return d


async def test_retouch_during_awaited_stop_keeps_axis_armed():
    clk, gate, entered, calls = FakeClock(), asyncio.Event(), asyncio.Event(), []
    d = await _expire_into_blocked_stop(clk, gate, calls, entered)
    d.touch("pan")
    clk.advance(1.0)
    await asyncio.wait_for(entered.wait(), 1)
    clk.advance(0.001)
    d.touch("pan")
    gate.set()
    await asyncio.sleep(0.05)
    assert "pan" in d.armed and calls == [["pan"]]
    await d.close()


async def test_clear_during_awaited_stop_leaves_nothing_armed():
    clk, gate, entered, calls = FakeClock(), asyncio.Event(), asyncio.Event(), []
    d = await _expire_into_blocked_stop(clk, gate, calls, entered)
    d.touch("pan")
    clk.advance(1.0)
    await asyncio.wait_for(entered.wait(), 1)
    d.clear()
    gate.set()
    await asyncio.sleep(0.05)
    assert d.armed == set() and calls == [["pan"]]
    await d.close()


async def test_close_during_in_flight_stop_is_clean_and_axis_stays_armed():
    clk, gate, entered, calls = FakeClock(), asyncio.Event(), asyncio.Event(), []
    d = await _expire_into_blocked_stop(clk, gate, calls, entered)
    d.touch("pan")
    clk.advance(1.0)
    await asyncio.wait_for(entered.wait(), 1)
    await d.close()
    assert d.armed == {"pan"}
    assert d._task is None


async def test_two_axes_expiring_together_make_one_call():
    clk, calls = FakeClock(), []

    async def stop(axes):
        calls.append(sorted(axes))

    d = JogDeadman(100, stop, time_fn=clk.now, poll_s=0.01)
    await d.start()
    d.touch("pan")
    d.touch("tilt")
    clk.advance(1.0)
    await asyncio.sleep(0.05)
    assert calls == [["pan", "tilt"]] and d.armed == set()
    await d.close()


async def test_failure_is_logged_once_per_change_and_recovery_once(caplog):
    from plainsight_head.pico import PicoLinkDown, PicoTimeout

    clk, calls = FakeClock(), []
    errors = [PicoLinkDown()] * 5 + [PicoTimeout("no reply")] * 3

    async def stop(axes):
        calls.append(list(axes))
        if errors:
            raise errors.pop(0)

    d = JogDeadman(100, stop, time_fn=clk.now, poll_s=0.005)
    await d.start()
    d.touch("pan")
    clk.advance(1.0)
    for _ in range(200):
        await asyncio.sleep(0.005)
        if not d.armed:
            break
    await d.close()
    assert len(calls) == 9 and d.armed == set()
    lines = [r.getMessage() for r in caplog.records if r.name == "plainsight_head.deadman"]
    assert len(lines) == 3, lines  # link down, then timeout, then "went through"
    assert "link down" in lines[0] and "no reply" in lines[1] and "went through" in lines[2]
    assert not any(r.exc_info for r in caplog.records)  # Pico errors carry no traceback


async def test_unexpected_stop_error_is_logged_with_traceback(caplog):
    clk, calls = FakeClock(), []

    async def stop(axes):
        calls.append(axes)
        if len(calls) < 3:
            raise RuntimeError("bug")

    d = JogDeadman(100, stop, time_fn=clk.now, poll_s=0.005)
    await d.start()
    d.touch("tilt")
    clk.advance(1.0)
    await asyncio.sleep(0.1)
    await d.close()
    tracebacks = [r for r in caplog.records if r.exc_info]
    assert len(tracebacks) == 1 and "RuntimeError: bug" in tracebacks[0].getMessage()


async def test_clear_unchanged_keeps_axes_rearmed_after_the_snapshot():
    clk = FakeClock()

    async def stop(axes):
        pass

    d = JogDeadman(100, stop, time_fn=clk.now)
    d.touch("pan")
    d.touch("tilt")
    snap = d.snapshot()
    clk.advance(0.01)
    d.touch("tilt")  # a newer jog queued behind the superseding command
    d.clear_unchanged(snap, ["pan", "tilt", "zoom"])
    assert d.armed == {"tilt"}
