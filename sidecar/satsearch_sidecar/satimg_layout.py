"""satImg's flat `ges_*` tile layout — the ONE place the satImg quirk lives as data.

satImg names each tile `ges_{xfile}_{yfile}_{zfile}.jpg`, geodetic (EPSG:4326),
with the filename zoom one deeper than the map zoom (`zOffset=1`) and a TMS y axis.
Kept declarative here so `tiles.py` stays generic (main spec §9).
"""
from __future__ import annotations

import re

from .sources import TileLayout

GES_RE = re.compile(r"ges_(\d+)_(\d+)_(\d+)\.\w+$")
GES_LAYOUT = TileLayout(template="ges_{x}_{y}_{zfile}.jpg", ext="jpg",
                        zOffset=1, yScheme="tms")


def parse_ges(name: str) -> tuple[int, int, int] | None:
    """Return (xfile, yfile, zfile) from a `ges_*` filename, or None if it is not one."""
    m = GES_RE.search(name)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None
