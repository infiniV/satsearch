"""Ingestion (spec §7): XYZ-pyramid and plain-folder adapters + resumable job runner.

- XYZ pyramids hold every zoom; only `embedZoom` (default deepest) is embedded to avoid
  cross-zoom duplication. Shallower levels stay on disk for the Phase-2 basemap.
- Single-writer resumable shards; cancel flushes what's embedded and hot-loads the
  partial block so it is immediately searchable.
"""

from __future__ import annotations

import logging
import os
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Iterator, Optional

import numpy as np
import pandas as pd
from PIL import Image

from . import gpu, shards, tiles
from .jobs import Jobs
from .satimg_layout import GES_LAYOUT, parse_ges
from .siglip import Model
from .sources import Source
from .store import Store

log = logging.getLogger(__name__)

_IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
SHARD_ROWS = 16384
_PROGRESS_EVERY_S = 5.0  # throttle per-batch INFO progress lines
_DEFAULT_FLUSH_SECS = 30.0  # also commit a shard at least this often (tighter resume)


def _is_oom(e: BaseException) -> bool:
    """torch's CUDA OOM without importing torch (ingest stays torch-free on CPU)."""
    return type(e).__name__ == "OutOfMemoryError" or "out of memory" in str(e).lower()


def _empty_cuda_cache() -> None:
    try:  # pragma: no cover — needs torch/CUDA
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass


def _cuda_peak_gb() -> Optional[float]:
    try:  # pragma: no cover — needs torch/CUDA
        import torch
        if torch.cuda.is_available():
            return torch.cuda.max_memory_allocated() / 1e9
    except Exception:
        pass
    return None


def _prefetch(groups: Iterator[list], prepare: Callable[[list], object],
              num_workers: int, depth: int):
    """Yield (group, prepared) in order, preprocessing up to `depth` groups ahead.

    `prepare` (disk read + model.preprocess) runs in worker threads; PIL decode and the
    HF processor release the GIL, so this overlaps the caller's GPU forward. `groups` is
    pulled lazily, so a mid-run batch-size downgrade shrinks not-yet-pulled groups."""
    ex = ThreadPoolExecutor(max_workers=max(1, num_workers))
    q: deque = deque()

    def submit_next() -> bool:
        try:
            g = next(groups)
        except StopIteration:
            return False
        q.append((g, ex.submit(prepare, g)))
        return True

    try:
        for _ in range(max(1, depth)):
            if not submit_next():
                break
        while q:
            g, fut = q.popleft()
            yield g, fut.result()
            submit_next()
    finally:
        ex.shutdown(wait=False, cancel_futures=True)


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
        log.info("satimg-flat: skipped %d non-ges files under %s", skipped, root)
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
               emb_dir: str, job_id: str, batch_size: Optional[int] = None,
               kind: str = "ingest",
               on_downgrade: Optional[Callable[[int], None]] = None,
               throughput_path: Optional[str] = None, device: str = "cpu") -> None:
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

    # `state["bs"]` is the live batch size — the OOM safety net lowers it mid-run and it
    # shrinks not-yet-pulled groups. Falls back to a safe CPU default if unresolved.
    state = {"bs": int(batch_size) if batch_size else gpu.CPU_BATCH}
    num_workers = gpu.resolve_num_workers()
    prefetch_depth = gpu.resolve_prefetch()
    try:
        flush_secs = float(os.environ.get("SATSEARCH_FLUSH_SECS", "") or _DEFAULT_FLUSH_SECS)
    except ValueError:
        flush_secs = _DEFAULT_FLUSH_SECS

    log.info("%s start: source=%s total=%d resumed=%d remaining=%d batch=%d workers=%d",
             kind, source.id, total, already, len(remaining), state["bs"], num_workers)

    buf_emb: list[np.ndarray] = []
    buf_meta: list[tuple] = []
    shard_idx = next_idx
    done = already
    last_flush = time.monotonic()

    def flush() -> None:
        nonlocal shard_idx, buf_emb, buf_meta, last_flush
        if not buf_emb:
            return
        emb = np.concatenate(buf_emb, axis=0)
        shards.write_shard(emb_dir, shard_idx, emb, _meta_frame(buf_meta))
        shard_idx += 1
        buf_emb = []
        buf_meta = []
        last_flush = time.monotonic()

    def hot_load(job_state: str):
        flush()
        block = shards.load_block(emb_dir, source.id, source.fingerprint)
        snap_id = store.upsert_block(block) if block is not None else store.snapshot().snapshot_id
        jobs.update(job_id, state=job_state, done=done, snapshotId=snap_id)
        jobs.push_mutation(source.id, "import" if kind == "import" else "add", snap_id)
        log.info("%s %s: source=%s done=%d/%d snapshot=%s",
                 kind, job_state, source.id, done, total, snap_id)

    def load_pils(group: list):
        return [Image.open(os.path.join(source.rootPath, rel)).convert("RGB")
                for (_n, rel, *_rest) in group]

    def prepare(group: list):
        # runs in a worker thread: disk read + decode + CPU-side model preprocessing,
        # plus the per-tile stat — all off the GPU-driving thread.
        pils, stats = [], []
        for (_n, rel, *_rest) in group:
            full = os.path.join(source.rootPath, rel)
            pils.append(Image.open(full).convert("RGB"))
            st = os.stat(full)
            stats.append((int(st.st_mtime), int(st.st_size)))
        return model.preprocess(pils), stats

    def encode_chunked(group: list, chunk: int) -> np.ndarray:
        """Re-encode a group in sub-chunks after an OOM, shrinking until it fits."""
        outs = []
        for j in range(0, len(group), chunk):
            sub = group[j:j + chunk]
            try:
                outs.append(model.encode_prepared(model.preprocess(load_pils(sub))))
            except Exception as e:  # noqa: BLE001 — narrowed by _is_oom
                if _is_oom(e) and chunk > 1:
                    _empty_cuda_cache()
                    return encode_chunked(group, max(1, chunk // 2))
                raise
        return np.concatenate(outs, axis=0)

    def encode(group: list, prepared) -> np.ndarray:
        try:
            return model.encode_prepared(prepared)
        except Exception as e:  # noqa: BLE001 — narrowed by _is_oom
            if not _is_oom(e):
                raise
            _empty_cuda_cache()
            new_bs = max(1, len(group) // 2)
            if new_bs < state["bs"]:
                state["bs"] = new_bs
                log.warning("%s OOM at batch %d → downgrading to %d",
                            kind, len(group), new_bs)
                if on_downgrade is not None:
                    on_downgrade(new_bs)
            return encode_chunked(group, new_bs)

    def groups() -> Iterator[list]:
        i = 0
        while i < len(remaining):
            g = remaining[i:i + state["bs"]]  # reads the live (maybe downgraded) size
            i += len(g)
            yield g

    last_progress = time.monotonic()
    win_done, win_t0 = 0, time.monotonic()
    run_t0, embedded0 = time.monotonic(), done  # for learned-throughput on completion
    pump = _prefetch(groups(), prepare, num_workers, prefetch_depth)
    try:
        for group, (prepared, stats) in pump:
            vecs = encode(group, prepared).astype(np.float16)
            buf_emb.append(vecs)
            for (name, rel, x, y, z), (mtime, size) in zip(group, stats):
                buf_meta.append((name, rel, x, y, z, mtime, size))
            done += len(group)
            win_done += len(group)

            now = time.monotonic()
            if now - last_progress >= _PROGRESS_EVERY_S:
                tps = win_done / (now - win_t0) if now > win_t0 else 0.0
                jobs.update(job_id, done=done, current=group[-1][1], tilesPerSec=round(tps, 1))
                log.info("%s progress: source=%s done=%d/%d %.0f tiles/s",
                         kind, source.id, done, total, tps)
                last_progress, win_done, win_t0 = now, 0, now
            else:
                jobs.update(job_id, done=done, current=group[-1][1])

            if sum(len(b) for b in buf_emb) >= SHARD_ROWS or \
                    (buf_emb and now - last_flush >= flush_secs):
                flush()
            if jobs.is_cancelled(job_id):
                hot_load("cancelled")
                return
    finally:
        pump.close()

    flush()
    open(os.path.join(emb_dir, "_done"), "w").close()
    peak = _cuda_peak_gb()
    if peak is not None:
        log.info("%s done: source=%s peak VRAM %.2f GiB", kind, source.id, peak)
    # Persist average throughput (this run's embedded tiles / wall time) so the next
    # import's time estimate is measured rather than heuristic. Skipped on resumes that
    # embedded nothing, or when no path was supplied (tests).
    if throughput_path:
        elapsed = time.monotonic() - run_t0
        embedded = done - embedded0
        if embedded > 0 and elapsed > 0:
            from . import preview
            preview.record_throughput(throughput_path, device, embedded / elapsed)
    hot_load("done")
