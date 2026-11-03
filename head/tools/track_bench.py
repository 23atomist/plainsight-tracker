"""Bench tool: drive POST /api/track with a known profile and measure following error.

    python tools/track_bench.py --head http://192.168.4.96:8780 --axis pan \
        --rate 2 --seconds 60 [--sine AMPLITUDE PERIOD] [--stop-test]

Exit code 1 if max following error > 0.5 deg or (with --stop-test) stop time > 1 s.
"""
from __future__ import annotations

import argparse
import asyncio
import bisect
import math
import sys
import time

MAX_ERROR_DEG = 0.5
MAX_STOP_S = 1.0
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
    p.add_argument("--head", required=True, help="head base URL, e.g. http://192.168.4.96:8780")
    p.add_argument("--axis", choices=["pan", "tilt"], default="pan")
    p.add_argument("--rate", type=float, default=2.0, help="constant rate, deg/s")
    p.add_argument("--seconds", type=float, default=60.0)
    p.add_argument("--sine", nargs=2, type=float, metavar=("AMPLITUDE", "PERIOD"),
                   help="sine profile (deg, s); overrides --rate")
    p.add_argument("--stop-test", action="store_true",
                   help=f"stop sending after {STOP_TEST_SEND_S:.0f} s and time until vel == 0")
    return p.parse_args(argv)


async def run(args: argparse.Namespace) -> int:
    import aiohttp

    base = args.head.rstrip("/")
    ws_url = base.replace("http", "ws", 1) + "/ws"
    profile = make_profile(args.rate, tuple(args.sine) if args.sine else None)
    send_s = min(args.seconds, STOP_TEST_SEND_S) if args.stop_test else args.seconds
    commanded: list[tuple[float, float]] = []
    observed: list[tuple[float, float]] = []
    state = {"start": None, "last_track": None, "stop_at": None, "send_done": False}

    async with aiohttp.ClientSession() as http:
        async with http.ws_connect(ws_url) as ws:
            # first tick with axes gives the start position
            start_pos = None
            deadline = time.monotonic() + 5
            while start_pos is None and time.monotonic() < deadline:
                msg = await ws.receive(timeout=5)
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                tick = msg.json()
                axis = (tick.get("axes") or {}).get(args.axis)
                if tick.get("type") == "tick" and axis:
                    start_pos = float(axis["pos"])
            if start_pos is None:
                print("no tick with axes within 5 s (Pico link down?)", file=sys.stderr)
                return 2
            print(f"start {args.axis} = {start_pos:.3f} deg")

            t0 = time.monotonic()

            async def sender() -> None:
                period = 1.0 / SEND_HZ
                n = 0
                while True:
                    t = time.monotonic() - t0
                    if t >= send_s:
                        break
                    off, vel = profile(t)
                    body = {args.axis: {"pos": start_pos + off, "vel": vel}}
                    async with http.post(f"{base}/api/track", json=body) as r:
                        if r.status != 200:
                            print(f"POST /api/track -> {r.status}: {await r.text()}",
                                  file=sys.stderr)
                            raise SystemExit(2)
                    commanded.append((t, start_pos + off))
                    state["last_track"] = time.monotonic()
                    n += 1
                    await asyncio.sleep(max(0.0, t0 + n * period - time.monotonic()))
                state["send_done"] = True

            send_task = asyncio.create_task(sender())
            end = t0 + send_s + (3.0 if args.stop_test else 0.0)
            try:
                while time.monotonic() < end:
                    try:
                        msg = await ws.receive(timeout=0.5)
                    except asyncio.TimeoutError:
                        continue
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
                        continue
                    tick = msg.json()
                    axis = (tick.get("axes") or {}).get(args.axis)
                    if tick.get("type") != "tick" or not axis:
                        continue
                    now = time.monotonic()
                    if not state["send_done"]:
                        observed.append((now - t0, float(axis["pos"])))
                    elif (args.stop_test and state["stop_at"] is None
                          and float(axis["vel"]) == 0.0):
                        state["stop_at"] = now
                        break
            finally:
                await asyncio.gather(send_task, return_exceptions=True)

    result = following_error(commanded, observed)
    print(f"following error over {result['n']} ticks: max {result['max']:.3f} deg, "
          f"rms {result['rms']:.3f} deg, p95 {result['p95']:.3f} deg")
    failed = result["n"] == 0 or result["max"] > MAX_ERROR_DEG
    if args.stop_test:
        if state["stop_at"] is None or state["last_track"] is None:
            print("stop test: vel never reached 0")
            failed = True
        else:
            stop_s = state["stop_at"] - state["last_track"]
            print(f"stop test: vel == 0 after {stop_s:.3f} s (limit {MAX_STOP_S} s)")
            failed = failed or stop_s > MAX_STOP_S
    print("FAIL" if failed else "PASS")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(run(parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())
