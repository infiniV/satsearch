"""Resumable shard I/O (spec §7).

A shard is complete iff both emb_NNNN.npy and meta_NNNN.parquet exist. Durable commit
order guards power loss: write+fsync the .npy, then write+fsync the .parquet (the commit
marker), then fsync the directory. Resume additionally cross-checks rowcount(emb) ==
rowcount(meta) and discards mismatches.
"""

from __future__ import annotations

import glob
import os
import re

import numpy as np
import pandas as pd

from .store import Block

_EMB_RE = re.compile(r"emb_(\d+)\.npy$")


def _fsync_path(path: str) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_shard(dirpath: str, idx: int, emb: np.ndarray, meta: pd.DataFrame) -> None:
    os.makedirs(dirpath, exist_ok=True)
    emb_path = os.path.join(dirpath, f"emb_{idx:04d}.npy")
    meta_path = os.path.join(dirpath, f"meta_{idx:04d}.parquet")
    # 1) emb.npy -> fsync
    np.save(emb_path, emb.astype(np.float16))
    _fsync_path(emb_path)
    # 2) meta.parquet (commit marker, written last) -> fsync
    meta.to_parquet(meta_path)
    _fsync_path(meta_path)
    # 3) directory entry durability
    _fsync_path(dirpath)


def scan_complete(dirpath: str) -> tuple[set[str], int]:
    """Return (names already embedded in complete shards, next shard index)."""
    done: set[str] = set()
    indices: list[int] = []
    for emb_path in glob.glob(os.path.join(dirpath, "emb_*.npy")):
        m = _EMB_RE.search(os.path.basename(emb_path))
        if not m:
            continue
        idx = int(m.group(1))
        meta_path = os.path.join(dirpath, f"meta_{idx:04d}.parquet")
        if not os.path.exists(meta_path):
            continue  # crashed half-write: emb without commit marker
        try:
            names = pd.read_parquet(meta_path, columns=["name"])["name"].tolist()
            emb_rows = int(np.load(emb_path, mmap_mode="r").shape[0])
        except Exception:
            continue
        if emb_rows != len(names):
            continue  # torn shard: rowcount mismatch
        done.update(names)
        indices.append(idx)
    next_idx = (max(indices) + 1) if indices else 0
    return done, next_idx


def load_block(dirpath: str, source_id: str, fingerprint: str) -> Block | None:
    embs: list[np.ndarray] = []
    names: list[str] = []
    rels: list[str] = []
    idxs = sorted(
        int(_EMB_RE.search(os.path.basename(p)).group(1))
        for p in glob.glob(os.path.join(dirpath, "emb_*.npy"))
        if _EMB_RE.search(os.path.basename(p))
    )
    for idx in idxs:
        meta_path = os.path.join(dirpath, f"meta_{idx:04d}.parquet")
        emb_path = os.path.join(dirpath, f"emb_{idx:04d}.npy")
        if not os.path.exists(meta_path):
            continue
        e = np.load(emb_path)
        m = pd.read_parquet(meta_path)
        n = min(len(e), len(m))
        embs.append(e[:n])
        names.extend(m["name"].tolist()[:n])
        rel_col = m["rel_path"].tolist() if "rel_path" in m.columns else m["name"].tolist()
        rels.extend(rel_col[:n])
    if not embs:
        return None
    matrix = np.concatenate(embs, axis=0).astype(np.float16)
    # normalize (defensive; ingest already normalizes)
    norms = np.linalg.norm(matrix.astype(np.float32), axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    matrix = (matrix.astype(np.float32) / norms).astype(np.float16)
    return Block(source_id=source_id, fingerprint=fingerprint, matrix=matrix,
                 names=tuple(names), rel_paths=tuple(rels))
