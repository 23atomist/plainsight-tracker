# plainsight-ptz firmware (SKR Pico)

Camera pan / tilt / zoom / focus controller for ADS-B aircraft tracking, built
on a BIGTREETECH **SKR Pico v1.0** (RP2040, 4× TMC2209) with all-new firmware.

```
ADS-B software ──(USB or Pi-header UART, text protocol)──► SKR Pico ──► 4 steppers
    tools/ptz.py  (library + CLI)                           src/
    tools/geo.py  (az/el + rates from aircraft position)
```

Default mapping below; any axis can be moved to any socket with
`CFG <axis> socket <0-3>` (0=XM 1=YM 2=ZM 3=EM), then `SAVE` and `REBOOT`.
`DRV` shows which socket each axis is on.

| Driver socket | Axis (default) | Endstop connector |
|---|---|---|
| X | pan | X-STOP (GPIO4) |
| Y | tilt | Y-STOP (GPIO3) |
| Z | zoom | Z-STOP (GPIO25) |
| E | focus | E-STOP (GPIO16) |

The board has no WiFi, so control is a line-based serial protocol on **USB**
and, identically, on the **Raspberry Pi UART header** (GPIO0/1), so a Pi
mounted beside the head can drive it with no USB cable. See
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Firmware

- Core 1 is a dedicated 50 kHz step generator. Core 0 runs a 1 kHz planner
  (trapezoidal moves, jog, and `TRACK` with velocity feed-forward), the two
  host ports and TMC2209 upkeep.
- Drivers are configured over UART: current, microsteps, stealthChop. They
  are polled every second and re-configured automatically when motor power
  comes back (the TMC2209s forget their settings without VM).
- Settings live in flash (`CFG …`, then `SAVE`).
- Status LED: amber = disabled, green = idle, blue = moving, blinking red =
  a driver offline/faulted (usually motor power off).
- Heater and fan outputs are held off.

### Build and flash

```sh
cd firmware
pio run                     # build
pio run -t upload           # flash over USB
```

**The first flash (replacing Klipper)** needs the bootloader. Remove motor
power. Hold the SKR Pico's **BOOT** button, press and release **RESET**, then
release BOOT. An `RPI-RP2` drive appears; then run `pio run -t upload`, or copy
`firmware/.pio/build/skr_pico/firmware.uf2` onto the drive. After that,
uploads need no buttons, and `BOOTSEL` over the protocol also works.

From the Pi (board on the Pi's USB): copy `firmware.uf2` next to `tools/` and
run `tools/flash.sh firmware.uf2`. It sends `BOOTSEL`, copies the image to the
`RPI-RP2` drive and keeps the saved settings.

USB alone powers the MCU only if the board's USB-power jumper is fitted. The
drivers answer on UART only with 12–24 V motor power connected; until then
`drv=0000` in status and the LED blinks red once enabled. That is expected.

## Tools (run on the head computer)

The host is an Orange Pi Zero 2W next to the head. Connect it either way:

- **USB (recommended):** a USB-C data cable from the Zero 2W's OTG port
  (not the power-only port) to the SKR Pico. Shows up as `/dev/ttyACM0` and
  `ptz.py` finds it automatically. Add your user to the `dialout` group.
- **UART:** 3.3 V TTL from a Zero 2W header UART to the SKR Pico's Pi header:
  Pi TX → GPIO1 (RX), Pi RX ← GPIO0 (TX), GND ↔ GND. Enable the UART overlay
  first (check the Zero 2W pinout for which header UART), then
  `python ptz.py --port /dev/ttySx status`.

```sh
cd firmware/tools
pip install -r requirements.txt
python ptz.py status
python ptz.py keys            # keyboard jogging: arrows pan/tilt, w/s zoom, a/d focus
python ptz.py repl            # raw protocol prompt
python ptz.py move pan 90 tilt 20
python ptz.py cfg pan         # show pan settings
```

### IMU (BNO055)

A BNO055 on the Pi's I2C header (VIN→pin 1 3.3 V, SDA→3, SCL→5, GND→6),
mounted on the tilting camera bracket. Enable the header bus with
`overlays=i2c1-pi` in `/boot/armbianEnv.txt` and add the user to the `i2c`
group.

```sh
python imu.py              # heading / roll / pitch + calibration status
python imu.py --save-cal   # move it through orientations + figure-8; saves
                           # imu_cal.json when all four reach 3
```

From code:

```python
from ptz import PTZ
from geo import aim

site = (51.4700, -0.4543, 25.0)                # lat, lon, metres
with PTZ(on_event=print) as ptz:
    a = aim(site, dict(lat=51.52, lon=-0.40, alt_m=3000*0.3048,
                       gs_kt=180, track_deg=270, vrate_fpm=-700))
    ptz.track(pan=(a["az"], a["az_rate"]), tilt=(a["el"], a["el_rate"]))
```

## First-time setup (with the mechanics attached)

Values below are examples; use your head's real numbers.

1. **Motor power on**, then `python ptz.py drv`. All four drivers should
   report `online=1 version=0x21`.
2. **Gearing**: `CFG pan gear 20` for a 20:1 worm or belt, likewise for tilt.
   Leave zoom/focus at `gear 1` (units = motor degrees) or set it to the
   ring-to-pinion ratio.
3. **Currents**: start low (`CFG pan run_current 0.6`), raise until moves are
   reliable. Lens motors are often 0.1–0.3 A.
4. **Direction**: `MOVER pan 10` should turn clockwise seen from above (az
   increasing). Otherwise `CFG pan invert 1`. Tilt: `MOVER tilt 10` should
   raise the camera.
5. **Limits**: `CFG pan min -270`, `CFG pan max 270` if your cabling allows
   more than one turn. Overlap lets the tracker follow an aircraft through
   north without an unwind. With a slip ring, set `min 0 max 0` for continuous
   rotation.
6. **Reference**:
   - with endstops: `CFG pan home_dir -1`, `CFG pan home_pos <az of switch>`,
     then `HOME pan`.
   - without: point the camera at true north (or a known landmark), then
     `SETPOS pan 0` (or the landmark's azimuth). Point the camera level, then
     `SETPOS tilt 0`.
7. **Speeds**: raise `vmax`/`amax` until the head misses steps, then back
   off ~30 %.
8. `SAVE`.
