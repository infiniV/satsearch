"""GPU capability detection + batch-size auto-tuning (no hardcoded batch number).

Adapts the embed pipeline to whatever GPU is present — a 6 GB RTX 3060 up to a
141 GB H200/B200 — by *measuring* how much fits rather than assuming a constant.

torch is imported lazily inside the functions that need it, so this module (and the
unit tests that import it) work on a CPU-only box with no torch installed. The pure
selection logic (`choose_batch`) and the JSON cache are exercised without CUDA; the
real probing path (`autotune_batch`) needs a GPU and is not covered by unit tests.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Callable, Optional

log = logging.getLogger(__name__)

# Ascending candidates. `choose_batch` keeps the largest that fits + still speeds up,
# so this bounds both a tiny GPU (picks 8/16) and a huge one (picks the top that fits).
CANDIDATES = [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]
CPU_BATCH = 16          # modest default when there is no CUDA device
DEFAULT_HEADROOM = 0.85  # keep 15% VRAM free for fragmentation + the H2D staging copy
DEFAULT_PLATEAU = 1.10   # require ≥10% tiles/s gain to justify doubling the batch


@dataclass
class DeviceInfo:
    device: str            # "cuda" | "cuda:0" | "cpu"
    name: str              # GPU model, or "cpu"
    vram_total: Optional[int]  # bytes, None on CPU
    vram_free: Optional[int]   # bytes, None on CPU
    capability: Optional[str]  # e.g. "8.6", None on CPU

    @property
    def is_cuda(self) -> bool:
        return self.name != "cpu" and self.vram_total is not None


def describe_device(device: str = "cuda") -> DeviceInfo:
    """Best-effort device description. Never raises — falls back to a CPU descriptor."""
    if not str(device).startswith("cuda"):
        return DeviceInfo(device=device, name="cpu", vram_total=None,
                          vram_free=None, capability=None)
    try:  # pragma: no cover — needs torch + CUDA
        import torch
        if not torch.cuda.is_available():
            return DeviceInfo(device="cpu", name="cpu", vram_total=None,
                              vram_free=None, capability=None)
        idx = torch.cuda.current_device()
        props = torch.cuda.get_device_properties(idx)
        free, total = torch.cuda.mem_get_info(idx)
        return DeviceInfo(device=device, name=props.name, vram_total=int(total),
                          vram_free=int(free), capability=f"{props.major}.{props.minor}")
    except Exception as e:  # pragma: no cover
        log.warning("describe_device failed (%s); assuming CPU", e)
        return DeviceInfo(device="cpu", name="cpu", vram_total=None,
                          vram_free=None, capability=None)


def choose_batch(candidates: list[int],
                 fits: Callable[[int], bool],
                 throughput: Optional[Callable[[int], float]] = None,
                 plateau: float = DEFAULT_PLATEAU) -> int:
    """Pure selection over ascending `candidates`.

    Keep doubling while the batch both `fits()` (VRAM headroom, no OOM) and — if a
    `throughput()` probe is supplied — still gains at least `plateau`× tiles/s over the
    previous kept size. Stop at the first candidate that does not fit; return the last
    good one (at least the smallest candidate).
    """
    cands = sorted(set(candidates))
    best = cands[0]
    best_tp = throughput(best) if throughput else None
    for bs in cands[1:]:
        if not fits(bs):
            break
        if throughput is not None:
            tp = throughput(bs)
            # a bigger batch that doesn't meaningfully improve throughput isn't worth
            # the extra latency/VRAM — stop climbing (but keep what already fit).
            if best_tp is not None and best_tp > 0 and tp < best_tp * plateau:
                best = bs  # it fits, so it's still a valid (if not better) choice
                break
            best_tp = tp
        best = bs
    return best


# ---------------------------------------------------------------------------
# Cache — keyed by (gpu, model, image_size, torch) so a new GPU/model re-probes.
# ---------------------------------------------------------------------------
def _cache_key(info: DeviceInfo, model_fingerprint: str, image_size: int,
               torch_version: str) -> str:
    return f"{info.name}|{model_fingerprint}|{image_size}|{torch_version}"


def cache_get(cache_path: str, key: str) -> Optional[int]:
    try:
        with open(cache_path) as f:
            data = json.load(f)
        val = data.get(key)
        return int(val) if val is not None else None
    except (FileNotFoundError, ValueError, OSError):
        return None


def cache_put(cache_path: str, key: str, batch: int) -> None:
    try:
        data = {}
        if os.path.exists(cache_path):
            with open(cache_path) as f:
                data = json.load(f)
    except (ValueError, OSError):
        data = {}
    data[key] = int(batch)
    tmp = f"{cache_path}.tmp"
    os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, cache_path)


def _env_int(name: str) -> Optional[int]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        v = int(raw)
        return v if v > 0 else None  # 0 / unset ⇒ auto
    except ValueError:
        return None


def resolve_num_workers() -> int:
    override = _env_int("SATSEARCH_NUM_WORKERS")
    if override:
        return override
    return max(1, min((os.cpu_count() or 2) - 1, 8))


def resolve_prefetch() -> int:
    return _env_int("SATSEARCH_PREFETCH") or 3


def autotune_batch(model, image_size: int, device: str, cache_path: str,
                   *, headroom: float = DEFAULT_HEADROOM,
                   candidates: list[int] = CANDIDATES) -> int:
    """Resolve the embed batch size for `device`, caching the result.

    Precedence: `SATSEARCH_BATCH` env override > cached value > live probe > CPU default.
    The live probe runs real forward passes on blank tiles through the model's public
    preprocess/encode path, so it measures the true memory + speed of *this* model.
    """
    override = _env_int("SATSEARCH_BATCH")
    if override:
        log.info("batch size pinned by SATSEARCH_BATCH=%d", override)
        return override

    info = describe_device(device)
    if not info.is_cuda:
        return CPU_BATCH

    hv = os.environ.get("SATSEARCH_VRAM_HEADROOM", "").strip()
    if hv:
        try:
            headroom = float(hv)
        except ValueError:
            pass

    key = _cache_key(info, model.fingerprint, image_size, _torch_version())
    cached = cache_get(cache_path, key)
    if cached:
        log.info("batch size %d (cached) for %s", cached, info.name)
        return cached

    if os.environ.get("SATSEARCH_AUTOTUNE", "1").strip() == "0":
        # formula-only: estimate from a single small probe's per-sample cost
        batch = _formula_batch(model, image_size, device, info, headroom, candidates)
    else:
        batch = _probe_batch(model, image_size, device, info, headroom, candidates)

    cache_put(cache_path, key, batch)
    log.info("auto-tuned batch size %d for %s (%.1f GB VRAM, cap %.0f%%)",
             batch, info.name, (info.vram_total or 0) / 1e9, headroom * 100)
    return batch


def _torch_version() -> str:
    try:  # pragma: no cover
        import torch
        return torch.__version__
    except Exception:
        return "unknown"


def _blank_batch(image_size: int, n: int):  # pragma: no cover — needs PIL
    from PIL import Image
    img = Image.new("RGB", (image_size, image_size))
    return [img] * n


def _probe_batch(model, image_size, device, info: DeviceInfo,  # pragma: no cover — CUDA
                 headroom: float, candidates: list[int]) -> int:
    """Largest candidate whose measured peak VRAM stays within the headroom budget.

    For a throughput-oriented ingest job, "fill the GPU" == the biggest batch that fits;
    the OOM safety net in ingest handles any residual over-estimate. Peak memory is a
    stable, deterministic signal (unlike single-shot throughput timing at tiny batches)."""
    import torch

    budget = int((info.vram_total or 0) * headroom)

    # warm up so cuDNN workspaces/autotuner allocations are already counted in the peaks.
    try:
        model.encode_prepared(model.preprocess(_blank_batch(image_size, candidates[0])))
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()

    def fits(bs: int) -> bool:
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        try:
            model.encode_prepared(model.preprocess(_blank_batch(image_size, bs)))
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            return False
        return torch.cuda.max_memory_allocated() <= budget

    try:
        return choose_batch(candidates, fits)
    finally:
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()


def _formula_batch(model, image_size, device, info: DeviceInfo,  # pragma: no cover — CUDA
                   headroom: float, candidates: list[int]) -> int:
    """VRAM ÷ measured per-sample cost, clamped to the candidate range."""
    import torch

    probe_n = 8
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    prepared = model.preprocess(_blank_batch(image_size, probe_n))
    model.encode_prepared(prepared)
    per_sample = max(1, torch.cuda.max_memory_allocated() // probe_n)
    torch.cuda.empty_cache()
    budget = int((info.vram_total or 0) * headroom)
    target = max(candidates[0], budget // per_sample)
    fits = [c for c in sorted(candidates) if c <= target]
    return fits[-1] if fits else candidates[0]
