from plainsight_head.state import HeadState, PanRef
from plainsight_head.config import HeadConfig
from plainsight_head.protocol import parse_status
from plainsight_head.imu import ImuSample

STATUS = parse_status("pos=12.0000,30.0000,0,0 vel=0,0,0,0 tgt=12,30,0,0 mode=PPII homed=1100 es=0000 en=1 drv=1111")


def sample(**k):
    d = dict(t=0, heading=124.0, roll=-0.4, pitch=31.5, quat=(1,0,0,0), gravity=(0,0,9.81), linacc=(0,0,0), cal=(3,3,3,2), temp_c=28); d.update(k)
    return ImuSample(**d)


def test_tick_shape_and_publish():
    st = HeadState(HeadConfig.from_env({}), time_fn=lambda: 1762150000.123); got = []
    st.subscribe(got.append); st.set_imu_link(True); st.on_imu(sample()); st.set_pico_link(True); st.on_pico_status(STATUS)
    t = got[-1]
    assert set(t) == {"type","t","seq","axes","enabled","moving","estop","imu","tiltDisagreeDeg","ref","link"}
    assert t["t"] == 1762150000123 and t["seq"] == 1 and t["axes"]["pan"]["pos"] == 12.0 and t["axes"]["pan"]["mode"] == "P"
    assert t["imu"]["cal"] == {"sys":3,"gyr":3,"acc":3,"mag":2} and t["link"] == {"pico": True, "imu": True}
    assert t["ref"] == {"pan": "none", "persisted": False, "ageS": None}


def test_tilt_disagree_uses_axis_sign_and_offset():
    cfg = HeadConfig.from_env({"HEAD_IMU_PITCH_OFFSET_DEG": "1.5", "HEAD_IMU_TILT_SIGN": "-1", "HEAD_IMU_TILT_AXIS": "roll"})
    st = HeadState(cfg); st.set_imu_link(True); st.on_imu(sample(roll=-28.5)); st.set_pico_link(True); st.pico = STATUS
    assert st.tilt_disagree_deg() == -(-28.5 - 1.5) - 30.0


def test_pico_down_tick_has_no_axes_and_imu_down_is_ok_false():
    st = HeadState(HeadConfig.from_env({})); got = []; st.subscribe(got.append)
    st.set_pico_link(False); st.publish_imu_only()
    assert "axes" not in got[-1] and got[-1]["imu"] == {"ok": False, "heading": None, "pitch": None, "roll": None, "cal": None, "tempC": None}
    assert got[-1]["tiltDisagreeDeg"] is None


def test_subscriber_exception_does_not_stop_others():
    st = HeadState(HeadConfig.from_env({})); got = []
    st.subscribe(lambda t: 1/0); st.subscribe(got.append); st.set_pico_link(True); st.on_pico_status(STATUS)
    assert len(got) == 1
