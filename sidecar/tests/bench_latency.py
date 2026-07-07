"""§6 fresh-query latency + resident-memory bench (the P95>200ms ANN gate).

Run per corpus size in its own process so RAM frees between sizes:
    uv run python tests/bench_latency.py 1000000
Measures, on the reference desktop:
  - pure blocked-upcast matvec time (the bandwidth-bound kernel)
  - full store.search fresh-query time (matvec + argpartition-K + rank bookkeeping)
  - P50/P95/max over many distinct queries (unique query_hash => always cache-miss)
  - resident set size (RSS) of the corpus
Does NOT need the model: random L2-normalized fp16 vectors exercise the exact kernel.
"""
import gc
import sys
import time

import numpy as np

from satsearch_sidecar.store import Store, Block

D = 1152
N = int(sys.argv[1]) if len(sys.argv) > 1 else 1_000_000
NQ = 25


def rss_gib() -> float:
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024 / 1024
    return 0.0


def make_corpus(n: int) -> np.ndarray:
    """Random L2-normalized fp16 (n, D), built in chunks to bound the fp32 temp."""
    m = np.empty((n, D), dtype=np.float16)
    rng = np.random.default_rng(0)
    step = 100_000
    for s in range(0, n, step):
        e = min(s + step, n)
        chunk = rng.standard_normal((e - s, D)).astype(np.float32)
        chunk /= np.linalg.norm(chunk, axis=1, keepdims=True)
        m[s:e] = chunk.astype(np.float16)
    return m


def pctl(xs, p):
    return sorted(xs)[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


print(f"N={N:,}  D={D}  (fp16 corpus = {N * D * 2 / 1024**3:.2f} GiB)", flush=True)
t0 = time.time()
mat = make_corpus(N)
print(f"corpus built in {time.time() - t0:.1f}s  RSS={rss_gib():.2f} GiB", flush=True)

store = Store(calibrate=lambda x: x)  # identity calibrate isolates kernel cost
store.upsert_block(Block(source_id="bench", fingerprint="fp",
                         matrix=mat, names=tuple(str(i) for i in range(N))))
print(f"store built  RSS={rss_gib():.2f} GiB", flush=True)

rng = np.random.default_rng(1)
q0 = rng.standard_normal(D).astype(np.float32)
q0 /= np.linalg.norm(q0)

# warm up BLAS / pagein
store.search(q0, active_fp="fp", limit=100, query_hash="warm")

# (a) pure kernel: blocked-upcast matvec only
kern = []
for i in range(NQ):
    q = rng.standard_normal(D).astype(np.float32); q /= np.linalg.norm(q)
    t = time.perf_counter()
    _ = store._blocked_matvec(mat, q)
    kern.append((time.perf_counter() - t) * 1000)

# (b) full fresh query via store.search (unique hash => cache-miss every time)
full = []
for i in range(NQ):
    q = rng.standard_normal(D).astype(np.float32); q /= np.linalg.norm(q)
    t = time.perf_counter()
    _ = store.search(q, active_fp="fp", limit=100, query_hash=f"fresh-{i}")
    full.append((time.perf_counter() - t) * 1000)

# (c) cached page fetch (should be sub-ms)
store.search(q0, active_fp="fp", limit=100, query_hash="cached")
cache = []
for _ in range(NQ):
    t = time.perf_counter()
    _ = store.search(q0, active_fp="fp", from_=100, limit=100, query_hash="cached")
    cache.append((time.perf_counter() - t) * 1000)

import os
print(f"BLAS threads (OPENBLAS_NUM_THREADS)={os.environ.get('OPENBLAS_NUM_THREADS','default/all')}")
print(f"[kernel matvec]  p50={pctl(kern,50):.1f}ms  p95={pctl(kern,95):.1f}ms  max={max(kern):.1f}ms")
print(f"[full search  ]  p50={pctl(full,50):.1f}ms  p95={pctl(full,95):.1f}ms  max={max(full):.1f}ms")
print(f"[cached page  ]  p50={pctl(cache,50):.3f}ms  p95={pctl(cache,95):.3f}ms")
print(f"peak RSS={rss_gib():.2f} GiB")
gap = pctl(full, 50) - pctl(kern, 50)
print(f"per-query bookkeeping overhead (full-kernel, p50) = {gap:.1f}ms")
print("BENCH DONE", flush=True)
del store, mat
gc.collect()
