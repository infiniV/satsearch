import os

from PIL import Image

from satsearch_sidecar import geo
from satsearch_sidecar.sources import Source, TileLayout


def _xyz_source(root, minz, maxz, ext="jpg"):
    return Source(id="s", label="s", kind="xyz", rootPath=root, hasGeo=True,
                  projection="web-mercator", minZoom=minz, maxZoom=maxz,
                  tileLayout=TileLayout(template="{z}/{x}/{y}.{ext}", ext=ext, zOffset=0,
                                        yScheme="xyz"), fingerprint="fp")


def test_latlon_for_xyz():
    s = _xyz_source("/x", 0, 18)
    out = geo.latlon_for(s, "1/0/0")
    assert out is not None
    lat, lon, x, y, z = out
    assert (x, y, z) == (0, 0, 1)
    assert lon < 0 and lat > 0  # NW quadrant


def test_latlon_for_satimg():
    s = Source(id="s", label="s", kind="satimg-import", rootPath="/c", hasGeo=True,
               projection="geodetic", minZoom=19, maxZoom=19,
               tileLayout=TileLayout(template="ges_{x}_{y}_{zfile}.jpg", ext="jpg",
                                     zOffset=1, yScheme="tms"), fingerprint="fp")
    out = geo.latlon_for(s, "ges_3_100_20.jpg")
    assert out is not None
    _lat, _lon, x, _y, z = out
    assert x == 3 and z == 19


def test_resolve_basemap_native(tmp_path):
    root = tmp_path / "pyr"
    d = root / "12" / "100"
    d.mkdir(parents=True)
    Image.new("RGB", (256, 256)).save(d / "200.jpg")
    s = _xyz_source(str(root), 0, 12)
    r = geo.resolve_basemap(12, 100, 200, [s])
    assert r is not None and r["crop"] is None
    assert r["file"].endswith("12/100/200.jpg")


def test_resolve_basemap_over_zoom_crop(tmp_path):
    root = tmp_path / "pyr"
    d = root / "12" / "25"
    d.mkdir(parents=True)
    Image.new("RGB", (256, 256)).save(d / "50.jpg")  # native z12 ancestor of z14 (100,200)
    s = _xyz_source(str(root), 0, 12)
    r = geo.resolve_basemap(14, 100, 200, [s])
    assert r is not None
    assert r["crop"] is not None
    left, top, size = r["crop"]
    assert size == 64  # 256 / 2^2


def test_resolve_basemap_missing_returns_none(tmp_path):
    s = _xyz_source(str(tmp_path), 0, 12)
    assert geo.resolve_basemap(12, 1, 1, [s]) is None
