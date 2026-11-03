"""BNO055 absolute-orientation IMU: raw-ioctl I2C driver and the 20 Hz asyncio reader."""
from __future__ import annotations

import asyncio
import fcntl
import glob
import logging
import os
import struct
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

log = logging.getLogger(__name__)

# Copied from plainsight/host/imu.py (2026-11); keep in sync by hand.
I2C_SLAVE = 0x0703
HEADER_I2C = "5002400.i2c"  # TWI1 on PI7/PI8 = header pins 5/3 (overlay i2c1-pi)

CHIP_ID, PAGE_ID = 0x00, 0x07
EUL_DATA, QUA_DATA, TEMP = 0x1A, 0x20, 0x34
CALIB_STAT, ST_RESULT, SYS_STATUS, SYS_ERR = 0x35, 0x36, 0x39, 0x3A
UNIT_SEL, OPR_MODE, PWR_MODE, SYS_TRIGGER = 0x3B, 0x3D, 0x3E, 0x3F
AXIS_MAP_CONFIG, AXIS_MAP_SIGN = 0x41, 0x42
OFFSETS, OFFSETS_LEN = 0x55, 22
MODE_CONFIG, MODE_IMU, MODE_NDOF = 0x00, 0x08, 0x0C  # IMU = gyro+accel only, no compass

_SAMPLE_LEN = 28  # EUL(6) QUA(8) LIA(6) GRV(6) TEMP(1) CALIB_STAT(1), contiguous from EUL_DATA
_BURST_MAX = 1000
CAL_RETRY_FIRST_S = 5.0  # offsets-read retry backoff once fully calibrated: 5, 10, 20, 40, 60, 60 ...
CAL_RETRY_MAX_S = 60.0
_REOPEN_S = 1.0
_FAIL_LIMIT = 3  # consecutive read failures before the link is declared down


@dataclass(frozen=True)
class ImuSample:
    t: float
    heading: float
    roll: float
    pitch: float
    quat: tuple[float, float, float, float]
    gravity: tuple[float, float, float]
    linacc: tuple[float, float, float]
    cal: tuple[int, int, int, int]
    temp_c: int


class IMUError(Exception):
    pass


def find_bus() -> int:
    for dev in sorted(glob.glob("/sys/bus/i2c/devices/i2c-*")):
        if os.path.realpath(os.path.join(dev, "..")).endswith(HEADER_I2C):
            return int(dev.rsplit("-", 1)[1])
    raise IMUError("header I2C bus not found; enable overlay i2c1-pi in /boot/armbianEnv.txt")


class BNO055:
    def __init__(self, bus: int | None = None, address: int | None = None,
                 external_crystal: bool = False, mode: int = MODE_NDOF):
        self.fusion_mode = mode
        self.bus = find_bus() if bus is None else bus
        self.fd = os.open(f"/dev/i2c-{self.bus}", os.O_RDWR)
        try:
            self.address = address if address is not None else self._probe()
            self._begin(external_crystal)
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
        try:
            return self.read(OFFSETS, OFFSETS_LEN)
        finally:
            self._restore_fusion()

    def set_offsets(self, data: bytes) -> None:
        if len(data) != OFFSETS_LEN:
            raise IMUError("bad calibration data")
        self._mode(MODE_CONFIG)
        try:
            self.write(OFFSETS, *data)
        finally:
            self._restore_fusion()

    def _restore_fusion(self) -> None:
        """Always leave CONFIG mode; a failed restore must not mask the original error."""
        try:
            self._mode(self.fusion_mode)
        except OSError:
            log.exception("could not restore fusion mode after offsets access")

    # -- head-controller addition -----------------------------------------
    def read_sample(self, now: float) -> ImuSample:
        """One 28-byte burst covering euler, quaternion, linear accel, gravity, temp, cal."""
        raw = self.read(EUL_DATA, _SAMPLE_LEN)
        if len(raw) != _SAMPLE_LEN:
            raise OSError(f"short BNO055 read: {len(raw)} of {_SAMPLE_LEN} bytes")
        h, r, p, qw, qx, qy, qz, lx, ly, lz, gx, gy, gz, temp, c = struct.unpack("<3h4h3h3hbB", raw)
        return ImuSample(
            t=now,
            heading=(h / 16.0) % 360.0,
            roll=r / 16.0,
            pitch=p / 16.0,
            quat=(qw / 16384.0, qx / 16384.0, qy / 16384.0, qz / 16384.0),
            gravity=(gx / 100.0, gy / 100.0, gz / 100.0),
            linacc=(lx / 100.0, ly / 100.0, lz / 100.0),
            cal=(c >> 6 & 3, c >> 4 & 3, c >> 2 & 3, c & 3),
            temp_c=temp,
        )


class ImuReader:
    """Polls the sensor at rate_hz, publishes `latest`, and survives link loss.

    Every sensor access (open, sample reads, bursts, offsets, close) runs in a worker thread,
    one at a time behind `_bus`: a held bus or a kernel adapter timeout then blocks that thread,
    never the event loop that runs the jog dead-man, E-STOP, HTTP and the Pico stale check.
    """

    def __init__(self, open_fn: Callable[[], Any], *, rate_hz: float = 20,
                 on_fully_calibrated: Callable[[bytes], None] | None = None,
                 on_link: Callable[[bool], None] | None = None,
                 time_fn: Callable[[], float] = time.monotonic,
                 reopen_s: float = _REOPEN_S) -> None:
        self._open_fn = open_fn
        self._period = 1.0 / rate_hz
        self._on_cal = on_fully_calibrated
        self._on_link = on_link
        self._time = time_fn
        self._reopen_s = reopen_s
        self._dev: Any = None
        self._bus = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._cal_fired = False
        self._cal_retry_at: float | None = None
        self._cal_retry_s = CAL_RETRY_FIRST_S
        self.latest: ImuSample | None = None
        self.ok = False

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="imu-reader")

    async def close(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self._close_dev()
        self.ok = False
        self._cal_fired = False

    async def _io(self, fn: Callable[..., Any], *args: Any,
                  orphan: Callable[[Any], None] | None = None) -> Any:
        """Run one blocking sensor call in a worker thread, holding the bus lock until it returns."""
        async with self._bus:
            fut = asyncio.get_running_loop().run_in_executor(None, fn, *args)
            try:
                return await asyncio.shield(fut)
            except asyncio.CancelledError:
                # A thread cannot be interrupted: keep the bus until it returns, so no other call
                # overlaps it, and dispose of a result nobody will take (an opened device).
                await asyncio.wait([fut])
                if orphan is not None and not fut.cancelled() and fut.exception() is None:
                    orphan(fut.result())
                elif not fut.cancelled() and fut.exception() is not None:
                    log.warning("IMU call finished after cancellation with %r", fut.exception())
                raise

    async def _close_dev(self) -> None:
        dev, self._dev = self._dev, None
        if dev is not None:
            try:
                await self._io(dev.close)
            except Exception:
                log.exception("closing IMU failed")

    def _set_link(self, up: bool) -> None:
        changed = self.ok != up
        self.ok = up
        if changed and self._on_link is not None:
            try:
                self._on_link(up)
            except Exception:
                log.exception("on_link callback failed")

    async def load_offsets(self, data: bytes) -> None:
        dev = self._dev
        if dev is None:
            log.warning("load_offsets ignored: IMU not open")
            return
        await self._io(dev.set_offsets, data)

    async def burst(self, n: int) -> list[ImuSample]:
        """Read up to n (max 1000) samples back-to-back; returns [] if the sensor is not open.

        Each read takes the bus lock on its own, so the 20 Hz reader interleaves with a burst.
        """
        dev = self._dev
        if dev is None:
            return []
        return [await self._io(dev.read_sample, self._time()) for _ in range(min(n, _BURST_MAX))]

    async def _open(self) -> bool:
        try:
            self._dev = await self._io(self._open_fn, orphan=_close_quietly)
        except Exception as e:
            log.warning("IMU open failed: %s", e)
            self._dev = None
            return False
        return True

    async def _maybe_fire_calibrated(self, sample: ImuSample) -> None:
        if self._cal_fired or self._on_cal is None or sample.cal != (3, 3, 3, 3):
            return
        now = self._time()
        if self._cal_retry_at is not None and now < self._cal_retry_at:
            return
        try:
            offsets = await self._io(self._dev.get_offsets)
        except Exception:
            log.exception("reading calibration offsets failed; retrying in %.0f s", self._cal_retry_s)
            self._cal_retry_at = now + self._cal_retry_s
            self._cal_retry_s = min(self._cal_retry_s * 2, CAL_RETRY_MAX_S)
            return
        self._cal_retry_at, self._cal_retry_s = None, CAL_RETRY_FIRST_S
        self._cal_fired = True
        try:
            self._on_cal(offsets)
        except Exception:
            log.exception("on_fully_calibrated callback failed")

    async def _run(self) -> None:
        fails = 0
        while True:
            if self._dev is None:
                if await self._open():
                    fails = 0
                    self._set_link(True)
                else:
                    self._set_link(False)
                    await asyncio.sleep(self._reopen_s)
                    continue
            try:
                sample = await self._io(self._dev.read_sample, self._time())
            except Exception as e:
                if not isinstance(e, OSError):
                    log.exception("unexpected IMU read error")
                fails += 1
                if fails >= _FAIL_LIMIT:
                    log.warning("IMU link down after %d failed reads: %s", fails, e)
                    await self._close_dev()
                    self._set_link(False)
                    await asyncio.sleep(self._reopen_s)
                    continue
            else:
                fails = 0
                self.latest = sample
                await self._maybe_fire_calibrated(sample)
            await asyncio.sleep(self._period)


def _close_quietly(dev: Any) -> None:
    try:
        dev.close()
    except Exception:
        log.exception("closing an IMU opened during cancellation failed")
