import math, pytest
from plainsight_head.protocol import *

STATUS = "pos=12.0000,30.0000,0.0000,0.0000 vel=0.0000,0.0000,0.0000,0.0000 tgt=12.0000,30.0000,0.0000,0.0000 mode=PPII homed=1100 es=0000 en=1 drv=1111"

def test_parse_status_fields():
    st = parse_status(STATUS)
    assert st.axes["pan"] == AxisStatus(12.0, 0.0, 12.0, "P", True, False, True)
    assert st.axes["zoom"].mode == "I" and st.axes["zoom"].homed is False
    assert st.enabled is True and st.moving is False

def test_moving_when_velocity_or_homing():
    assert parse_status(STATUS.replace("vel=0.0000,", "vel=1.5000,")).moving
    assert parse_status(STATUS.replace("mode=PPII", "mode=PHII")).moving

@pytest.mark.parametrize("bad", ["pos=1.0,2.0 vel=", "pos=1,2,3 vel=0,0,0,0 tgt=0,0,0,0 mode=IIII homed=0000 es=0000 en=1 drv=1111", ""])
def test_parse_status_rejects_truncated(bad):
    with pytest.raises(ProtocolError):
        parse_status(bad)

def test_parse_event_forms():
    assert parse_event("homed tilt") == PicoEvent("homed", "tilt", None)
    assert parse_event("driver_fault pan drv_status=0x40") == PicoEvent("driver_fault", "pan", "drv_status=0x40")
    assert parse_event("track_timeout pan") == PicoEvent("track_timeout", "pan", None)

def test_parse_cfg_and_drv():
    assert parse_cfg_lines(["C pan gear 6.44", "C global track_timeout_ms 3000"]) == {"pan": {"gear": 6.44}, "global": {"track_timeout_ms": 3000.0}}
    assert parse_drv_lines(["D pan socket=Z online=1 version=0x21"])["pan"] == {"socket": "Z", "online": "1", "version": "0x21"}

def test_fmt_axes():
    assert fmt_axes({"pan": 1, "tilt": (2, 3)}) == "pan 1.00000 tilt 2.00000 3.00000"
    for bad in ({}, {"yaw": 1}, {"pan": math.nan}, {"pan": math.inf}):
        with pytest.raises(ProtocolError):
            fmt_axes(bad)

def test_classify_line():
    assert classify_line("*S pos=1")[0] == "status"
    assert classify_line("*E homed tilt") == ("event", "homed tilt")
    assert classify_line("ok") == ("reply", "ok")


@pytest.mark.parametrize("field,value", [("pos", "nan"), ("vel", "inf"), ("tgt", "-inf"), ("pos", "NaN")])
def test_parse_status_rejects_non_finite_numbers(field, value):
    bad = STATUS.split(f"{field}=")[0] + f"{field}={value},0,0,0 " + STATUS.split(f"{field}=")[1].split(" ", 1)[1]
    with pytest.raises(ProtocolError, match="non-finite"):
        parse_status(bad)


@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_parse_cfg_rejects_non_finite_values(value):
    with pytest.raises(ProtocolError, match="non-finite"):
        parse_cfg_lines([f"C pan vmax {value}"])
