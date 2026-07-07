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
    # satImg ges tiles are web-mercator (Google Maps tiles): z-suffix = map zoom + 1,
    # TMS y axis. Real Kathmandu tile ges_386283_302368_20 must land near ~85E, ~27N —
    # inside the valid mercator range and the eastern/northern hemisphere.
    s = Source(id="s", label="s", kind="satimg-import", rootPath="/c", hasGeo=True,
               projection="web-mercator", minZoom=19, maxZoom=19,
               tileLayout=TileLayout(template="ges_{x}_{y}_{zfile}.jpg", ext="jpg",
                                     zOffset=1, yScheme="tms"), fingerprint="fp")
    out = geo.latlon_for(s, "ges_386283_302368_20.jpg")
    assert out is not None
    lat, lon, x, _y, z = out
    assert x == 386283 and z == 19
    assert 84.0 < lon < 87.0 and 25.0 < lat < 29.0  # Kathmandu region, north of equator


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


def test_resolve_basemap_under_zoom_composites_descendants(tmp_path):
    # a single-zoom source (native z12) requested at z10 stitches its 4x4 native
    # descendants (2 levels down) into one 256px tile via a composite spec
    root = tmp_path / "pyr"
    x0, y0 = 100 << 2, 200 << 2  # z12 descendants of z10 tile (100,200)
    for dx in range(4):
        for dy in range(4):
            d = root / "12" / str(x0 + dx)
            d.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (256, 256)).save(d / f"{y0 + dy}.jpg")
    s = _xyz_source(str(root), 12, 12)  # minZoom==maxZoom==12 (no pyramid)
    r = geo.resolve_basemap(10, 100, 200, [s])
    assert r is not None and r["file"] is None
    comp = r["composite"]
    assert len(comp) == 16  # 4x4 native tiles
    sizes = {tuple(p["dst"]) for p in comp}
    assert (0, 0, 64) in sizes and (192, 192, 64) in sizes  # 256/4 = 64px sub-tiles


def test_resolve_basemap_under_zoom_too_far_returns_none(tmp_path):
    # 4 levels down exceeds UNDERZOOM_MAX_LEVELS (3) -> no basemap (markers only)
    root = tmp_path / "pyr"
    d = root / "12" / "1600"
    d.mkdir(parents=True)
    Image.new("RGB", (256, 256)).save(d / "3200.jpg")
    s = _xyz_source(str(root), 12, 12)
    assert geo.resolve_basemap(8, 100, 200, [s]) is None
