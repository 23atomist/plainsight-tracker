# head/tests/test_reference.py
import asyncio, pytest
from plainsight_head.reference import circular_mean_deg, wrap180, PanReference, ReferenceResult
from plainsight_head.state import HeadState, PanRef
# fixture `ctx` builds HeadConfig(env), FakeSerial-backed PicoLink (started, homed flags controllable via fake.model),
# ImuReader over FakeBNO055 (rate 200), HeadState wired to both, JsonStore(tmp_path), events list; see tests/fakes.py helper make_ctx(env, tmp_path)

def test_circular_mean_and_wrap():
    assert circular_mean_deg([359, 1]) == pytest.approx(0.0, abs=1e-6)
    assert circular_mean_deg([360.0]) == pytest.approx(0.0)
    assert wrap180(190) == -170 and wrap180(180) == 180 and wrap180(-180) == 180

async def test_rule1_pico_already_homed_keeps_file_source(ctx):
    ctx.store.write("pan-reference.json", {"pos": 40.0, "source": "host", "t": ctx.now()})
    ctx.fake.model["pan"]["homed"] = True; ctx.fake.emit_status(); await asyncio.sleep(0.05)
    r = await ctx.ref.restore_at_boot()
    assert r.source == "host" and "SETPOS" not in " ".join(ctx.fake.sent) and ctx.state.ref.source == "host"

async def test_rule2_persisted_restore_sets_position(ctx):
    ctx.store.write("pan-reference.json", {"pos": 40.5, "source": "imu", "t": ctx.now() - 100})
    r = await ctx.ref.restore_at_boot()
    assert r == ReferenceResult("imu", 40.5, None) and "SETPOS pan 40.50000" in ctx.fake.sent

async def test_rule2_file_too_old_falls_through_to_imu(ctx_imu_ready):
    c = ctx_imu_ready; c.store.write("pan-reference.json", {"pos": 40.5, "source": "imu", "t": c.now() - 10**7})
    c.imu_fake.heading = 124.0; c.cfg_override(imu_heading_offset_deg=4.0)
    r = await c.ref.restore_at_boot()
    assert r.source == "imu" and r.pan == pytest.approx(120.0) and c.events[-1][0] == "pan_reference"
    assert c.state.ref.persisted and c.store.read("pan-reference.json")["source"] == "imu"

async def test_imu_reference_requires_tilt_homed_and_times_out_on_cal(ctx):
    ctx.fake.model["tilt"]["homed"] = False; ctx.fake.emit_status(); await asyncio.sleep(0.05)
    assert (await ctx.ref.reference_from_imu(0.1)).reason == "tilt not homed"
    ctx.fake.model["tilt"]["homed"] = True; ctx.fake.emit_status(); ctx.imu_fake.cal = (0, 0, 0, 0); await asyncio.sleep(0.05)
    assert (await ctx.ref.reference_from_imu(0.1)).reason == "imu calibration timeout" and ctx.state.ref.source == "none"

async def test_set_from_host_persists_and_reports_previous(ctx):
    await ctx.ref.set_from_host(10.0)
    assert ctx.events[-1] == ("pan_reference", {"source": "host", "pan": 10.0, "previous": 0.0})
    assert ctx.store.read("pan-reference.json")["source"] == "host"
