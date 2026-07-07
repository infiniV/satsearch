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
        z, x, y = tiles.xyz_from_filename(source.tileLayout, source.projection, xfile, yfile, zfile)
        lat, lon = tiles.tile_center_latlon(source.projection, z, x, y)
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


# Cap under-zoom compositing at 2^N × 2^N native tiles per basemap tile. A single-zoom
# source (e.g. a satImg city: only native tiles, no pyramid) would otherwise need to
# stitch the entire corpus to fill one far-overview tile. 3 levels = up to 64 native
# reads per tile — bounded and cacheable; beyond that we serve nothing (markers only).
UNDERZOOM_MAX_LEVELS = 3


def _under_zoom_composite(src: Source, z: int, x: int, y: int, native_z: int):
    """Native descendant tiles + dst rects to downscale-composite into one 256px tile,
    for a basemap request shallower than the source's only zoom. None if too far out
    (would exceed the level cap) or no descendant exists."""
    d = native_z - z
    if d <= 0 or d > UNDERZOOM_MAX_LEVELS:
        return None
    span = 1 << d
    sub = tiles.TILE_PX // span
    x0, y0 = x << d, y << d
    parts = []
    for dy in range(span):
        for dx in range(span):
            p = _candidate_path(src, native_z, x0 + dx, y0 + dy)
            if p:
                parts.append({"file": p, "dst": [dx * sub, dy * sub, sub]})
    return parts or None


def resolve_basemap(z: int, x: int, y: int, sources: list[Source]):
    """Return {'file': path, 'crop': (l,t,size)|None} for a native/over-zoom basemap
    tile, or {'file': None, 'crop': None, 'composite': [...]} for an under-zoom stitch,
    or None. Highest native-resolution web-mercator source wins on overlap."""
    geo = [s for s in sources if s.projection == "web-mercator" and s.maxZoom is not None]
    for src in sorted(geo, key=lambda s: (s.maxZoom or 0), reverse=True):
        mn, mx = (src.minZoom or 0), (src.maxZoom or 0)
        if mn <= z <= mx:
            p = _candidate_path(src, z, x, y)
            if p:
                return {"file": p, "crop": None}
        elif z > mx:
            nz, ax, ay, crop = tiles.over_zoom_ancestor(z, x, y, mx)
            p = _candidate_path(src, nz, ax, ay)
            if p:
                return {"file": p, "crop": list(crop)}
        else:  # z < mn: no lower-zoom tiles on disk — stitch native descendants
            comp = _under_zoom_composite(src, z, x, y, mn)
            if comp:
                return {"file": None, "crop": None, "composite": comp}
    return None
