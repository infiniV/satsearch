"""Immutable-snapshot vector store (spec §6).

- Corpus lives in CPU RAM as per-source fp16 blocks; search is a blocked-upcast
  BLAS matvec (numpy has no fast fp16 GEMV — copy-upcast a cache-sized block into a
  reused fp32 buffer, then `np.matvec`).
- Readers take an immutable snapshot reference with no lock; writers build a new
  snapshot (sharing untouched blocks) and swap under a short lock — lock-free reads,
  safe hot-load.
- A K-bounded ranking cache keyed (query_hash, snapshot_id, source_filter_hash) holds
  the top-K sorted (ordinal, score) so paging and the score slider are sub-ms.
"""

from __future__ import annotations

import hashlib
import itertools
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

K_DEFAULT = 5000
BLOCK_ROWS_DEFAULT = 2048  # fp32 upcast buffer ~= BLOCK_ROWS*1152*4 B; keep in L2/L3
_snap_counter = itertools.count(1)


@dataclass(frozen=True)
class Block:
    source_id: str
    fingerprint: str
    matrix: np.ndarray            # (N, D) float16, L2-normalized
    names: tuple[str, ...]        # length N
    rel_paths: tuple[str, ...] = ()  # length N; defaults to names when empty

    def rel(self, i: int) -> str:
        return self.rel_paths[i] if self.rel_paths else self.names[i]


@dataclass(frozen=True)
class IndexSnapshot:
    blocks: tuple[Block, ...]
    snapshot_id: str
    # derived indexes (built in __post_init__ via object.__setattr__ since frozen)
    offsets: tuple[int, ...] = field(default=())
    ordinal_meta: tuple[tuple[str, str], ...] = field(default=())
    name_to_ordinal: dict = field(default_factory=dict)

    def __post_init__(self):
        offsets = []
        meta: list[tuple[str, str, str]] = []  # (source_id, name, rel_path)
        running = 0
        for b in self.blocks:
            offsets.append(running)
            meta.extend((b.source_id, b.names[i], b.rel(i)) for i in range(len(b.names)))
            running += b.matrix.shape[0]
        object.__setattr__(self, "offsets", tuple(offsets))
        object.__setattr__(self, "ordinal_meta", tuple(meta))
        object.__setattr__(self, "name_to_ordinal",
                           {(sid, name): i for i, (sid, name, _rel) in enumerate(meta)})


class Store:
    def __init__(
        self,
        calibrate: Callable[[np.ndarray], np.ndarray],
        cache_cap: int = 32,
        k: int = K_DEFAULT,
        block_rows: int = BLOCK_ROWS_DEFAULT,
    ):
        self._calibrate = calibrate
        self._k = k
        self._block_rows = block_rows
        self._lock = threading.Lock()
        self._snap = IndexSnapshot(blocks=(), snapshot_id="empty-0")
        self._cache: OrderedDict[tuple, tuple] = OrderedDict()
        self._cache_cap = cache_cap

    # ---- snapshot management ------------------------------------------------
    def snapshot(self) -> IndexSnapshot:
        return self._snap

    def _set(self, blocks: list[Block]) -> str:
        """Assign a new snapshot (caller holds self._lock)."""
        snap_id = f"snap-{next(_snap_counter)}"
        self._snap = IndexSnapshot(blocks=tuple(blocks), snapshot_id=snap_id)
        self._cache.clear()  # purge superseded-snapshot cache entries
        return snap_id

    def swap(self, blocks: list[Block]) -> str:
        with self._lock:
            return self._set(list(blocks))

    def upsert_block(self, block: Block) -> str:
        """Add/replace the block for `block.source_id` (build-new-then-swap)."""
        with self._lock:
            kept = [b for b in self._snap.blocks if b.source_id != block.source_id]
            return self._set(kept + [block])

    def remove_source(self, source_id: str) -> str:
        with self._lock:
            kept = [b for b in self._snap.blocks if b.source_id != source_id]
            return self._set(kept)

    def rel_path_for(self, source_id: str, name: str) -> str | None:
        snap = self._snap
        g = snap.name_to_ordinal.get((source_id, name))
        return snap.ordinal_meta[g][2] if g is not None else None

    def tiles_for(self, source_id: str) -> list[tuple[str, str]]:
        """(name, rel_path) for every embedded tile of `source_id`, in ordinal order.

        Backs the gallery browse endpoint — the whole corpus of a source, not just
        search hits. Reads the current immutable snapshot without locking.
        """
        snap = self._snap
        return [(name, rel) for (sid, name, rel) in snap.ordinal_meta if sid == source_id]

    def vector_for(self, source_id: str, name: str) -> np.ndarray | None:
        snap = self._snap
        g = snap.name_to_ordinal.get((source_id, name))
        if g is None:
            return None
        # locate block + local row
        for b, off in zip(snap.blocks, snap.offsets):
            n = b.matrix.shape[0]
            if off <= g < off + n:
                return b.matrix[g - off].astype(np.float32)
        return None

    # ---- search -------------------------------------------------------------
    def _blocked_matvec(self, matrix: np.ndarray, q: np.ndarray) -> np.ndarray:
        """fp16 matrix (N,D) · fp32 q (D,) via cache-sized fp32 scratch + np.matvec."""
        n, d = matrix.shape
        out = np.empty(n, dtype=np.float32)
        buf = np.empty((min(self._block_rows, n), d), dtype=np.float32)
        for start in range(0, n, self._block_rows):
            end = min(start + self._block_rows, n)
            chunk = buf[: end - start]
            np.copyto(chunk, matrix[start:end])   # in-place upcast into reused buffer
            out[start:end] = np.matvec(chunk, q)  # BLAS-backed fp32 matvec
        return out

    def _ranked(self, snap: IndexSnapshot, q: np.ndarray, active_fp: str,
                source_ids: set | None):
        """Return (sorted [(ordinal, score)] up to K, candidate_count)."""
        cand_ordinals: list[np.ndarray] = []
        cand_scores: list[np.ndarray] = []
        count = 0
        for b, off in zip(snap.blocks, snap.offsets):
            if b.fingerprint != active_fp:
                continue
            if source_ids is not None and b.source_id not in source_ids:
                continue
            n = b.matrix.shape[0]
            scores = self._calibrate(self._blocked_matvec(b.matrix, q))
            cand_scores.append(np.asarray(scores, dtype=np.float32))
            cand_ordinals.append(np.arange(off, off + n))
            count += n
        if count == 0:
            return [], 0
        scores = np.concatenate(cand_scores)
        ordinals = np.concatenate(cand_ordinals)
        k = min(self._k, count)
        top = np.argpartition(-scores, k - 1)[:k]
        # sort the K by (-score, source_id, name) — deterministic tiebreak
        meta = snap.ordinal_meta
        score_by_ord = {int(o): float(s) for o, s in zip(ordinals.tolist(), scores.tolist())}
        top_sorted = sorted(
            (int(ordinals[i]) for i in top),
            key=lambda g: (-score_by_ord[g], meta[g][0], meta[g][1]),
        )
        return [(g, score_by_ord[g]) for g in top_sorted], count

    def search(self, q, active_fp: str, source_ids=None, min_score=None,
               max_score=None, from_: int = 0, limit: int = 100,
               query_hash: str | None = None, exclude=None) -> dict:
        q = np.asarray(q, dtype=np.float32)
        snap = self._snap
        src_set = set(source_ids) if source_ids is not None else None
        src_hash = hashlib.sha1(
            ("|".join(sorted(src_set)) if src_set is not None else "*").encode()
        ).hexdigest()
        key = (query_hash, snap.snapshot_id, src_hash) if query_hash else None

        ranked = count = None
        if key is not None:
            hit = self._cache.get(key)
            if hit is not None:
                ranked, count = hit
                self._cache.move_to_end(key)
        if ranked is None:
            ranked, count = self._ranked(snap, q, active_fp, src_set)
            if key is not None:
                self._cache[key] = (ranked, count)
                self._cache.move_to_end(key)
                while len(self._cache) > self._cache_cap:
                    self._cache.popitem(last=False)

        below_window = False
        filtered = ranked
        if exclude is not None:
            exo = snap.name_to_ordinal.get(tuple(exclude))
            if exo is not None:
                filtered = [(g, s) for (g, s) in filtered if g != exo]
                if count:
                    count -= 1
        if min_score is not None:
            filtered = [(g, s) for (g, s) in filtered if s >= min_score]
        if max_score is not None:
            if ranked and max_score < ranked[-1][1]:
                below_window = True
            filtered = [(g, s) for (g, s) in filtered if s <= max_score]

        page = filtered[from_: from_ + limit] if limit and limit > 0 else filtered[from_:]
        meta = snap.ordinal_meta
        results = [
            {"source_id": meta[g][0], "name": meta[g][1], "rel_path": meta[g][2], "score": s}
            for (g, s) in page
        ]
        return {
            "total": int(count or 0),
            "snapshot_id": snap.snapshot_id,
            "from": int(from_),
            "below_window": below_window,
            "results": results,
        }
