# satsearch — build status

Spec: `docs/superpowers/specs/2026-07-07-satsearch-design.md` (rev 7, passed 7 blind reviews)
Plans (all four phases): `docs/superpowers/plans/2026-07-07-satsearch-phase1-foundation.md`,
`…-phase2-map.md`, `…-phase3-labeling.md`, `…-phase4-polish.md`

## Phase 1 — Foundation + Core Search — ✅ COMPLETE & VERIFIED

**Sidecar (Python 3.12, `sidecar/`)** — 41 pytest + live HTTP boot smoke:
- `fingerprint.py` — canonical model fingerprint incl. preprocessing-lib versions
- `store.py` — immutable-snapshot store, blocked-upcast `np.matvec`, K-bounded ranking
  cache, fingerprint gating, find-similar self-exclude, lock-free concurrent swap
- `siglip.py` — model wrapper + calibration; lazy CUDA/transformers-v5 load path
- `shards.py` — resumable shards, durable fsync commit order, rowcount cross-check
- `sources.py` — Source registry (mirrors TS types), persistence
- `jobs.py` — job registry + SSE change signal + source-mutation events
- `ingest.py` — XYZ + plain adapters, single-writer resume, per-batch cancel + hot-load
- `importer.py` — satImg adapter, verified attestation (min-cosine ≥ 0.9, tiles-present)
- `main.py` — FastAPI app, Bearer-token auth (401 incl. /health), search/sources/jobs,
  **`/import/satimg`** (attested, spot-verified; wired to the SourcesDialog import button)
- `version.py` / `__main__.py` — content-hash version + entrypoint (lockfile handshake)

**Electron (`src/`)** — 19 vitest + clean typecheck + full production bundle:
- `pathGuard.ts` — fixed-point-decode + separator-bounded traversal guard (7 tests)
- `sidecar.ts` — decideAction / probeHealth / getFreePort / content-hash version /
  PID-reuse guard / SidecarManager (9 tests)
- `services/api.ts` — token-authed client incl. multipart search + SSE stream (3 tests)
- `protocol.ts` — `app://thumb` serving via the guard
- `ipc.ts`, `index.ts` (single-instance lock + bootstrap), `preload/`, `services/sources.ts`
- Renderer (shadcn): HealthGate, SearchBar (text/image/find-similar), ResultsGrid,
  SourcesDialog, IngestProgress, StatsBar, Slider score filter, source toggles

**Verified:** JS↔Python version hash parity (`522e496537d0847c`); live boot = health 200,
unauth→401, add source→ingest done 6/6, search→6 results with `app://thumb` URLs.

**Real GPU model load — VERIFIED on hardware (RTX 3060, 6 GB):**
- `siglip.load_model` loads `siglip2-so400m-patch16-256` on CUDA fp16 (dims=1152, peak
  VRAM 2.2 GiB), encodes tiles + text, and searches with calibrated scores in ~14–30 ms.
  Opt-in integration test: `sidecar/tests/gpu_smoke.py` (spec §12 CUDA encode test).
- **This run caught a real bug the mocked unit tests could not:** transformers v5
  `get_text/image_features` return `BaseModelOutputWithPooling`, not a tensor — fixed to
  read `.pooler_output` at all three call sites in `siglip.py`.

**Electron GUI + spawn/handshake — VERIFIED on hardware:**
- App launched against a live display: Electron spawned the sidecar, it loaded the real
  model on CUDA, the token+version handshake completed, HealthGate cleared to the main UI,
  and the StatsBar reads `cuda · 1152-d · 04c7ee74` (fingerprint matches the headless
  smoke run — same vector space).

**Still deferred to real hardware:**
- End-to-end in-GUI add-source → search → results with a real tile dataset (no satellite
  tiles on this box yet; the inference path itself is verified via `gpu_smoke.py`).
- §6 latency/memory bench at 1–2M tiles (the P95>200ms ANN gate) — needs a large corpus.

## Phase 2 — Map — ✅ COMPLETE
- `tiles.py` — per-projection tile↔lat/lon (web-mercator + geodetic), over-zoom
  ancestor+crop, tileLayout filename round-trip (6 tests)
- `geo.py` — result lat/lon + basemap resolution w/ over-zoom crop (5 tests)
- `/tiles/resolve` endpoint; search results carry lat/lon
- Electron `app://basemap` protocol — sidecar-resolved coords + **sharp** crop → PNG
  (transparent gaps), resolve cache keyed incl. sourceRevs
- Leaflet `MapView` (own-tile basemap layer, geolocated markers), grid⇄map toggle

## Phase 3 — Labeling / gold-set — ✅ COMPLETE
- `labels.py` — classes CRUD, append-only source-scoped ledger, gold-set export (7 tests)
- label endpoints (classes/state/set/delete/export) + integration test
- `LabelPanel` (classes + active class + export), per-result 🏷 tag action, label badges

## Phase 4 — Polish, resilience & distribution — ✅ COMPLETE
- `maintenance.py` — startup availability check, relink, reconcile (add/remove/**edit via
  (mtime,size)**) (2 tests)
- `/sources/{id}/relink`, `/sources/{id}/reconcile`, `/reembed/{id}` (build-then-swap)
- Electron relink/reconcile/reembed client + ipc + preload; SourcesDialog relink action
- `electron-builder.yml` — linux AppImage + win nsis, sidecar via **extraResources**
  (not asar), sharp asarUnpack
- `README.md` + `docs/HOW-TO-RUN.md`

## Phase 5 — Adaptive GPU embed pipeline — ✅ COMPLETE
Spec: `docs/superpowers/specs/2026-07-08-adaptive-gpu-embed-design.md`
- `gpu.py` — device describe (`mem_get_info`), pure `choose_batch`, VRAM-headroom
  `autotune_batch` cached per (gpu, model, image_size, torch) in `<data_dir>/autotune.json`
  (12 tests). **No hardcoded batch number survives** — env `SATSEARCH_BATCH/NUM_WORKERS/
  PREFETCH/VRAM_HEADROOM/FLUSH_SECS/COMPILE/AUTOTUNE`, all auto by default.
- `siglip.py` — `Model.preprocess`/`encode_prepared` split (fake backend falls back to
  `encode_images`); torch backend uses pinned memory + `channels_last` + `non_blocking`
  H2D; opt-in `torch.compile`. Vector space unchanged (fingerprint parity → no re-embed).
- `ingest.py` — thread prefetcher overlaps disk-read + preprocess with GPU forward;
  OOM safety net (halve + persist lowered ceiling); time-based shard flush (≤30 s ⇒
  tighter resume) (6 new tests).
- `main.py`/`jobs.py` — batch auto-resolved once at load; `/health` exposes
  `gpuName/vram/capability/batchSize`; `Job.tilesPerSec` live throughput.
- Electron — StatsBar shows GPU name + batch; IngestProgress shows tiles/s.
- **VERIFIED on RTX 3060 (6 GB), `gpu_smoke.py`:** auto-tune picks **batch 256** (vs old
  hardcoded 32), peak 3.95 GB within headroom, no OOM, cache re-resolve 0.1 ms. The same
  code fills a 4090/H200 automatically (memory-gated, capped 4096). Prefetch is neutral on
  this compute-bound laptop GPU (nothing to overlap) and hides disk/decode on faster GPUs.

## Totals: 97 pytest + 37 vitest = **134 automated tests**, all green. typecheck clean,
full production bundle builds, live HTTP boot smoke passes.

**Real SigLIP2 CUDA load is now VERIFIED** (RTX 3060, `tests/gpu_smoke.py`) and it caught +
fixed a transformers-v5 `.pooler_output` bug. Still needing real hardware: Electron GUI
runtime + python-spawn handshake at runtime, and the §6 latency/memory bench at 1–2M tiles.
