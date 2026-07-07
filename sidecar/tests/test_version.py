from satsearch_sidecar.version import compute_version


def test_deterministic(tmp_path):
    (tmp_path / "a.py").write_text("x = 1\n")
    (tmp_path / "b.py").write_text("y = 2\n")
    assert compute_version(str(tmp_path)) == compute_version(str(tmp_path))
    assert len(compute_version(str(tmp_path))) == 16


def test_changes_when_source_changes(tmp_path):
    (tmp_path / "a.py").write_text("x = 1\n")
    v1 = compute_version(str(tmp_path))
    (tmp_path / "a.py").write_text("x = 2\n")
    v2 = compute_version(str(tmp_path))
    assert v1 != v2


def test_real_package_version_stable():
    from satsearch_sidecar.version import compute_version as cv
    assert cv() == cv()
