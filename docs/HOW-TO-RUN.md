# How to run satsearch

## Prerequisites

- **NVIDIA GPU** with a working driver (CUDA 12.x capable, ≥6 GB VRAM).
- **≥16 GB system RAM** recommended for large corpora (the vector corpus lives in CPU RAM).
- Disk: ~10–12 GB free for the first-run download (CUDA torch wheels + SigLIP2 weights).
- [`uv`](https://docs.astral.sh/uv/) and `pnpm` for development. End users need **neither**:
  the packaged app bundles a pinned `uv` and provisions its own environment on first run
  (see [DISTRIBUTION.md](DISTRIBUTION.md)).

## First run (what happens)

1. **Packaged app only — provisioning.** On first launch the app runs the bundled `uv sync`
   into `<dataDir>/runtime` (a writable dir under `userData`): it downloads a managed
   CPython + the CUDA torch wheels (~2.5 GB) for *this* machine. The HealthGate narrates
   this as `Provisioning Python → Downloading GPU libraries → Building environment`. It is
   idempotent — later launches skip straight to the venv and run fully offline. In **dev**
   this step is skipped; the sidecar uses your `sidecar/.venv` (`uv sync`).
2. The Electron app spawns the Python sidecar via `child_process.spawn`
   (`python -m satsearch_sidecar`) using the provisioned interpreter, passing a per-launch
   **token**, a free **port**, and the data dir. On first model use, `transformers`
   downloads `google/siglip2-so400m-patch16-256` (~3 GB) into the HF cache.
3. The **HealthGate** overlay blocks the UI until `GET /health` returns `ready:true`
   (covers provisioning + model download + CUDA warm-up), showing live per-phase progress.

> Offline first run fails by design (it needs to download torch + the model). The gate
> shows a network-specific message with the ~5–6 GB disclosure and a **Retry** button.
> Once provisioned, the app runs offline.

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
  runtime/                  # packaged: uv-provisioned venv + managed python + cache
    venv/  python/  uv-cache/  .provisioned   # (.provisioned = uv.lock hash sentinel)
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
