from plainsight_head.persist import JsonStore


def test_roundtrip_and_missing(tmp_path):
    s = JsonStore(str(tmp_path / "data"))
    assert s.read("x") is None
    s.write("x", {"a": 1}); assert s.read("x") == {"a": 1}
    assert not list(tmp_path.glob("data/*.tmp"))


def test_corrupt_file_reads_as_none(tmp_path):
    (tmp_path / "x.json").write_text("{nope"); assert JsonStore(str(tmp_path)).read("x") is None
