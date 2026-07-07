from satsearch_sidecar.sources import Source, SourceRegistry


def _src(**kw):
    base = dict(id="s1", label="City A", kind="xyz", rootPath="/data/a",
                tileCount=10, hasGeo=True, projection="web-mercator",
                fingerprint="fp", availability="available", active=True, rev=0)
    base.update(kw)
    return Source(**base)


def test_add_get_delete_roundtrip(tmp_path):
    reg = SourceRegistry(str(tmp_path / "sources.json"))
    reg.add(_src())
    assert reg.get("s1").label == "City A"
    # persisted + reloadable
    reg2 = SourceRegistry(str(tmp_path / "sources.json"))
    assert reg2.get("s1").tileCount == 10
    reg2.delete("s1")
    assert reg2.get("s1") is None
    reg3 = SourceRegistry(str(tmp_path / "sources.json"))
    assert reg3.list() == []


def test_bump_rev(tmp_path):
    reg = SourceRegistry(str(tmp_path / "sources.json"))
    reg.add(_src(rev=0))
    reg.bump_rev("s1")
    assert reg.get("s1").rev == 1
    reg.bump_rev("s1")
    assert reg.get("s1").rev == 2


def test_plain_source_no_geo(tmp_path):
    reg = SourceRegistry(str(tmp_path / "sources.json"))
    reg.add(_src(id="p", kind="plain", hasGeo=False, projection="none"))
    s = reg.get("p")
    assert s.hasGeo is False and s.projection == "none"
