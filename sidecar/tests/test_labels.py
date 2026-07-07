import os

import pytest

from satsearch_sidecar.labels import LabelStore


def _store(tmp_path):
    return LabelStore(str(tmp_path / "labels"))


def test_add_class_and_counts(tmp_path):
    s = _store(tmp_path)
    s.add_class("kiln")
    classes = {c["name"]: c["count"] for c in s.classes_with_counts()}
    assert classes == {"kiln": 0}


def test_set_and_state(tmp_path):
    s = _store(tmp_path)
    s.add_class("kiln")
    s.set_label("srcA", "19/1/2", "kiln", "2026-07-07T00:00:00Z", {"score": 0.9})
    assert s.state_for([("srcA", "19/1/2"), ("srcA", "9/9/9")]) == {"srcA\x0019/1/2": "kiln"}
    assert {c["name"]: c["count"] for c in s.classes_with_counts()}["kiln"] == 1


def test_label_is_source_scoped(tmp_path):
    s = _store(tmp_path)
    # same tile name in two sources must be independent
    s.set_label("A", "5/1/2", "kiln", "t")
    s.set_label("B", "5/1/2", "tank", "t")
    st = s.state_for([("A", "5/1/2"), ("B", "5/1/2")])
    assert st == {"A\x005/1/2": "kiln", "B\x005/1/2": "tank"}


def test_delete_label(tmp_path):
    s = _store(tmp_path)
    s.set_label("A", "t1", "kiln", "t")
    assert s.del_label("A", "t1", "t") is True
    assert s.state_for([("A", "t1")]) == {}


def test_persistence_replays_ledger(tmp_path):
    s = _store(tmp_path)
    s.set_label("A", "t1", "kiln", "t")
    s.del_label("A", "t1", "t")
    s.set_label("A", "t2", "tank", "t")
    s2 = LabelStore(str(tmp_path / "labels"))
    assert s2.state_for([("A", "t1"), ("A", "t2")]) == {"A\x00t2": "tank"}


def test_delete_class_requires_empty(tmp_path):
    s = _store(tmp_path)
    s.set_label("A", "t1", "kiln", "t")
    with pytest.raises(ValueError):
        s.delete_class("kiln")
    s.del_label("A", "t1", "t")
    s.delete_class("kiln")  # now empty → ok


def test_export_materializes_goldset(tmp_path):
    s = _store(tmp_path)
    # two labeled tiles
    src = tmp_path / "imgs"
    src.mkdir()
    (src / "a.jpg").write_bytes(b"img-a")
    (src / "b.jpg").write_bytes(b"img-b")
    s.set_label("A", "a.jpg", "kiln", "t")
    s.set_label("A", "b.jpg", "tank", "t")

    def resolver(source_id, tile):
        return str(src / tile) if source_id == "A" else None

    dest = str(tmp_path / "export")
    result = s.export(dest, resolver)
    assert result["count"] == 2
    assert os.path.exists(os.path.join(dest, "kiln"))
    assert os.path.exists(os.path.join(dest, "tank"))
    assert os.path.exists(os.path.join(dest, "manifest.jsonl"))
    # a labeled file was copied
    kiln_files = os.listdir(os.path.join(dest, "kiln"))
    assert len(kiln_files) == 1
