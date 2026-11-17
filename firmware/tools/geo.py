"""Look-angle math for pointing the head at an aircraft.

look_angles() turns a site position and an aircraft position into azimuth /
elevation / slant range. aim() also extrapolates the aircraft along its
ADS-B ground speed, track and vertical rate to produce the angular rates
the controller's TRACK command wants as feed-forward.

Altitudes are metres above the WGS84 ellipsoid. ADS-B "alt_baro" is pressure
altitude in feet: multiply by 0.3048 (and prefer alt_geom when present).
"""
from __future__ import annotations

import math

_A = 6378137.0
_F = 1 / 298.257223563
_E2 = _F * (2 - _F)
KT = 0.514444  # m/s per knot
FPM = 0.00508  # m/s per ft/min


def _ecef(lat: float, lon: float, h: float) -> tuple[float, float, float]:
    la, lo = math.radians(lat), math.radians(lon)
    n = _A / math.sqrt(1 - _E2 * math.sin(la) ** 2)
    return ((n + h) * math.cos(la) * math.cos(lo),
            (n + h) * math.cos(la) * math.sin(lo),
            (n * (1 - _E2) + h) * math.sin(la))


def look_angles(site_lat, site_lon, site_alt_m, lat, lon, alt_m) -> tuple[float, float, float]:
    """Return (azimuth deg 0-360 from true north, elevation deg, slant range m)."""
    ox, oy, oz = _ecef(site_lat, site_lon, site_alt_m)
    tx, ty, tz = _ecef(lat, lon, alt_m)
    dx, dy, dz = tx - ox, ty - oy, tz - oz
    la, lo = math.radians(site_lat), math.radians(site_lon)
    e = -math.sin(lo) * dx + math.cos(lo) * dy
    n = -math.sin(la) * math.cos(lo) * dx - math.sin(la) * math.sin(lo) * dy + math.cos(la) * dz
    u = math.cos(la) * math.cos(lo) * dx + math.cos(la) * math.sin(lo) * dy + math.sin(la) * dz
    az = math.degrees(math.atan2(e, n)) % 360.0
    el = math.degrees(math.atan2(u, math.hypot(e, n)))
    return az, el, math.sqrt(dx * dx + dy * dy + dz * dz)


def extrapolate(lat, lon, alt_m, gs_kt, track_deg, vrate_fpm, dt) -> tuple[float, float, float]:
    """Dead-reckon an aircraft dt seconds ahead (flat earth: fine for seconds)."""
    d = gs_kt * KT * dt
    tr = math.radians(track_deg)
    dlat = d * math.cos(tr) / 111_320.0
    dlon = d * math.sin(tr) / (111_320.0 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon, alt_m + vrate_fpm * FPM * dt


def aim(site, ac, dt=1.0) -> dict:
    """site = (lat, lon, alt_m); ac = dict with lat, lon, alt_m, gs_kt, track_deg,
    vrate_fpm (already extrapolated to "now" by the caller if the fix is old).

    Returns {"az", "el", "range_m", "az_rate", "el_rate"} with rates in deg/s,
    ready for ptz.track(pan=(az, az_rate), tilt=(el, el_rate)).
    """
    az0, el0, r = look_angles(*site, ac["lat"], ac["lon"], ac["alt_m"])
    nxt = extrapolate(ac["lat"], ac["lon"], ac["alt_m"], ac.get("gs_kt", 0.0),
                      ac.get("track_deg", 0.0), ac.get("vrate_fpm", 0.0), dt)
    az1, el1, _ = look_angles(*site, *nxt)
    daz = (az1 - az0 + 180.0) % 360.0 - 180.0
    return {"az": az0, "el": el0, "range_m": r, "az_rate": daz / dt, "el_rate": (el1 - el0) / dt}
