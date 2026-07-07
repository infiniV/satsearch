"""Resilience ops (spec §14 Phase 4): availability, relink, reconcile.

- availability: mark a source unavailable when its rootPath is gone (moved/unmounted).
- reconcile: detect tiles added / removed / edited-in-place (edit via (mtime,size)).
"""

from __future__ import annotations

import glob
import os

import pandas as pd

from . import ingest as ingest_mod
from .sources import Source, SourceRegistry


def check_availability(registry: SourceRegistry) -> list[str]:
    """Refresh availability from disk; return ids whose availability changed."""
    changed = []
    for s in registry.list():
        present = os.path.isdir(s.rootPath)
        if present and s.availability == "unavailable":
            registry.set_availability(s.id, "available")
            changed.append(s.id)
        elif not present and s.availability == "available":
            registry.set_availability(s.id, "unavailable")
            changed.append(s.id)
    return changed


def _stored_meta(emb_dir: str) -> dict[str, tuple[int, int]]:
    """name -> (mtime, size) from a source's shard metas."""
    out: dict[str, tuple[int, int]] = {}
    for pq in sorted(glob.glob(os.path.join(emb_dir, "meta_*.parquet"))):
        df = pd.read_parquet(pq)
        cols = df.columns
        for _, row in df.iterrows():
            mtime = int(row["mtime"]) if "mtime" in cols else 0
            size = int(row["size"]) if "size" in cols else 0
            out[row["name"]] = (mtime, size)
    return out


def reconcile_diff(source: Source, emb_dir: str) -> dict:
    """Compare on-disk tiles to the stored index. Returns added/removed/changed."""
    rows, _zoom = ingest_mod._rows_for_source(source)
    current: dict[str, tuple[int, int]] = {}
    for (name, rel, _x, _y, _z) in rows:
        try:
            st = os.stat(os.path.join(source.rootPath, rel))
            current[name] = (int(st.st_mtime), int(st.st_size))
        except OSError:
            continue

    stored = _stored_meta(emb_dir)
    added = [n for n in current if n not in stored]
    removed = [n for n in stored if n not in current]
    changed = [n for n in current if n in stored and current[n] != stored[n]]
    return {
        "added": added,
        "removed": removed,
        "changed": changed,
        "counts": {"added": len(added), "removed": len(removed), "changed": len(changed)},
    }
