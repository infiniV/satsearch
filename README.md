# satsearch

> Local, GPU-accelerated semantic search over satellite tiles.

Point satsearch at a satellite-tile dataset (a standard **XYZ/TMS pyramid** or a plain
image folder), let it embed the tiles on your NVIDIA GPU with **SigLIP2**, then search by
natural language ("brick kiln", "circular water tank"), a dropped image, or "find similar"
from any result — and see hits ranked in a grid or placed on a map drawn from your own
tiles. You can also import an existing [satImg](../satImg) dataset's embeddings, and label
results into an exportable gold-set.

Everything runs locally: a **Electron + shadcn** desktop app over a self-provisioning
**Python FastAPI GPU sidecar**. No cloud, no accounts, no external services.

## Stack (2026)

- **Electron 41 · React 19 · Tailwind v4 · shadcn/ui** (electron-vite 5, pnpm)
- **Python 3.12 sidecar** — FastAPI + **PyTorch 2.11 (cu126) + transformers 5**, SigLIP2
  `google/siglip2-so400m-patch16-256` (1152-d), CUDA fp16; managed with **uv**
- **numpy** vector store (exact cosine via blocked-upcast `np.matvec`), npy/parquet shards
- **sharp** for basemap tile crops, **Leaflet** for the map

## Requirements

- **Linux or Windows** with an **NVIDIA GPU** (CUDA 12.x, ≥6 GB VRAM). No macOS in v1.
- **≥16 GB system RAM** for ~2M-tile corpora (the corpus lives in CPU RAM).
- First run downloads the CUDA torch wheels (~2.5 GB) + the model (~3 GB). See
  [docs/HOW-TO-RUN.md](docs/HOW-TO-RUN.md).

## Develop

```bash
# 1) sidecar (Python) — provisions Python 3.12 + deps
cd sidecar && uv sync --group dev --group gpu   # omit --group gpu for CPU-only unit tests
uv run pytest                                   # 63 tests

# 2) app (Electron)
cd .. && pnpm install && pnpm approve-builds     # approve sharp/electron/esbuild
pnpm test        # vitest
pnpm typecheck
pnpm dev         # launch the app (spawns the sidecar automatically)
```

## Install (end users)

Grab the installer for your OS from the [latest release](../../releases/latest):

- **Linux** — `satsearch-<version>.AppImage` (`chmod +x`, then run)
- **Windows** — `satsearch Setup <version>.exe`

The installer is small: it ships the app + a bundled `uv`, **not** a multi-GB Python
environment. On **first run** the app provisions its own GPU environment (downloads a
managed Python + the CUDA PyTorch wheels + the SigLIP2 model, ~5–6 GB total) with a live
progress screen. Every launch after that is offline and instant. Details:
[docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

## Build

```bash
# Each installer is built on its own OS (native uv/sharp). fetch-uv downloads the
# per-OS uv binary into resources/bin; no venv is baked in.
pnpm build:linux   # AppImage  (run on Linux)
pnpm build:win     # nsis      (run on Windows)
```

Releases are produced by CI: push a `v*` tag and `.github/workflows/release.yml` builds
the Linux + Windows installers and attaches them to a GitHub Release.

See [STATUS.md](STATUS.md) for the phase-by-phase build state and
[docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) for the packaging model.

## License

MIT
