"""Shared async fixtures: a wired head context over the fake Pico and fake BNO055."""
import pytest

from tests.fakes import make_ctx


@pytest.fixture
async def ctx(tmp_path):
    c = await make_ctx({}, tmp_path)
    try:
        yield c
    finally:
        await c.close()


@pytest.fixture
async def ctx_imu_ready(ctx):
    ctx.imu_fake.cal = (3, 3, 3, 3)
    ctx.fake.model["tilt"]["homed"] = True
    await ctx.status_now()
    return ctx
