from plainsight_head.persist import JsonStore


def test_roundtrip_and_missing(tmp_path):
    s = JsonStore(str(tmp_path / "data"))
    assert s.read("x") is None
    s.write("x", {"a": 1}); assert s.read("x") == {"a": 1}
    assert not list(tmp_path.glob("data/*.tmp"))


def test_corrupt_file_reads_as_none(tmp_path):
    (tmp_path / "x.json").write_text("{nope"); assert JsonStore(str(tmp_path)).read("x") is None


def test_write_fsyncs_the_data_before_the_rename(tmp_path, monkeypatch):
    import os

    calls = []
    real_fsync, real_replace = os.fsync, os.replace

    def fsync(fd):
        calls.append(("fsync", os.fstat(fd).st_size))
        real_fsync(fd)

    def replace(src, dst):
        calls.append(("replace", os.path.basename(dst)))
        real_replace(src, dst)

    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "replace", replace)
    JsonStore(str(tmp_path)).write("x.json", {"a": 1})
    assert calls == [("fsync", len('{"a": 1}')), ("replace", "x.json")]
