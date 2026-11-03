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


# --- review round 1: required behaviour -------------------------------------------------

REF = "pan-reference.json"


class StepSleep:
    """Injected sleep that returns only when the test calls step(): one persistence tick per step."""

    def __init__(self):
        self._q = asyncio.Queue()

    async def __call__(self, _s):
        await self._q.get()

    async def step(self):
        self._q.put_nowait(None)
        await asyncio.sleep(0.02)


async def _set_pan(c, **kw):
    c.fake.model["pan"].update(kw)
    await c.status_now()


async def test_run_persistence_writes_only_when_idle_changed_referenced_and_homed(ctx):
    await ctx.streaming(False)
    step = StepSleep(); ctx.ref_override(sleep=step)
    await _set_pan(ctx, pos=7.0)
    task = asyncio.create_task(ctx.ref.run_persistence())
    try:
        await ctx.ref.set_from_host(10.0)            # last status still says pos 7, from before SETPOS
        await step.step()
        assert ctx.store.read(REF)["pos"] == 10.0     # the stale 7 was not saved
        await _set_pan(ctx, pos=12.0)
        await step.step()
        assert ctx.store.read(REF) == {"pos": 12.0, "source": "host", "t": pytest.approx(ctx.now(), abs=5)}
        await _set_pan(ctx, pos=13.0, vel=5.0)        # moving
        await step.step()
        assert ctx.store.read(REF)["pos"] == 12.0
        await _set_pan(ctx, pos=14.0, vel=0.0, homed=False)   # unhomed (on_status drops ref)...
        ctx.state.set_ref(PanRef("host", True, ctx.now()))    # ...force it back: homed alone must block
        await step.step()
        assert ctx.store.read(REF)["pos"] == 12.0
        await _set_pan(ctx, homed=True)
        ctx.ref.note_enable_off()                     # ref none
        await step.step()
        assert ctx.store.read(REF)["pos"] == 12.0
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_persist_now_writes_current_pos_even_while_moving_but_not_unreferenced(ctx):
    await ctx.ref.set_from_host(10.0)
    await _set_pan(ctx, pos=11.5, vel=3.0)
    await ctx.ref.persist_now()
    assert ctx.store.read(REF)["pos"] == 11.5
    ctx.ref.note_enable_off()
    await _set_pan(ctx, pos=20.0, vel=0.0)
    await ctx.ref.persist_now()
    assert ctx.store.read(REF)["pos"] == 11.5


async def test_note_enable_off_clears_reference(ctx):
    await ctx.ref.set_from_host(10.0)
    ctx.ref.note_enable_off()
    assert ctx.state.ref == PanRef("none")


async def test_pan_losing_homed_drops_reference_and_emits(ctx):
    await ctx.ref.set_from_host(10.0)
    await ctx.status_now()                           # SETPOS marked pan homed
    await _set_pan(ctx, homed=False)
    assert ctx.state.ref.source == "none"
    assert ctx.events[-1] == ("pan_reference", {"source": "none", "reason": "pan unhomed"})


async def test_pan_restore_none_leaves_pan_unreferenced(ctx):
    ctx.store.write(REF, {"pos": 40.5, "source": "imu", "t": ctx.now()})
    ctx.cfg_override(pan_restore="none")
    assert await ctx.ref.restore_at_boot() == ReferenceResult("none", None, "pan_restore=none")
    assert not any(s.startswith(("SETPOS", "MOVE")) for s in ctx.fake.sent)


async def test_pan_restore_imu_ignores_a_fresh_file(ctx_imu_ready):
    c = ctx_imu_ready
    c.store.write(REF, {"pos": 40.5, "source": "host", "t": c.now()})
    c.imu_fake.heading = 30.0; c.cfg_override(pan_restore="imu")
    r = await c.ref.restore_at_boot()
    assert r.source == "imu" and r.pan == pytest.approx(30.0)
    assert "SETPOS pan 40.50000" not in c.fake.sent and "MOVE tilt 0.00000" in c.fake.sent


async def test_pico_error_during_rule2_returns_none(ctx):
    ctx.store.write(REF, {"pos": 40.5, "source": "imu", "t": ctx.now()})
    ctx.fake.reply_override["SETPOS"] = "err axis moving"
    assert await ctx.ref.restore_at_boot() == ReferenceResult("none", None, "pico: axis moving")
    assert ctx.state.ref.source == "none"


async def test_pico_error_during_imu_north_returns_none_and_emits(ctx_imu_ready):
    c = ctx_imu_ready
    c.fake.reply_override["MOVE"] = "err not homed"
    r = await c.ref.reference_from_imu(1.0)
    assert r == ReferenceResult("none", None, "pico: not homed")
    assert c.events[-1] == ("pan_reference", {"source": "none", "reason": "pico: not homed"})
    assert not c.ref.busy


async def test_tilt_did_not_settle(ctx_imu_ready):
    c = ctx_imu_ready
    c.cfg_override(ref_tilt_deg=10.0); c.ref_override(settle_cap_s=0.15)   # fake tilt stays at 0
    assert (await c.ref.reference_from_imu(1.0)).reason == "tilt did not settle"
    c.cfg_override(ref_tilt_deg=0.0); c.fake.model["tilt"]["vel"] = 4.0     # in place but moving
    assert (await c.ref.reference_from_imu(1.0)).reason == "tilt did not settle"
    assert not any(s.startswith("SETPOS") for s in c.fake.sent)


@pytest.mark.parametrize("contents", [
    '{"pos": "x", "source": "imu", "t": 1e12}',
    '{"pos": 1.0, "source": "bogus", "t": 1e12}',
    '{"pos": NaN, "source": "imu", "t": 1e12}',
    '{"pos": 1.0, "source": "imu"}',
    '[1, 2]',
])
async def test_malformed_file_is_treated_as_absent(ctx, contents):
    ctx.data_dir.mkdir(parents=True, exist_ok=True)
    (ctx.data_dir / REF).write_text(contents)
    ctx.fake.model["pan"]["homed"] = True; await ctx.status_now()
    assert await ctx.ref.restore_at_boot() == ReferenceResult("host", 0.0, None)   # rule 1, default source
    ctx.fake.model["pan"]["homed"] = False; await ctx.status_now()
    ctx.ref_override()
    assert (await ctx.ref.restore_at_boot()).reason == "tilt not homed"            # skipped rule 2
    assert not any(s.startswith("SETPOS") for s in ctx.fake.sent)


async def test_no_pico_status_at_boot(ctx):
    await ctx.streaming(False)
    ctx.state.pico = None; ctx.ref_override(status_wait_s=0.1)
    ctx.store.write(REF, {"pos": 40.5, "source": "imu", "t": ctx.now()})
    assert await ctx.ref.restore_at_boot() == ReferenceResult("none", None, "no pico status")
    assert (await ctx.ref.reference_from_imu(0.1)).reason == "no pico status"
    assert ctx.fake.sent == []


async def test_boot_waits_for_a_status_before_overwriting_a_homed_pico(ctx):
    ctx.store.write(REF, {"pos": 40.5, "source": "imu", "t": ctx.now()})
    ctx.fake.model["pan"].update(homed=True, pos=33.0)
    ctx.state.pico = None                            # link up, no status yet; the stream delivers one
    assert await ctx.ref.restore_at_boot() == ReferenceResult("imu", 33.0, None)
    assert not any(s.startswith("SETPOS") for s in ctx.fake.sent)


async def test_imu_reference_and_host_setpos_serialise_and_report_busy(ctx_imu_ready):
    c = ctx_imu_ready
    c.imu_fake.cal = (0, 0, 0, 0)
    imu_task = asyncio.create_task(c.ref.reference_from_imu(0.3))
    await asyncio.sleep(0.1)
    assert c.ref.busy
    host_task = asyncio.create_task(c.ref.set_from_host(5.0))
    await asyncio.sleep(0.05)
    assert not host_task.done() and not any(s.startswith("SETPOS") for s in c.fake.sent)
    assert (await imu_task).reason == "imu calibration timeout"
    await host_task
    assert not c.ref.busy and c.fake.sent[-1] == "SETPOS pan 5.00000"


# --- final review: the E-STOP latch gates the head's own motion ---------------------------

async def test_imu_north_refuses_to_move_tilt_while_estop_latched(ctx_imu_ready):
    c = ctx_imu_ready
    c.state.set_estop(True)
    r = await c.ref.reference_from_imu(1.0)
    assert r == ReferenceResult("none", None, "estop latched")
    assert not any(s.startswith("MOVE") for s in c.fake.sent)


async def test_estop_during_the_tilt_settle_aborts_at_once(ctx_imu_ready):
    c = ctx_imu_ready
    c.cfg_override(ref_tilt_deg=10.0)  # the fake never reaches it: the settle wait runs until cap
    task = asyncio.create_task(c.ref.reference_from_imu(1.0))
    await asyncio.sleep(0.1)
    assert "MOVE tilt 10.00000" in c.fake.sent
    c.state.set_estop(True)
    r = await asyncio.wait_for(task, 1.0)  # not the 30 s settle cap
    assert r.reason == "estop latched"
    assert not any(s.startswith("SETPOS") for s in c.fake.sent)
