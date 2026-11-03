"""The API document and its JSON Schemas stay true to what the head emits and accepts."""
import asyncio
import json
import pathlib
import re

import jsonschema
import pytest

ROOT = pathlib.Path(__file__).parents[2]
SCHEMAS = ROOT / "docs" / "head-api" / "schemas"
DOC = ROOT / "docs" / "HEAD-API.md"
FENCE = re.compile(r"^```json[ \t]+([A-Za-z0-9_-]+)[ \t]*\n(.*?)^```[ \t]*$", re.S | re.M)


def load(name):
    return json.loads((SCHEMAS / name).read_text())


def test_live_tick_validates(ctx):
    jsonschema.validate(ctx.state.tick(), load("tick.json"))


def test_pico_down_tick_validates(ctx):
    ctx.state.set_pico_link(False)
    tick = ctx.state.tick()
    assert "axes" not in tick
    jsonschema.validate(tick, load("tick.json"))


def test_event_validates():
    jsonschema.validate({"type": "event", "t": 1, "name": "homed", "axis": "tilt", "detail": None},
                        load("event.json"))


def _event_names(schema: dict) -> set[str]:
    names = set()
    for branch in schema["oneOf"]:
        name = branch["properties"]["name"]
        names |= {name["const"]} if "const" in name else set(name["enum"])
    return names


def test_every_event_name_has_a_tagged_example():
    documented = {json.loads(body)["name"] for stem, body in FENCE.findall(DOC.read_text())
                  if stem == "event"}
    assert documented == _event_names(load("event.json"))


@pytest.mark.parametrize("bad", [
    {"name": "pan_reference", "axis": None, "detail": {"source": "none", "pan": 1.0}},
    {"name": "pan_reference", "axis": None, "detail": {"source": "imu", "pan": 1.0}},
    {"name": "pan_reference_failed", "axis": None, "detail": {"source": "none"}},
    {"name": "estop", "axis": None, "detail": "x"},
    {"name": "homed", "axis": None, "detail": None},
    {"name": "no_such_event", "axis": None, "detail": None},
])
def test_event_schema_rejects_mistyped_details(bad):
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate({"type": "event", "t": 1, **bad}, load("event.json"))


async def test_events_the_head_emits_validate(ctx_imu_ready):
    """Drive the code paths that publish events and validate every one on the wire shape."""
    from aiohttp.test_utils import TestClient, TestServer

    from plainsight_head.api import make_app

    c, seen = ctx_imu_ready, []
    unsubscribe = c.state.subscribe(lambda m: seen.append(m) if m["type"] == "event" else None)
    try:
        async with TestClient(TestServer(make_app(c))) as client:
            await client.post("/api/setpos", json={"pan": 5})              # pan_reference (host)
            await c.status_now()
            await c.ref.reference_from_imu(1.0)                            # pan_reference (imu)
            c.imu_fake.cal = (0, 0, 0, 0)
            await c.ref.reference_from_imu(0.1)                            # pan_reference_failed
            await client.post("/api/enable", json={"on": False})          # pan_reference (none)
            await client.post("/api/config", json={"scope": "pan", "key": "acc", "value": 9})
            await client.post("/api/estop")
            await client.post("/api/estop/clear")
            c.fake.emit_raw(b"*E homed tilt\n*E home_failed tilt aborted\n*E driver_fault pan drv_status=0x2\n")
            c.link._on_link(False)
            c.link._on_link(True)
            for _ in range(100):
                if sum(m["name"] == "driver_fault" for m in seen):
                    break
                await asyncio.sleep(0.01)
    finally:
        unsubscribe()
    names = [m["name"] for m in seen]
    for want in ("pan_reference", "pan_reference_failed", "config", "estop", "estop_cleared",
                 "homed", "home_failed", "driver_fault", "pico_link"):
        assert want in names, names
    schema = load("event.json")
    for msg in seen:
        jsonschema.validate(msg, schema)


def test_every_schema_is_a_valid_2020_12_schema():
    files = sorted(SCHEMAS.glob("*.json"))
    assert files
    for f in files:
        jsonschema.Draft202012Validator.check_schema(json.loads(f.read_text()))


def test_spec_examples_validate():
    found: dict[str, int] = {}
    for stem, body in FENCE.findall(DOC.read_text()):
        schema_file = SCHEMAS / f"{stem}.json"
        assert schema_file.exists(), f"example tagged with unknown schema {stem!r}"
        jsonschema.validate(json.loads(body), json.loads(schema_file.read_text()))
        found[stem] = found.get(stem, 0) + 1
    missing = sorted({p.stem for p in SCHEMAS.glob("*.json")} - set(found))
    assert not missing, f"schemas without a documented example: {missing}"
