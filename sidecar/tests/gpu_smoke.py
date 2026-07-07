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
print("GPU SMOKE: PASS", flush=True)
