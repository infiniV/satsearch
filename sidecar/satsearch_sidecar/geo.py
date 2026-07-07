"""Result geolocation + basemap tile resolution (spec §9).

Sits on tiles.py. `latlon_for` places a search result on the map; `resolve_basemap`
selects the native-or-ancestor tile file + crop rect for a requested basemap tile.
"""

from __future__ import annotations

import os

from . import tiles
from .satimg_layout import GES_RE
from .sources import Source, TileLayout


def latlon_for(source: Source, name: str):
    """Return (lat, lon, x, y, z) map coords for a result, or None if no geo."""
    if not source.hasGeo:
        return None
    if source.kind == "xyz":
        try:
            z, x, y = (int(p) for p in name.split("/"))
        except ValueError:
            return None
        lat, lon = tiles.tile_center_latlon(source.projection, z, x, y)
        return lat, lon, x, y, z
    if source.kind == "satimg-import" and source.tileLayout is not None:
        m = GES_RE.search(name)
        if not m:
            return None
        xfile, yfile, zfile = int(m.group(1)), int(m.group(2)), int(m.group(3))
        z, x, y = tiles.xyz_from_filename(source.tileLayout, "geodetic", xfile, yfile, zfile)
        lat, lon = tiles.tile_center_latlon("geodetic", z, x, y)
        return lat, lon, x, y, z
    return None


def _candidate_path(source: Source, z: int, x: int, y: int) -> str | None:
    layout = source.tileLayout or TileLayout(template="{z}/{x}/{y}.{ext}", ext="jpg")
    fname = tiles.filename_for(layout, source.projection, z, x, y)
    path = os.path.join(source.rootPath, fname)
    if os.path.exists(path):
        return path
    # tolerate jpg/png ext mismatch for xyz sources
    for alt in ("jpg", "jpeg", "png", "webp"):
        if alt == layout.ext:
            continue
        alt_layout = layout.model_copy(update={"ext": alt})
        p = os.path.join(source.rootPath, tiles.filename_for(alt_layout, source.projection, z, x, y))
        if os.path.exists(p):
            return p
    return None


def resolve_basemap(z: int, x: int, y: int, sources: list[Source]):
    """Return {'file': path, 'crop': (l,t,size)|None} for a web-mercator basemap tile,
    or None. Highest native-resolution source wins on overlap."""
    geo = [s for s in sources if s.projection == "web-mercator" and s.maxZoom is not None]
    for src in sorted(geo, key=lambda s: (s.maxZoom or 0), reverse=True):
        mn, mx = (src.minZoom or 0), (src.maxZoom or 0)
        if z < mn:
            continue
        if mn <= z <= mx:
            p = _candidate_path(src, z, x, y)
            if p:
                return {"file": p, "crop": None}
        elif z > mx:
            nz, ax, ay, crop = tiles.over_zoom_ancestor(z, x, y, mx)
            p = _candidate_path(src, nz, ax, ay)
            if p:
                return {"file": p, "crop": list(crop)}
    return None
