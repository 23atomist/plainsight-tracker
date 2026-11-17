#!/usr/bin/env python3
"""Measure pan backlash (hysteresis) with the head-mounted BNO055.

Approaches the same pan angle alternately from the + and - side with short
moves (so gyro drift stays small) and compares where the head really ends up.
The mean difference between the two approach directions is the backlash; with
compensation set right it should come out near zero.

    python backlash_test.py [--amp 10] [--reps 4]
"""

import argparse
import statistics
import time

from imu import BNO055, MODE_IMU
from imu_check import settle_read, wrap
from ptz import PTZ


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--amp", type=float, default=10, help="overshoot each side, degrees")
    ap.add_argument("--reps", type=int, default=4)
    a = ap.parse_args()

    with PTZ() as ptz, BNO055(mode=MODE_IMU) as imu:
        bl = ptz.config("pan")["pan"]["backlash"]
        print(f"pan backlash setting: {bl}", flush=True)
        from_plus, from_minus = [], []
        ptz.move(pan=a.amp)
        ptz.wait_idle()
        for _ in range(a.reps):
            for side, store in ((a.amp, from_plus), (-a.amp, from_minus)):
                ptz.move(pan=side)
                ptz.wait_idle()
                ptz.move(pan=0)
                ptz.wait_idle()
                h, _, _ = settle_read(imu, 0.8)
                store.append(h)
        ref = from_plus[0]
        plus = [wrap(h - ref) for h in from_plus]
        minus = [wrap(h - ref) for h in from_minus]
        # Pair each "from -" reading with the "from +" readings either side of
        # it in time, so slow gyro drift cancels.
        diffs = [p - m for p, m in zip(plus, minus)] + [p - m for p, m in zip(plus[1:], minus)]
        print("arrive from +: " + " ".join(f"{x:+.2f}" for x in plus))
        print("arrive from -: " + " ".join(f"{x:+.2f}" for x in minus))
        print(f"hysteresis (from+ minus from-): {statistics.mean(diffs):+.2f} deg "
              f"(spread {statistics.pstdev(diffs):.2f})")
        print("positive = head stops short of target on each reversal -> raise backlash")


if __name__ == "__main__":
    main()
