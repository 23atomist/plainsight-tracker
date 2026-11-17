#!/usr/bin/env python3
"""Move pan/tilt through a few poses and compare commanded angles with the
BNO055 mounted on the head. Pan is compared with heading change (gyro-fused,
fine over short spans even before magnetometer calibration), tilt with pitch
and roll change (gravity, absolute).

    python imu_check.py [--pan 30] [--tilt 70] [--no-home]
"""

import argparse
import math
import time

from imu import BNO055, MODE_IMU, MODE_NDOF
from ptz import PTZ


def wrap(a: float) -> float:
    return (a + 180.0) % 360.0 - 180.0


def rotation_between(q0, q1) -> float:
    """Angle in degrees of the rotation taking orientation q0 to q1,
    independent of how the IMU is mounted."""
    dot = abs(sum(a * b for a, b in zip(q0, q1)))
    dot /= math.sqrt(sum(a * a for a in q0) * sum(b * b for b in q1))
    return math.degrees(2 * math.acos(min(1.0, dot)))


def settle_quat(imu: BNO055, n: int = 10):
    qs = [imu.quaternion() for _ in range(n) if not time.sleep(0.03)]
    return tuple(sum(q[i] for q in qs) / n for i in range(4))


def settle_read(imu: BNO055, secs: float = 1.5, n: int = 10):
    time.sleep(secs)
    hs, rs, ps = [], [], []
    for _ in range(n):
        h, r, p = imu.euler()
        hs.append(h), rs.append(r), ps.append(p)
        time.sleep(0.05)
    h0 = hs[0]  # average heading around the first sample so 359/1 don't cancel
    h = (h0 + sum(wrap(x - h0) for x in hs) / n) % 360.0
    return h, sum(rs) / n, sum(ps) / n


def preflight(ptz: PTZ, imu: BNO055, step: float = 5.0) -> None:
    """Nudge each axis and check with the IMU that the right one moved, by
    about the right amount (and pan the right way) before any big move.
    Catches swapped motor plugs, a wrong invert or gear, or a stalled motor."""
    for axis in ("pan", "tilt"):  # tilt nudges up: away from its endstop
        h0, _, _ = settle_read(imu, 0.5)
        q0 = settle_quat(imu)
        ptz.move_by(**{axis: step})
        ptz.wait_idle()
        h1, _, _ = settle_read(imu, 0.8)
        rot = rotation_between(q0, settle_quat(imu))
        d_head = wrap(h1 - h0)
        ptz.move_by(**{axis: -step})
        ptz.wait_idle()
        problem = None
        if not 0.5 * step <= rot <= 2.0 * step:
            problem = f"rotated {rot:.1f} deg for a {step:g} deg command (stalled, or wrong gear)"
        elif axis == "pan" and abs(d_head) < 0.7 * rot:
            problem = "pan did not turn the heading: is the tilt motor on the pan socket?"
        elif axis == "pan" and d_head < 0:
            problem = "pan +ve turned counter-clockwise: check pan invert"
        elif axis == "tilt" and abs(d_head) > 0.5 * rot:
            problem = "tilt turned the heading: is the pan motor on the tilt socket?"
        print(f"preflight {axis:4}: rotated {rot:5.2f} (heading {d_head:+5.2f})"
              f"  {'FAIL: ' + problem if problem else 'ok'}", flush=True)
        if problem:
            ptz.stop()
            raise SystemExit(f"aborted: {problem}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pan", type=float, default=30)
    ap.add_argument("--tilt", type=float, default=70)
    ap.add_argument("--no-home", action="store_true")
    ap.add_argument("--compass", action="store_true", help="NDOF fusion (with magnetometer) instead of gyro+accel only")
    a = ap.parse_args()

    with PTZ() as ptz, BNO055(mode=MODE_NDOF if a.compass else MODE_IMU) as imu:
        preflight(ptz, imu)
        if not a.no_home:
            print("homing tilt...", flush=True)
            ptz.home("tilt")
            ptz.wait_idle(timeout=120)
        ptz.move(pan=0, tilt=0)
        ptz.wait_idle()
        h0, r0, p0 = settle_read(imu)
        q0 = settle_quat(imu)
        print(f"{'pose':>16} | {'heading':>8} {'roll':>7} {'pitch':>7} | "
              f"{'d_head':>7} {'d_roll':>7} {'d_pitch':>7} | {'rotated':>7} {'ratio':>6} | cal",
              flush=True)
        poses = [(a.pan, 0), (-a.pan, 0), (0, 0), (0, a.tilt / 2), (0, a.tilt), (0, 0)]
        for pan, tilt in [(0, 0)] + poses:
            ptz.move(pan=pan, tilt=tilt)
            ptz.wait_idle()
            h, r, p = settle_read(imu)
            rot = rotation_between(q0, settle_quat(imu))
            cmd = math.hypot(pan, tilt)  # poses move one axis at a time
            ratio = f"{rot / cmd:6.3f}" if cmd else "     -"
            cal = "".join(map(str, imu.calibration()))
            print(f"pan {pan:+5.0f} tilt {tilt:3.0f} | {h:8.2f} {r:7.2f} {p:7.2f} | "
                  f"{wrap(h - h0):+7.2f} {r - r0:+7.2f} {p - p0:+7.2f} | {rot:7.2f} {ratio} | {cal}",
                  flush=True)


if __name__ == "__main__":
    main()
