# How to run satsearch

## Prerequisites

- **NVIDIA GPU** with a working driver (CUDA 12.x capable, ≥6 GB VRAM).
- **≥16 GB system RAM** recommended for large corpora (the vector corpus lives in CPU RAM).
- Disk: ~10–12 GB free for the first-run download (CUDA torch wheels + SigLIP2 weights).
- [`uv`](https://docs.astral.sh/uv/) and `pnpm` for development (the packaged app bundles
  a pinned `uv` and a CI-pre-built venv, so end users need neither).

## First run (what happens)

1. The Electron app takes the single-instance lock and spawns the Python sidecar via
   `child_process.spawn` (`python -m satsearch_sidecar`), passing a per-launch **token**,
   a free **port**, and the data dir.
2. In dev, the sidecar's venv is your `sidecar/.venv` (`uv sync`). On first model use,
   `transformers` downloads `google/siglip2-so400m-patch16-256` (~3 GB) into the HF cache.
3. The **HealthGate** overlay blocks the UI until `GET /health` returns `ready:true`
   (covers model download + CUDA warm-up). Typed failure states: `driver-missing`,
   `cuda-missing`, `oom`, `disk-full`, `network`.

> Offline first run fails by design (it needs to download torch + the model). The gate
> shows the `network` state with the ~5–6 GB disclosure.

## Using it

1. **Sources → Add folder**: pick an XYZ pyramid (`{z}/{x}/{y}.jpg|png`) or a plain image
   folder. satsearch detects the kind, embeds it on the GPU (live progress; cancellable),
   and hot-loads it into the search index.
2. **Import satImg**: point at a satImg data dir. Provenance is user-attested and
   **verified** (re-embeds 24 sampled tiles; rejects a wrong checkpoint).
3. **Search**: type a phrase, drop an image, or hit the ✨ on a result for "find similar".
   Filter by source (toggle badges) and score (slider). Toggle **grid ⇄ map**.
4. **Labels**: add classes, pick an active class, tag results with the 🏷 button, then
   **Export gold-set** — a per-class dataset + manifest under `<dataDir>/labels/export`.

## Data location

All app data lives under Electron's `userData` (override with `SATSEARCH_DATA_DIR`):

```
<dataDir>/
  sidecar.lock              # {pid, port, token, sidecarVersion}
  sources.json  model.json
  embeddings/<sourceId>/    # emb_*.npy + meta_*.parquet shards
  labels/                   # classes.json, labels.jsonl, export/
```

## Sidecar env vars

| var | meaning |
|-----|---------|
| `SATSEARCH_DATA_DIR` | data root |
| `SATSEARCH_TOKEN` | per-launch bearer token (set by Electron) |
| `SATSEARCH_PORT` | port to bind (set by Electron) |
| `SATSEARCH_MODEL` | HF checkpoint id (default so400m-256) |
| `SATSEARCH_DEVICE` | `cuda` (default) or `cpu` (degraded, query-only) |

## Tests

```bash
cd sidecar && uv run pytest      # 63 sidecar tests
pnpm test                        # 19 Electron tests
python sidecar/tests/live_smoke.py   # live HTTP boot smoke (CPU fake model)
```
