"""satImg importer (spec §5, §8).

Reads satImg's precomputed embeddings (emb_*.npy + meta_*.parquet) and tile imagery
without re-embedding, quarantining satImg's geodetic / z-suffix=zoom+1 / TMS quirk inside
a declarative `tileLayout`. Provenance is user-attested but VERIFIED: spot-verify
re-embeds N sampled tiles and requires the MIN cosine ≥ 0.9 (a wrong checkpoint is
≈orthogonal; a min, not a mean, catches a corrupt minority).
"""

from __future__ import annotations

import glob
import os

import numpy as np
import pandas as pd

from . import shards
from .satimg_layout import GES_LAYOUT, parse_ges
from .siglip import Model
from .sources import Source
from .store import Store

DEFAULT_SAMPLE_N = 24
ATTEST_THRESHOLD = 0.9


def _load_satimg_embeddings(in_emb_dir: str):
    """Concatenate satImg emb_*.npy + meta_*.parquet -> (emb float32 normalized, names)."""
    embs, names = [], []
    for npy in sorted(glob.glob(os.path.join(in_emb_dir, "emb_*.npy"))):
        suf = os.path.basename(npy).split("emb_")[-1].split(".npy")[0]
        pq = os.path.join(in_emb_dir, f"meta_{suf}.parquet")
        if not os.path.exists(pq):
            continue
        e = np.load(npy)
        m = pd.read_parquet(pq)
        n = min(len(e), len(m))
        embs.append(e[:n].astype(np.float32))
        names.extend(m["name"].tolist()[:n])
    emb = np.concatenate(embs, axis=0)
    norms = np.linalg.norm(emb, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return emb / norms, names


def spot_verify(emb: np.ndarray, names: list[str], tile_dir: str, model: Model,
                sample_n: int = DEFAULT_SAMPLE_N, threshold: float = ATTEST_THRESHOLD):
    """Re-embed sampled tiles and compare to stored vectors. Returns (ok, min_cos)."""
    n = len(names)
    k = min(sample_n, n)
    idx = np.random.default_rng(0).choice(n, size=k, replace=False)
    min_cos = 1.0
    for i in idx:
        path = os.path.join(tile_dir, names[int(i)])
        with open(path, "rb") as f:
            v = model.encode_image(f.read())
        stored = emb[int(i)] / (np.linalg.norm(emb[int(i)]) + 1e-12)
        cos = float(np.dot(v, stored))
        min_cos = min(min_cos, cos)
    return (min_cos >= threshold), min_cos


def import_satimg_city(*, city: str, tile_dir: str, in_emb_dir: str, out_emb_dir: str,
                       model: Model, attest_fingerprint: str, store: Store,
                       sample_n: int = DEFAULT_SAMPLE_N, source_id: str | None = None,
                       label: str | None = None) -> Source:
    if not os.path.isdir(tile_dir):
        raise FileNotFoundError(
            f"satImg import requires tile imagery at {tile_dir} (embeddings-only import "
            f"is not supported)")

    emb, names = _load_satimg_embeddings(in_emb_dir)
    ok, min_cos = spot_verify(emb, names, tile_dir, model, sample_n)
    if not ok:
        raise ValueError(
            f"satImg import failed attestation: min cosine {min_cos:.4f} < {ATTEST_THRESHOLD} "
            f"— the attested checkpoint likely does not match. Re-embed instead.")

    # persist as satsearch shards (rel_path = the ges filename; x/y/z from meta)
    meta_full = _meta_with_coords(in_emb_dir, names)
    os.makedirs(out_emb_dir, exist_ok=True)
    _write_import_shards(out_emb_dir, emb.astype(np.float16), meta_full, tile_dir)
    open(os.path.join(out_emb_dir, "_done"), "w").close()

    sid = source_id or f"satimg-{city}"
    block = shards.load_block(out_emb_dir, sid, attest_fingerprint)
    snap_id = store.upsert_block(block)

    z = int(meta_full["z"].iloc[0]) if len(meta_full) else 0
    map_z = z - 1  # satImg z-suffix = map zoom + 1
    source = Source(
        id=sid, label=label or f"satImg: {city}", kind="satimg-import",
        rootPath=tile_dir, tileCount=len(names), hasGeo=True, projection="geodetic",
        minZoom=map_z, maxZoom=map_z, embedZoom=map_z,
        tileLayout=GES_LAYOUT,
        fingerprint=attest_fingerprint, attested=True, availability="available",
        active=True, rev=0,
    )
    _ = snap_id
    return source


def has_satimg_embeddings(in_emb_dir: str) -> bool:
    """True iff `in_emb_dir` holds at least one emb_*.npy with a matching meta_*.parquet."""
    for npy in glob.glob(os.path.join(in_emb_dir, "emb_*.npy")):
        suf = os.path.basename(npy).split("emb_")[-1].split(".npy")[0]
        if os.path.exists(os.path.join(in_emb_dir, f"meta_{suf}.parquet")):
            return True
    return False


def has_ges_tiles(tile_dir: str) -> bool:
    """True iff any `ges_*` tile exists directly under `tile_dir`."""
    if not os.path.isdir(tile_dir):
        return False
    return any(parse_ges(f) is not None for f in os.listdir(tile_dir))


def first_map_zoom(tile_dir: str) -> int:
    """Map zoom of the city = (ges zfile) - zOffset, read from the first ges tile."""
    for f in sorted(os.listdir(tile_dir)):
        p = parse_ges(f)
        if p is not None:
            return p[2] - GES_LAYOUT.zOffset
    raise ValueError(f"no ges_* tiles under {tile_dir}")


def make_fresh_satimg_source(sid: str, city: str, tile_dir: str, fingerprint: str,
                             label: str | None = None) -> Source:
    """Geodetic Source shell for a fresh-embedded satImg city (vectors computed here:
    attested=False, active fingerprint). tileCount is patched from the job after ingest."""
    map_z = first_map_zoom(tile_dir)
    return Source(
        id=sid, label=label or f"satImg: {city}", kind="satimg-import",
        rootPath=tile_dir, tileCount=0, hasGeo=True, projection="geodetic",
        minZoom=map_z, maxZoom=map_z, embedZoom=map_z, tileLayout=GES_LAYOUT,
        fingerprint=fingerprint, attested=False, availability="available",
        active=True, rev=0,
    )


def _meta_with_coords(in_emb_dir: str, names: list[str]) -> pd.DataFrame:
    metas = [pd.read_parquet(p) for p in sorted(glob.glob(os.path.join(in_emb_dir, "meta_*.parquet")))]
    df = pd.concat(metas, ignore_index=True).iloc[: len(names)].copy()
    return df


def _write_import_shards(out_dir: str, emb: np.ndarray, meta: pd.DataFrame, tile_dir: str):
    names = meta["name"].tolist()
    rel = names  # rel_path == the ges filename under tile_dir
    mtimes, sizes = [], []
    for nm in names:
        p = os.path.join(tile_dir, nm)
        try:
            st = os.stat(p)
            mtimes.append(int(st.st_mtime)); sizes.append(int(st.st_size))
        except OSError:
            mtimes.append(0); sizes.append(0)
    out_meta = pd.DataFrame({
        "name": names, "rel_path": rel,
        "x": meta["x"].tolist(), "y": meta["y"].tolist(), "z": meta["z"].tolist(),
        "mtime": mtimes, "size": sizes,
    })
    shards.write_shard(out_dir, 0, emb, out_meta)
