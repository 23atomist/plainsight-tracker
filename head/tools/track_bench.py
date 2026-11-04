"""Bench tool: drive POST /api/track with a known profile and measure following error.

    python tools/track_bench.py --head http://192.168.4.100:8780 --axis pan \
        --rate 2 --seconds 60 [--sine AMPLITUDE PERIOD] [--stop-test]

Exit code 1 if max following error > 0.5 deg or (with --stop-test) stop time > 2 s.
"""
from __future__ import annotations

import argparse
import asyncio
import bisect
import math
import sys
import time

MAX_ERROR_DEG = 0.5
MAX_STOP_S = 2.0
MOVING_VEL = 0.05
STOPPED_VEL = 1e-3
STOP_WAIT_S = 3.0
POST_TIMEOUT_S = 2
SEND_HZ = 10.0
STOP_TEST_SEND_S = 10.0
EMPTY = {"max": 0.0, "rms": 0.0, "p95": 0.0, "n": 0}


def following_error(
    commanded: list[tuple[float, float]], observed: list[tuple[float, float]]
) -> dict:
    """Error of observed (t, pos) against commanded (t, pos), interpolated at observed times.

    Observed points outside the commanded time range are skipped.
    """
    if len(commanded) < 2 or not observed:
        return dict(EMPTY)
    cmd = sorted(commanded)
    times = [t for t, _ in cmd]
    errors: list[float] = []
    for t, pos in observed:
        if t < times[0] or t > times[-1]:
            continue
        i = bisect.bisect_right(times, t)
        if i >= len(cmd):
            expected = cmd[-1][1]
        else:
            (t0, p0), (t1, p1) = cmd[i - 1], cmd[i]
            expected = p0 if t1 == t0 else p0 + (p1 - p0) * (t - t0) / (t1 - t0)
        errors.append(abs(pos - expected))
    if not errors:
        return dict(EMPTY)
    errors.sort()
    p95 = errors[min(len(errors) - 1, math.ceil(0.95 * len(errors)) - 1)]
    rms = math.sqrt(sum(e * e for e in errors) / len(errors))
    return {"max": errors[-1], "rms": rms, "p95": p95, "n": len(errors)}


def make_profile(rate: float, sine: tuple[float, float] | None):
    """Return profile(t) -> (offset_deg, velocity_deg_per_s)."""
    if sine is not None:
        amp, period = sine
        w = 2 * math.pi / period
        return lambda t: (amp * math.sin(w * t), amp * w * math.cos(w * t))
    return lambda t: (rate * t, rate)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--head", required=True, help="head base URL, e.g. http://192.168.4.100:8780")
    p.add_argument("--axis", choices=["pan", "tilt"], default="pan")
    p.add_argument("--rate", type=float, default=2.0, help="constant rate, deg/s")
    p.add_argument("--seconds", type=float, default=60.0)
    p.add_argument("--sine", nargs=2, type=float, metavar=("AMPLITUDE", "PERIOD"),
                   help="sine profile (deg, s); overrides --rate")
    p.add_argument("--stop-test", action="store_true",
                   help=f"stop sending after {STOP_TEST_SEND_S:.0f} s and time until vel == 0 (limit {MAX_STOP_S} s)")
    return p.parse_args(argv)


class HeadRefused(Exception):
    """The head rejected a POST /api/track."""


class Run:
    """Mutable bench state shared by the sender and the reader."""

    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.base = args.head.rstrip("/")
        self.profile = make_profile(args.rate, tuple(args.sine) if args.sine else None)
        self.send_s = min(args.seconds, STOP_TEST_SEND_S) if args.stop_test else args.seconds
        self.commanded: list[tuple[float, float]] = []
        self.observed: list[tuple[float, float]] = []
        self.start_pos = 0.0
        self.t0 = 0.0
        self.last_track: float | None = None
        self.stop_at: float | None = None
        self.moved = False
        self.send_done = False


def _axis_of(tick: dict, axis: str) -> dict | None:
    if tick.get("type") != "tick":
        return None
    return (tick.get("axes") or {}).get(axis)


async def read_start_pos(ws, axis: str) -> float | None:
    import aiohttp

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            msg = await ws.receive(timeout=5)
        except asyncio.TimeoutError:
            return None
        if msg.type != aiohttp.WSMsgType.TEXT:
            if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                return None
            continue
        ax = _axis_of(msg.json(), axis)
        if ax:
            return float(ax["pos"])
    return None


async def sender(run: Run, http) -> None:
    period = 1.0 / SEND_HZ
    n = 0
    while True:
        t = time.monotonic() - run.t0
        if t >= run.send_s:
            break
        off, vel = run.profile(t)
        body = {run.args.axis: {"pos": run.start_pos + off, "vel": vel}}
        async with http.post(f"{run.base}/api/track", json=body) as r:
            if r.status != 200:
                raise HeadRefused(f"POST /api/track -> {r.status}: {await r.text()}")
        run.commanded.append((t, run.start_pos + off))
        run.last_track = time.monotonic()
        n += 1
        await asyncio.sleep(max(0.0, run.t0 + n * period - time.monotonic()))
    run.send_done = True


def _on_tick(run: Run, ax: dict) -> bool:
    """Record one tick of the bench axis; return True once the stop test is satisfied."""
    now = time.monotonic()
    vel = abs(float(ax["vel"]))
    if not run.send_done:
        run.observed.append((now - run.t0, float(ax["pos"])))
        if run.last_track is not None and vel > MOVING_VEL:
            run.moved = True
    elif run.args.stop_test and run.moved and vel < STOPPED_VEL:
        run.stop_at = now
        return True
    return False


async def reader(run: Run, ws, send_task: asyncio.Task) -> None:
    import aiohttp

    end = run.t0 + run.send_s + (STOP_WAIT_S if run.args.stop_test else 0.0)
    while time.monotonic() < end:
        if send_task.done() and send_task.exception() is not None:
            raise send_task.exception()
        try:
            msg = await ws.receive(timeout=0.5)
        except asyncio.TimeoutError:
            continue
        if msg.type != aiohttp.WSMsgType.TEXT:
            if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                break
            continue
        ax = _axis_of(msg.json(), run.args.axis)
        if ax and _on_tick(run, ax):
            break


def report(run: Run) -> bool:
    """Print results; return True if the run failed."""
    result = following_error(run.commanded, run.observed)
    print(f"following error over {result['n']} ticks: max {result['max']:.3f} deg, "
          f"rms {result['rms']:.3f} deg, p95 {result['p95']:.3f} deg")
    failed = result["n"] == 0 or result["max"] > MAX_ERROR_DEG
    expected = run.send_s * SEND_HZ
    if len(run.commanded) < 0.9 * expected:
        print(f"only {len(run.commanded)} of ~{expected:.0f} track updates were sent")
        failed = True
    if run.args.stop_test:
        if not run.moved:
            print("stop test: axis never moved, nothing to stop")
            failed = True
        elif run.stop_at is None or run.last_track is None:
            print("stop test: vel never reached 0")
            failed = True
        else:
            stop_s = run.stop_at - run.last_track
            print(f"stop test: vel == 0 after {stop_s:.3f} s (limit {MAX_STOP_S} s)")
            failed = failed or stop_s > MAX_STOP_S
    print("FAIL" if failed else "PASS")
    return failed


async def run(args: argparse.Namespace) -> int:
    import aiohttp

    r = Run(args)
    ws_url = r.base.replace("http", "ws", 1) + "/ws"
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=POST_TIMEOUT_S)) as http:
        async with http.ws_connect(ws_url) as ws:
            start = await read_start_pos(ws, args.axis)
            if start is None:
                print("no tick with axes within 5 s (Pico link down?)", file=sys.stderr)
                return 2
            r.start_pos = start
            print(f"start {args.axis} = {start:.3f} deg")
            r.t0 = time.monotonic()
            send_task = asyncio.create_task(sender(r, http))
            try:
                await reader(r, ws, send_task)
                await send_task
            finally:
                send_task.cancel()
                await asyncio.gather(send_task, return_exceptions=True)
    return 1 if report(r) else 0


def main(argv: list[str] | None = None) -> int:
    import aiohttp

    try:
        return asyncio.run(run(parse_args(argv)))
    except HeadRefused as e:
        print(e, file=sys.stderr)
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as e:
        print(f"bench aborted: {type(e).__name__}: {e}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
