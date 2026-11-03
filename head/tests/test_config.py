from plainsight_head.config import HeadConfig
import pytest

def test_defaults_match_spec():
    c = HeadConfig.from_env({})
    assert (c.port, c.serial, c.auto_home, c.pan_restore) == (8780, "/dev/ttyACM0", True, "persisted")
    assert (c.jog_deadman_ms, c.track_timeout_ms, c.stream_ms, c.data_dir) == (500, 1000, 100, "/data")
    assert (c.ref_timeout_s, c.pan_restore_max_age_s, c.imu_tilt_axis, c.imu_tilt_sign) == (120, 604800, "pitch", 1)
    assert c.ref_tilt_deg == 2.0  # off the tilt endstop (first light: 0 fired endstop_hit)

def test_env_overrides_and_bool_parsing():
    c = HeadConfig.from_env({"HEAD_PORT": "9000", "HEAD_AUTO_HOME": "no", "HEAD_PAN_RESTORE": "imu", "HEAD_I2C_BUS": "3"})
    assert (c.port, c.auto_home, c.pan_restore, c.i2c_bus) == (9000, False, "imu", 3)

@pytest.mark.parametrize("key,val", [("HEAD_PORT", "x"), ("HEAD_PAN_RESTORE", "maybe"), ("HEAD_IMU_TILT_AXIS", "yaw"), ("HEAD_IMU_TILT_SIGN", "2")])
def test_bad_values_name_the_key(key, val):
    with pytest.raises(ValueError, match=key):
        HeadConfig.from_env({key: val})


def test_empty_values_mean_unset():
    c = HeadConfig.from_env({"HEAD_I2C_BUS": "", "HEAD_IMU_ADDRESS": " ", "HEAD_PORT": "",
                             "HEAD_SERIAL": ""})
    d = HeadConfig()
    assert (c.i2c_bus, c.imu_address, c.port, c.serial) == (None, None, d.port, d.serial)


@pytest.mark.parametrize("key,ok,bad", [
    ("HEAD_STREAM_MS", ["20", "1000"], ["19", "1001", "0"]),
    ("HEAD_JOG_DEADMAN_MS", ["100", "10000"], ["99", "10001"]),
    ("HEAD_PORT", ["1", "65535"], ["0", "65536", "-5"]),
])
def test_range_checks(key, ok, bad):
    for v in ok:
        HeadConfig.from_env({key: v})
    for v in bad:
        with pytest.raises(ValueError, match=key):
            HeadConfig.from_env({key: v})
