import math

import pytest

from satsearch_sidecar import tiles
from satsearch_sidecar.sources import TileLayout


def test_mercator_center_z0_is_origin():
    lat, lon = tiles.tile_center_latlon("web-mercator", 0, 0, 0)
    assert lon == pytest.approx(0.0, abs=1e-9)
    assert lat == pytest.approx(0.0, abs=1e-6)


def test_mercator_z1_quadrants():
    # top-left tile (0,0) center is in the NW quadrant
    lat, lon = tiles.tile_center_latlon("web-mercator", 1, 0, 0)
    assert lon == pytest.approx(-90.0, abs=1e-6)
    assert lat > 0  # northern hemisphere
    # bottom-right tile (1,1)
    lat2, lon2 = tiles.tile_center_latlon("web-mercator", 1, 1, 1)
    assert lon2 == pytest.approx(90.0, abs=1e-6)
    assert lat2 < 0


def test_geodetic_dimensions_and_center():
    # EPSG:4326 WMTS: cols = 2^(z+1), rows = 2^z
    assert tiles.grid_cols("geodetic", 2) == 8
    assert tiles.grid_rows("geodetic", 2) == 4
    assert tiles.grid_cols("web-mercator", 2) == 4
    assert tiles.grid_rows("web-mercator", 2) == 4
    # geodetic z0: 2 cols x 1 row spanning [-180,180]x[-90,90]
    lat, lon = tiles.tile_center_latlon("geodetic", 0, 0, 0)
    assert lon == pytest.approx(-90.0)   # left tile center
    assert lat == pytest.approx(0.0)     # single row center


def test_over_zoom_ancestor_and_crop():
    # request z=20 tile from a native z=18 source (2 levels up)
    nz, nx, ny, crop = tiles.over_zoom_ancestor(20, 5, 7, native_z=18)
    assert (nz, nx, ny) == (18, 5 >> 2, 7 >> 2)
    left, top, size = crop
    assert size == 256 // 4  # 64px sub-tile of a 256 tile
    # the sub-tile offset within the ancestor
    assert left == (5 - ((5 >> 2) << 2)) * 64
    assert top == (7 - ((7 >> 2) << 2)) * 64


def test_filename_roundtrip_satimg_layout():
    layout = TileLayout(template="ges_{x}_{y}_{zfile}.jpg", ext="jpg", zOffset=1, yScheme="tms")
    # map tile (z=19, x=3, y=4) in a geodetic source
    fname = tiles.filename_for(layout, "geodetic", 19, 3, 4)
    yfile = tiles.grid_rows("geodetic", 19) - 1 - 4
    assert fname == f"ges_3_{yfile}_20.jpg"
    # inverse: filename coords back to map xyz
    z, x, y = tiles.xyz_from_filename(layout, "geodetic", 3, yfile, 20)
    assert (z, x, y) == (19, 3, 4)


def test_filename_standard_xyz():
    layout = TileLayout(template="{z}/{x}/{y}.{ext}", ext="png", zOffset=0, yScheme="xyz")
    assert tiles.filename_for(layout, "web-mercator", 12, 100, 200) == "12/100/200.png"
