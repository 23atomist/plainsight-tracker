#!/usr/bin/env python3
"""BNO055 9-DOF IMU on the Pi's I2C header (pins 3/5), no extra packages.

The BNO055 fuses accelerometer, gyro and magnetometer on-chip (NDOF mode) and
reports absolute heading / roll / pitch in degrees.

    python imu.py                  # live heading/roll/pitch + calibration status
    python imu.py --save-cal       # ... and store offsets once fully calibrated
    python imu.py --once           # one reading, for scripts

From code:

    from imu import BNO055
    with BNO055() as imu:
        h, r, p = imu.euler()
        sys_, gyr, acc, mag = imu.calibration()

Calibration (status 0..3 per sensor): keep it still a few seconds (gyro),
set it in ~6 different orientations (accel), and move it in a slow figure-8
(mag). Offsets saved with --save-cal are loaded automatically at start.
"""

from __future__ import annotations

import argparse
import fcntl
import glob
import json
import os
import struct
import sys
import time

I2C_SLAVE = 0x0703
HEADER_I2C = "5002400.i2c"  # TWI1 on PI7/PI8 = header pins 5/3 (overlay i2c1-pi)
CAL_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "imu_cal.json")

CHIP_ID, PAGE_ID = 0x00, 0x07
EUL_DATA, QUA_DATA, TEMP = 0x1A, 0x20, 0x34
CALIB_STAT, ST_RESULT, SYS_STATUS, SYS_ERR = 0x35, 0x36, 0x39, 0x3A
UNIT_SEL, OPR_MODE, PWR_MODE, SYS_TRIGGER = 0x3B, 0x3D, 0x3E, 0x3F
AXIS_MAP_CONFIG, AXIS_MAP_SIGN = 0x41, 0x42
OFFSETS, OFFSETS_LEN = 0x55, 22
MODE_CONFIG, MODE_IMU, MODE_NDOF = 0x00, 0x08, 0x0C  # IMU = gyro+accel only, no compass


class IMUError(Exception):
    pass


def find_bus() -> int:
    for dev in sorted(glob.glob("/sys/bus/i2c/devices/i2c-*")):
        if os.path.realpath(os.path.join(dev, "..")).endswith(HEADER_I2C):
            return int(dev.rsplit("-", 1)[1])
    raise IMUError("header I2C bus not found; enable overlay i2c1-pi in /boot/armbianEnv.txt")


class BNO055:
    def __init__(self, bus: int | None = None, address: int | None = None,
                 cal_file: str | None = CAL_FILE, external_crystal: bool = False,
                 mode: int = MODE_NDOF):
        self.fusion_mode = mode
        self.bus = find_bus() if bus is None else bus
        self.fd = os.open(f"/dev/i2c-{self.bus}", os.O_RDWR)
        try:
            self.address = address if address is not None else self._probe()
            self._begin(external_crystal)
            if cal_file and os.path.exists(cal_file):
                with open(cal_file) as f:
                    self.set_offsets(bytes(json.load(f)["offsets"]))
        except Exception:
            os.close(self.fd)
            raise

    # -- low level ---------------------------------------------------------
    def _select(self, address: int) -> None:
        fcntl.ioctl(self.fd, I2C_SLAVE, address)

    def read(self, reg: int, n: int = 1) -> bytes:
        os.write(self.fd, bytes([reg]))
        return os.read(self.fd, n)

    def write(self, reg: int, *data: int) -> None:
        os.write(self.fd, bytes([reg, *data]))

    def _probe(self) -> int:
        for addr in (0x28, 0x29):
            try:
                self._select(addr)
                if self.read(CHIP_ID)[0] == 0xA0:
                    return addr
            except OSError:
                pass
        raise IMUError(f"no BNO055 on i2c-{self.bus} at 0x28/0x29")

    def _mode(self, mode: int) -> None:
        self.write(OPR_MODE, mode)
        time.sleep(0.03)  # datasheet: 7 ms from CONFIG, 19 ms to CONFIG

    def _begin(self, external_crystal: bool) -> None:
        self._select(self.address)
        self._mode(MODE_CONFIG)
        self.write(PAGE_ID, 0)
        self.write(PWR_MODE, 0x00)  # normal
        self.write(UNIT_SEL, 0x00)  # degrees, m/s^2, Celsius, Windows orientation
        self.write(SYS_TRIGGER, 0x80 if external_crystal else 0x00)
        time.sleep(0.01)
        self._mode(self.fusion_mode)

    def close(self) -> None:
        os.close(self.fd)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -- data --------------------------------------------------------------
    def euler(self) -> tuple[float, float, float]:
        """(heading, roll, pitch) in degrees."""
        h, r, p = struct.unpack("<hhh", self.read(EUL_DATA, 6))
        return h / 16.0, r / 16.0, p / 16.0

    def quaternion(self) -> tuple[float, float, float, float]:
        """(w, x, y, z)."""
        return tuple(v / 16384.0 for v in struct.unpack("<hhhh", self.read(QUA_DATA, 8)))

    def calibration(self) -> tuple[int, int, int, int]:
        """(system, gyro, accel, mag), each 0 (uncalibrated) .. 3 (fully)."""
        c = self.read(CALIB_STAT)[0]
        return c >> 6 & 3, c >> 4 & 3, c >> 2 & 3, c & 3

    def temperature(self) -> int:
        return struct.unpack("b", self.read(TEMP))[0]

    def status(self) -> dict:
        st, sys_status, err = self.read(ST_RESULT)[0], self.read(SYS_STATUS)[0], self.read(SYS_ERR)[0]
        return {"self_test": f"{st & 0xF:04b}", "sys_status": sys_status, "sys_err": err}

    # -- calibration offsets (only writable in CONFIG mode) -----------------
    def get_offsets(self) -> bytes:
        self._mode(MODE_CONFIG)
        data = self.read(OFFSETS, OFFSETS_LEN)
        self._mode(self.fusion_mode)
        return data

    def set_offsets(self, data: bytes) -> None:
        if len(data) != OFFSETS_LEN:
            raise IMUError("bad calibration data")
        self._mode(MODE_CONFIG)
        self.write(OFFSETS, *data)
        self._mode(self.fusion_mode)

    def save_calibration(self, path: str = CAL_FILE) -> None:
        with open(path, "w") as f:
            json.dump({"offsets": list(self.get_offsets()), "saved": time.time()}, f)


def main() -> None:
    ap = argparse.ArgumentParser(description="BNO055 IMU readout")
    ap.add_argument("--bus", type=int, help="I2C bus number (default: header bus)")
    ap.add_argument("--address", type=lambda s: int(s, 0), help="0x28 or 0x29 (default: probe)")
    ap.add_argument("--xtal", action="store_true", help="use the board's 32 kHz crystal")
    ap.add_argument("--once", action="store_true", help="print one reading and exit")
    ap.add_argument("--save-cal", action="store_true",
                    help=f"save offsets to {os.path.basename(CAL_FILE)} once fully calibrated")
    ap.add_argument("--rate", type=float, default=5, help="lines per second")
    a = ap.parse_args()

    try:
        imu = BNO055(a.bus, a.address, external_crystal=a.xtal)
    except (IMUError, OSError) as e:
        sys.exit(f"error: {e}")
    with imu:
        print(f"BNO055 on i2c-{imu.bus} at {imu.address:#x}, {imu.status()}, "
              f"cal file {'loaded' if os.path.exists(CAL_FILE) else 'none'}")
        time.sleep(0.1)
        saved = False
        try:
            while True:
                h, r, p = imu.euler()
                s, g, ac, m = imu.calibration()
                print(f"heading={h:7.2f}  roll={r:7.2f}  pitch={p:7.2f}   "
                      f"cal sys={s} gyr={g} acc={ac} mag={m}  {imu.temperature()}C", flush=True)
                if a.once:
                    break
                if a.save_cal and not saved and (s, g, ac, m) == (3, 3, 3, 3):
                    imu.save_calibration()
                    saved = True
                    print(f"calibration saved to {CAL_FILE}", flush=True)
                time.sleep(1 / a.rate)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
