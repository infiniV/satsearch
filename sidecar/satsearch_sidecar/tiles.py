"""Per-projection tile ↔ lat/lon math + over-zoom ancestor crop (spec §9).

All coordinate/tile-index math lives here (single source of truth). The satImg
geodetic / z-offset / TMS quirk is applied generically from a Source's declarative
`TileLayout`, never as source-specific code.

- web-mercator (EPSG:3857): grid is 2^z × 2^z; standard slippy inverse.
- geodetic (EPSG:4326 WMTS): grid is 2^(z+1) cols × 2^z rows over [-180,180]×[-90,90].
"""

from __future__ import annotations

import math

from .sources import TileLayout

TILE_PX = 256


def grid_cols(projection: str, z: int) -> int:
    return (2 ** (z + 1)) if projection == "geodetic" else (2 ** z)


def grid_rows(projection: str, z: int) -> int:
    return 2 ** z


def tile_center_latlon(projection: str, z: int, x: int, y: int) -> tuple[float, float]:
    """Center (lat, lon) of tile (z,x,y) in the given projection."""
    if projection == "geodetic":
        cols = grid_cols("geodetic", z)
        rows = grid_rows("geodetic", z)
        lon = (x + 0.5) / cols * 360.0 - 180.0
        lat = 90.0 - (y + 0.5) / rows * 180.0
        return lat, lon
    # web-mercator
    n = 2.0 ** z
    lon = (x + 0.5) / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) / n))))
    return lat, lon


def over_zoom_ancestor(z: int, x: int, y: int, native_z: int) -> tuple[int, int, int, tuple[int, int, int]]:
    """For a request deeper than native_z, return (native_z, ax, ay, (left, top, size))
    where (left, top, size) is the sub-tile crop rect inside the 256px ancestor tile."""
    shift = z - native_z
    if shift <= 0:
        return z, x, y, (0, 0, TILE_PX)
    ax, ay = x >> shift, y >> shift
    scale = 1 << shift
    size = TILE_PX // scale
    left = (x - (ax << shift)) * size
    top = (y - (ay << shift)) * size
    return native_z, ax, ay, (left, top, size)


def filename_for(layout: TileLayout, projection: str, z: int, x: int, y: int) -> str:
    """Build the on-disk filename for a map tile (z,x,y) via the source's TileLayout."""
    zfile = z + layout.zOffset
    yfile = (grid_rows(projection, z) - 1 - y) if layout.yScheme == "tms" else y
    return layout.template.format(x=x, y=yfile, z=z, zfile=zfile, ext=layout.ext)


def xyz_from_filename(layout: TileLayout, projection: str, xfile: int, yfile: int, zfile: int) -> tuple[int, int, int]:
    """Inverse of filename_for: on-disk coords -> map (z, x, y)."""
    z = zfile - layout.zOffset
    y = (grid_rows(projection, z) - 1 - yfile) if layout.yScheme == "tms" else yfile
    return z, xfile, y
