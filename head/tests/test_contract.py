"""The API document and its JSON Schemas stay true to what the head emits and accepts."""
import json
import pathlib
import re

import jsonschema

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
