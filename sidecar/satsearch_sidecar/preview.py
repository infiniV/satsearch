"""Import preview: enumerate a folder without ingesting, plus learned-throughput
persistence for time estimates (spec: 2026-07-08-import-preview-design).

Scanning reuses the ingest enumerate adapters so the previewed `imageCount` matches
exactly what a real run would embed (XYZ: only the deepest/embed zoom). Total size is
*sampled* — stat'ing every tile in a 100k+ pyramid is too slow for a modal — while the
count stays exact, since the count is what drives the time estimate.
"""

from __future__ import annotations

import json
import os
import random
import threading

from . import ingest

_SAMPLE_MAX = 200            # files stat'd to approximate total size on disk
_GPU_HEURISTIC_TPS = 350.0   # first-run fallback throughput (GPU)
_CPU_HEURISTIC_TPS = 6.0     # first-run fallback throughput (CPU)

_thr_lock = threading.Lock()


# ---- learned throughput -------------------------------------------------------

def _read_throughput(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def record_throughput(path: str, device: str, tiles_per_sec: float) -> None:
    """Persist the average tiles/s of a completed run, keyed by device. Feeds the
    next import's 'measured' time estimate."""
    if not tiles_per_sec or tiles_per_sec <= 0:
        return
    with _thr_lock:
        data = _read_throughput(path)
        data[device] = round(float(tiles_per_sec), 2)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)


def _estimate(count: int, throughput_path: str, device: str, has_gpu: bool):
    """Return (est_seconds, basis) where basis is 'measured' | 'heuristic'."""
    if count <= 0:
        return 0, "measured"
    tps = _read_throughput(throughput_path).get(device)
    if isinstance(tps, (int, float)) and tps > 0:
        return int(round(count / tps)), "measured"
    heur = _GPU_HEURISTIC_TPS if has_gpu else _CPU_HEURISTIC_TPS
    return int(round(count / heur)), "heuristic"


# ---- size sampling ------------------------------------------------------------

def _sample_bytes(root: str, rels: list[str]) -> tuple[int, bool]:
    """(total_bytes, approx). Stat every file when few; otherwise stat a fixed sample
    and scale the mean by the count."""
    n = len(rels)
    if n == 0:
        return 0, False
    if n <= _SAMPLE_MAX:
        total = 0
        for rel in rels:
            try:
                total += os.stat(os.path.join(root, rel)).st_size
            except OSError:
                pass
        return total, False
    idx = random.Random(0).sample(range(n), _SAMPLE_MAX)
    sampled, ok = 0, 0
    for i in idx:
        try:
            sampled += os.stat(os.path.join(root, rels[i])).st_size
            ok += 1
        except OSError:
            pass
    if ok == 0:
        return 0, True
    return int(sampled / ok * n), True


# ---- scan ---------------------------------------------------------------------

def scan(kind: str, path: str, *, throughput_path: str, device: str, has_gpu: bool) -> dict:
    """Enumerate `path` and return an ImportPreview payload (no source, no job)."""
    if kind == "xyz":
        entries = ingest.enumerate_xyz(path)  # (name, rel, z, x, y)
        by_zoom: dict[int, int] = {}
        for (_n, _p, z, _x, _y) in entries:
            by_zoom[z] = by_zoom.get(z, 0) + 1
        embed_zoom = max(by_zoom) if by_zoom else 0
        rels = [p for (_n, p, z, _x, _y) in entries if z == embed_zoom]
        breakdown = [
            {"zoom": z, "count": by_zoom[z], "embeds": z == embed_zoom}
            for z in sorted(by_zoom)
        ]
        count = len(rels)
        total_bytes, approx = _sample_bytes(path, rels)
        est, basis = _estimate(count, throughput_path, device, has_gpu)
        return {
            "kind": "xyz", "imageCount": count,
            "totalBytes": total_bytes, "approxBytes": approx,
            "estSeconds": est, "estBasis": basis,
            "zoomBreakdown": breakdown,
        }

    if kind == "plain":
        entries = ingest.enumerate_plain(path)  # (rel, rel)
        rels = [p for (_n, p) in entries]
        subs: dict[str, int] = {}
        for rel in rels:
            top = rel.split("/", 1)[0] if "/" in rel else "."
            subs[top] = subs.get(top, 0) + 1
        subfolders = [{"name": k, "count": v} for k, v in sorted(subs.items())]
        count = len(rels)
        total_bytes, approx = _sample_bytes(path, rels)
        est, basis = _estimate(count, throughput_path, device, has_gpu)
        return {
            "kind": "plain", "imageCount": count,
            "totalBytes": total_bytes, "approxBytes": approx,
            "estSeconds": est, "estBasis": basis,
            "subfolders": subfolders,
        }

    if kind == "satimg":
        entries = ingest.enumerate_satimg_flat(path)  # (name, rel, x, y, z)
        rels = [p for (_n, p, _x, _y, _z) in entries]
        count = len(rels)
        total_bytes, approx = _sample_bytes(path, rels)
        est, basis = _estimate(count, throughput_path, device, has_gpu)
        return {
            "kind": "satimg-import", "imageCount": count,
            "totalBytes": total_bytes, "approxBytes": approx,
            "estSeconds": est, "estBasis": basis,
        }

    raise ValueError(f"unknown scan kind: {kind}")
