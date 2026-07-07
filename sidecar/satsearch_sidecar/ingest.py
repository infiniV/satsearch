"""Ingestion (spec §7): XYZ-pyramid and plain-folder adapters + resumable job runner.

- XYZ pyramids hold every zoom; only `embedZoom` (default deepest) is embedded to avoid
  cross-zoom duplication. Shallower levels stay on disk for the Phase-2 basemap.
- Single-writer resumable shards; cancel flushes what's embedded and hot-loads the
  partial block so it is immediately searchable.
"""

from __future__ import annotations

import os

import numpy as np
import pandas as pd
from PIL import Image

from . import shards, tiles
from .jobs import Jobs
from .satimg_layout import GES_LAYOUT, parse_ges
from .siglip import Model
from .sources import Source
from .store import Store

_IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
SHARD_ROWS = 16384


def enumerate_xyz(root: str) -> list[tuple[str, str, int, int, int]]:
    """Return (name, rel_path, z, x, y) for every {z}/{x}/{y}.ext tile."""
    out: list[tuple[str, str, int, int, int]] = []
    for z_name in os.listdir(root):
        z_dir = os.path.join(root, z_name)
        if not (os.path.isdir(z_dir) and z_name.isdigit()):
            continue
        z = int(z_name)
        for x_name in os.listdir(z_dir):
            x_dir = os.path.join(z_dir, x_name)
            if not (os.path.isdir(x_dir) and x_name.isdigit()):
                continue
            x = int(x_name)
            for fname in os.listdir(x_dir):
                stem, ext = os.path.splitext(fname)
                if ext.lower() not in _IMG_EXTS or not stem.isdigit():
                    continue
                y = int(stem)
                out.append((f"{z}/{x}/{y}", f"{z}/{x}/{fname}", z, x, y))
    return sorted(out, key=lambda e: e[1])


def pick_embed_zoom(entries) -> int:
    return max(z for (_n, _p, z, _x, _y) in entries)


def filter_zoom(entries, zoom: int):
    return [e for e in entries if e[2] == zoom]


def enumerate_plain(root: str) -> list[tuple[str, str]]:
    """Return (name, rel_path) for every image under root (recursive)."""
    out: list[tuple[str, str]] = []
    for dirpath, _dirs, files in os.walk(root):
        for fname in files:
            if os.path.splitext(fname)[1].lower() not in _IMG_EXTS:
                continue
            full = os.path.join(dirpath, fname)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out.append((rel, rel))
    return sorted(out, key=lambda e: e[1])


def enumerate_satimg_flat(root: str) -> list[tuple[str, str, int, int, int]]:
    """Return (name, rel_path, x, y, z) for every `ges_*.jpg` directly under `root`.

    satImg flattens all tiles into `city/<name>/`, so this is a non-recursive scan.
    name == rel_path == the ges filename; (z, x, y) are MAP coords from the ges filename
    via the declarative GES_LAYOUT. Non-ges files are skipped (count logged, not fatal).
    """
    out: list[tuple[str, str, int, int, int]] = []
    skipped = 0
    for fname in os.listdir(root):
        parsed = parse_ges(fname)
        if parsed is None:
            skipped += 1
            continue
        xfile, yfile, zfile = parsed
        z, x, y = tiles.xyz_from_filename(GES_LAYOUT, "geodetic", xfile, yfile, zfile)
        out.append((fname, fname, x, y, z))
    if skipped:
        print(f"[ingest] satimg-flat: skipped {skipped} non-ges files under {root}")
    return sorted(out, key=lambda e: e[1])


def _rows_for_source(source: Source):
    """Return (rows, embed_zoom) where rows = [(name, rel_path, x, y, z)] with
    x/y/z None for plain sources."""
    if source.kind == "plain":
        return [(n, p, None, None, None) for (n, p) in enumerate_plain(source.rootPath)], None
    if source.kind == "satimg-import":
        return enumerate_satimg_flat(source.rootPath), None
    entries = enumerate_xyz(source.rootPath)
    embed_zoom = source.embedZoom or (pick_embed_zoom(entries) if entries else 0)
    rows = [(n, p, x, y, z) for (n, p, z, x, y) in filter_zoom(entries, embed_zoom)]
    return rows, embed_zoom


def _meta_frame(batch_rows):
    names, rels, xs, ys, zs, mtimes, sizes = [], [], [], [], [], [], []
    for (name, rel, x, y, z, mtime, size) in batch_rows:
        names.append(name); rels.append(rel); xs.append(x); ys.append(y); zs.append(z)
        mtimes.append(mtime); sizes.append(size)
    return pd.DataFrame({"name": names, "rel_path": rels, "x": xs, "y": ys, "z": zs,
                         "mtime": mtimes, "size": sizes})


def run_ingest(source: Source, model: Model, store: Store, jobs: Jobs,
               emb_dir: str, job_id: str, batch_size: int = 32,
               kind: str = "ingest") -> None:
    rows, _embed_zoom = _rows_for_source(source)
    total = len(rows)
    os.makedirs(emb_dir, exist_ok=True)
    done_names, next_idx = shards.scan_complete(emb_dir)
    remaining = [r for r in rows if r[0] not in done_names]
    already = total - len(remaining)

    if jobs.get(job_id) is None:
        jobs.create(job_id, source.id, kind, total=total, resumed=already > 0)
    else:
        jobs.update(job_id, total=total, resumed=already > 0)
    jobs.update(job_id, done=already)

    buf_emb: list[np.ndarray] = []
    buf_meta: list[tuple] = []
    shard_idx = next_idx
    done = already

    def flush() -> None:
        nonlocal shard_idx, buf_emb, buf_meta
        if not buf_emb:
            return
        emb = np.concatenate(buf_emb, axis=0)
        shards.write_shard(emb_dir, shard_idx, emb, _meta_frame(buf_meta))
        shard_idx += 1
        buf_emb = []
        buf_meta = []

    def hot_load(state: str, snapshot_after: bool = True):
        flush()
        block = shards.load_block(emb_dir, source.id, source.fingerprint)
        snap_id = store.upsert_block(block) if block is not None else store.snapshot().snapshot_id
        jobs.update(job_id, state=state, done=done, snapshotId=snap_id)
        jobs.push_mutation(source.id, "import" if kind == "import" else "add", snap_id)

    for i in range(0, len(remaining), batch_size):
        batch = remaining[i:i + batch_size]
        pils = [Image.open(os.path.join(source.rootPath, rel)).convert("RGB")
                for (_n, rel, _x, _y, _z) in batch]
        vecs = model.encode_images(pils).astype(np.float16)
        buf_emb.append(vecs)
        for (name, rel, x, y, z) in batch:
            full = os.path.join(source.rootPath, rel)
            st = os.stat(full)
            buf_meta.append((name, rel, x, y, z, int(st.st_mtime), int(st.st_size)))
        done += len(batch)
        jobs.update(job_id, done=done)
        if sum(len(b) for b in buf_emb) >= SHARD_ROWS:
            flush()
        if jobs.is_cancelled(job_id):
            hot_load("cancelled")
            return

    flush()
    open(os.path.join(emb_dir, "_done"), "w").close()
    hot_load("done")
