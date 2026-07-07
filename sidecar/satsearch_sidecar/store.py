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
import os
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

K_DEFAULT = 5000
K_MIN = 1000
K_MAX = 50000
BLOCK_ROWS_DEFAULT = 2048  # fp32 upcast buffer ~= BLOCK_ROWS*1152*4 B; keep in L2/L3
# Below this row count the per-query fp16→fp32 upcast is cheap enough that thread
# fan-out overhead isn't worth it; above it the upcast dominates and parallelizes well.
MATVEC_THREAD_MIN_ROWS = 32768
_snap_counter = itertools.count(1)


def _default_matvec_workers() -> int:
    env = os.environ.get("SATSEARCH_SEARCH_THREADS", "").strip()
    if env:
        try:
            v = int(env)
            if v > 0:
                return v
        except ValueError:
            pass
    # memory-bandwidth-bound past ~8; cap there to avoid BLAS oversubscription.
    return max(1, min(8, (os.cpu_count() or 2) - 1))


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
        self._matvec_workers = _default_matvec_workers()
        self._lock = threading.Lock()
        self._snap = IndexSnapshot(blocks=(), snapshot_id="empty-0")
        self._cache: OrderedDict[tuple, tuple] = OrderedDict()
        self._cache_cap = cache_cap

    @property
    def k(self) -> int:
        return self._k

    def set_k(self, k: int) -> None:
        """Change the ranked-list depth. Clears the ranked cache — existing entries
        were built at the old depth, so a raise must recompute."""
        self._k = max(K_MIN, min(K_MAX, int(k)))
        self._cache.clear()

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

        A source is exactly one block, so read it directly (O(block)) instead of
        scanning the whole corpus's ordinal_meta.
        """
        snap = self._snap
        for b in snap.blocks:
            if b.source_id == source_id:
                return [(b.names[i], b.rel(i)) for i in range(len(b.names))]
        return []

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
    def _matvec_span(self, matrix: np.ndarray, q: np.ndarray, lo: int, hi: int,
                     out: np.ndarray) -> None:
        """Compute out[lo:hi] for one contiguous row span using a reused fp32 buffer.

        Each span owns its buffer, so it is safe to run spans on separate threads —
        they write disjoint slices of `out`. Peak transient stays fp16-sized: at most
        workers × block_rows × D × 4 B, not a full-corpus fp32 copy."""
        d = matrix.shape[1]
        buf = np.empty((min(self._block_rows, hi - lo), d), dtype=np.float32)
        for start in range(lo, hi, self._block_rows):
            end = min(start + self._block_rows, hi)
            chunk = buf[: end - start]
            np.copyto(chunk, matrix[start:end])   # in-place upcast into reused buffer
            out[start:end] = np.matvec(chunk, q)  # BLAS-backed fp32 matvec

    def _blocked_matvec(self, matrix: np.ndarray, q: np.ndarray) -> np.ndarray:
        """fp16 matrix (N,D) · fp32 q (D,) via cache-sized fp32 scratch + np.matvec.

        The per-query fp16→fp32 upcast is memory-bandwidth-bound and dominates the BLAS
        matvec; numpy releases the GIL in copyto/matvec, so fanning contiguous spans out
        across threads cuts wall-clock materially on multi-core hosts. Bit-identical to
        the serial path (fp16→fp32 is lossless; spans are disjoint)."""
        n, d = matrix.shape
        out = np.empty(n, dtype=np.float32)
        workers = self._matvec_workers
        if workers <= 1 or n < MATVEC_THREAD_MIN_ROWS:
            self._matvec_span(matrix, q, 0, n, out)
            return out
        # split into `workers` contiguous spans, each aligned to a block_rows boundary
        span = max(self._block_rows, -(-n // workers))
        span = -(-span // self._block_rows) * self._block_rows
        bounds = [(lo, min(lo + span, n)) for lo in range(0, n, span)]
        with ThreadPoolExecutor(max_workers=min(workers, len(bounds))) as ex:
            list(ex.map(lambda b: self._matvec_span(matrix, q, b[0], b[1], out), bounds))
        return out

    def _ranked(self, snap: IndexSnapshot, q: np.ndarray, active_fp: str,
                source_ids: set | None):
        """Return (sorted [(ordinal, calibrated_score)] up to K, candidate_count).

        Ranks on **raw cosine** and calibrates only the K survivors: `calibrate` is a
        strictly-monotonic sigmoid, so it leaves the ordering (and thus the top-K set)
        unchanged — running it over the whole corpus before selection is wasted work.
        Selection is O(count) in C (`argpartition`); all Python-level work is O(K).
        """
        cand_ordinals: list[np.ndarray] = []
        cand_scores: list[np.ndarray] = []
        count = 0
        for b, off in zip(snap.blocks, snap.offsets):
            if b.fingerprint != active_fp:
                continue
            if source_ids is not None and b.source_id not in source_ids:
                continue
            n = b.matrix.shape[0]
            cand_scores.append(self._blocked_matvec(b.matrix, q))  # raw cosine
            cand_ordinals.append(np.arange(off, off + n))
            count += n
        if count == 0:
            return [], 0
        scores = np.concatenate(cand_scores)       # raw cosine over all candidates
        ordinals = np.concatenate(cand_ordinals)
        k = min(self._k, count)
        top = np.argpartition(-scores, k - 1)[:k]  # K global-array indices (unsorted)
        top_ord = ordinals[top]                    # K global ordinals
        top_score = np.asarray(self._calibrate(scores[top]), dtype=np.float32)  # calibrate K
        # sort the K by (-score, source_id, name) — deterministic tiebreak
        meta = snap.ordinal_meta
        order = sorted(
            range(k),
            key=lambda i: (-float(top_score[i]), meta[int(top_ord[i])][0],
                           meta[int(top_ord[i])][1]),
        )
        return [(int(top_ord[i]), float(top_score[i])) for i in order], count

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
            "k": int(self._k),
            "results": results,
        }
