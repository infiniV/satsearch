"""Real-GPU end-to-end smoke: load SigLIP2 on CUDA, embed tiles + text, search.
Proves items 2-4 of the run list on actual hardware (not mocked)."""
import io
import time

import numpy as np
from PIL import Image

from satsearch_sidecar.siglip import load_model
from satsearch_sidecar.store import Store, Block

t0 = time.time()
print("loading google/siglip2-so400m-patch16-256 on cuda ...", flush=True)
model = load_model("google/siglip2-so400m-patch16-256", "cuda")
print(f"  loaded in {time.time()-t0:.1f}s", flush=True)
print("  device =", model.device, "dims =", model.dims, flush=True)
print("  fingerprint =", model.fingerprint, flush=True)

# synthetic 'tiles' (random RGB) — proves the pipeline; semantic quality needs real imagery
rng = np.random.default_rng(0)
tiles = [Image.fromarray(rng.integers(0, 255, (64, 64, 3), dtype=np.uint8)) for _ in range(8)]
t1 = time.time()
emb = model.encode_images(tiles).astype(np.float16)   # (8, 1152), L2-normalized
print(f"encoded 8 tiles on GPU in {time.time()-t1:.2f}s -> shape {emb.shape}, dtype {emb.dtype}", flush=True)

store = Store(calibrate=model.calibrate)
store.upsert_block(Block(source_id="smoke", fingerprint=model.fingerprint,
                         matrix=emb, names=[f"t{i}" for i in range(8)]))

for query in ["brick kiln", "circular water tank", "aircraft on apron"]:
    t2 = time.time()
    q = model.encode_text(query)
    res = store.search(np.asarray(q, np.float32), active_fp=model.fingerprint,
                       limit=3, query_hash=query)
    dt = (time.time() - t2) * 1000
    top = [(r["name"], round(float(r["score"]), 4)) for r in res["results"]]
    print(f'query "{query}": {dt:.1f}ms  total={res["total"]}  top3(name,calib_prob)={top}', flush=True)

import torch
print("peak VRAM (GiB):", round(torch.cuda.max_memory_allocated() / 1024**3, 2), flush=True)

# ---- adaptive batch auto-tune (no hardcoded size) --------------------------------
import os
import tempfile

from satsearch_sidecar import gpu, ingest
from satsearch_sidecar.siglip import DEFAULT_IMAGE_SIZE

info = gpu.describe_device("cuda")
print(f"\ndevice = {info.name}  vram = {(info.vram_total or 0)/1e9:.1f} GB  "
      f"capability = {info.capability}", flush=True)
cache = os.path.join(tempfile.mkdtemp(), "autotune.json")
torch.cuda.reset_peak_memory_stats()
t3 = time.time()
auto_bs = gpu.autotune_batch(model, DEFAULT_IMAGE_SIZE, "cuda", cache)
print(f"auto-tuned batch = {auto_bs}  (probe {time.time()-t3:.1f}s, "
      f"cached at {cache})", flush=True)
assert auto_bs >= 32, "expected auto-tune to match/exceed the old hardcoded 32"
# second call must hit the cache (instant)
t4 = time.time()
assert gpu.autotune_batch(model, DEFAULT_IMAGE_SIZE, "cuda", cache) == auto_bs
print(f"cached re-resolve = {(time.time()-t4)*1000:.1f} ms", flush=True)

# ---- serial vs. overlapped-prefetch throughput (real disk-backed JPEGs) -----------
# Writing tiles to disk is deliberate: prefetch's job is to overlap disk read + JPEG
# decode with GPU compute, so an in-RAM benchmark would hide exactly what it optimizes.
N = max(256, auto_bs * 2)
tile_dir = tempfile.mkdtemp()
paths = []
for i in range(N):
    p = os.path.join(tile_dir, f"{i}.jpg")
    Image.fromarray(rng.integers(0, 255, (DEFAULT_IMAGE_SIZE, DEFAULT_IMAGE_SIZE, 3),
                                 dtype=np.uint8)).save(p, quality=90)
    paths.append(p)

torch.cuda.synchronize(); ts = time.time()
for i in range(0, N, 32):                        # old path: batch 32, serial disk→GPU
    pils = [Image.open(p).convert("RGB") for p in paths[i:i + 32]]
    model.encode_images(pils)
torch.cuda.synchronize()
serial_tps = N / (time.time() - ts)

def _prep(group):                                # runs in worker threads
    return model.preprocess([Image.open(paths[i]).convert("RGB") for i in group])

groups = ([i for i in range(s, min(s + auto_bs, N))] for s in range(0, N, auto_bs))
torch.cuda.synchronize(); tp = time.time()
for _grp, prepared in ingest._prefetch(groups, _prep,
                                       num_workers=gpu.resolve_num_workers(),
                                       depth=gpu.resolve_prefetch()):
    model.encode_prepared(prepared)              # new path: auto batch + prefetch overlap
torch.cuda.synchronize()
pipe_tps = N / (time.time() - tp)

print(f"\nthroughput over {N} disk-backed tiles "
      f"({gpu.resolve_num_workers()} workers):", flush=True)
print(f"  serial   (batch 32)            : {serial_tps:7.1f} tiles/s", flush=True)
print(f"  pipeline (batch {auto_bs}, prefetch) : {pipe_tps:7.1f} tiles/s "
      f"({pipe_tps/serial_tps:.2f}x)", flush=True)
print("peak VRAM after pipeline (GiB):",
      round(torch.cuda.max_memory_allocated() / 1024**3, 2), flush=True)
print("GPU SMOKE: PASS", flush=True)
