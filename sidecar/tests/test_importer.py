import numpy as np
import pandas as pd
import pytest
from PIL import Image

from satsearch_sidecar import importer
from satsearch_sidecar.siglip import Model
from satsearch_sidecar.store import Store


class ContentBackend:
    """Deterministic per-image embedding so a fixture's stored vectors match a
    re-embed (spot-verify)."""
    dims = 8
    device = "cpu"
    logit_scale = 1.0
    logit_bias = 0.0

    def _vec(self, pil):
        seed = int(np.asarray(pil).astype(np.int64).sum()) % (2**31)
        return np.random.default_rng(seed).standard_normal(self.dims).astype(np.float32)

    def encode_images(self, pils):
        return np.stack([self._vec(p) for p in pils])

    def encode_text(self, text):
        return np.ones(self.dims, dtype=np.float32)


def _build_satimg(tmp_path, corrupt=False):
    """Create a satImg-shaped city: tiles + a matching emb/meta shard."""
    city_dir = tmp_path / "city" / "lahore"
    city_dir.mkdir(parents=True)
    in_emb = tmp_path / "embeddings" / "city" / "lahore"
    in_emb.mkdir(parents=True)
    model = Model(ContentBackend(), "fp-attest")
    names, xs, ys, zs = [], [], [], []
    for i in range(6):
        x, y, z = i, i + 1, 20
        fname = f"ges_{x}_{y}_{z}.jpg"
        Image.new("RGB", (4, 4), (i * 20, 5, 9)).save(city_dir / fname)
        names.append(fname); xs.append(x); ys.append(y); zs.append(z)
    # embed from the RELOADED (JPEG-recompressed) files so stored vectors == a re-embed
    reloaded = [Image.open(city_dir / n).convert("RGB") for n in names]
    emb = model.encode_images(reloaded).astype(np.float16)
    if corrupt:
        emb[0] = np.array([0, 1, 0, 0, 0, 0, 0, 0], np.float16)  # orthogonal to its tile
    np.save(str(in_emb / "emb_0000.npy"), emb)
    pd.DataFrame({"name": names, "x": xs, "y": ys, "z": zs}).to_parquet(
        str(in_emb / "meta_0000.parquet"))
    return str(city_dir), str(in_emb), model


def test_import_satimg_city_success(tmp_path):
    tile_dir, in_emb, model = _build_satimg(tmp_path)
    store = Store(calibrate=model.calibrate)
    out_emb = str(tmp_path / "out" / "lahore")
    src = importer.import_satimg_city(
        city="lahore", tile_dir=tile_dir, in_emb_dir=in_emb, out_emb_dir=out_emb,
        model=model, attest_fingerprint="fp-attest", store=store, sample_n=6)
    assert src.kind == "satimg-import"
    # GES/Google Earth Studio tiles are web-mercator (Google Maps tiles), with the
    # ges quirk being z-suffix = zoom+1 and a TMS y axis — not a geodetic grid.
    assert src.projection == "web-mercator"
    assert src.tileLayout.zOffset == 1 and src.tileLayout.yScheme == "tms"
    assert src.attested is True
    assert src.tileCount == 6
    res = store.search(np.ones(8, np.float32), active_fp="fp-attest", limit=10, query_hash="q")
    assert res["total"] == 6


def test_import_rejects_bad_attestation(tmp_path):
    tile_dir, in_emb, model = _build_satimg(tmp_path, corrupt=True)
    store = Store(calibrate=model.calibrate)
    out_emb = str(tmp_path / "out" / "lahore")
    with pytest.raises(ValueError, match="attestation"):
        importer.import_satimg_city(
            city="lahore", tile_dir=tile_dir, in_emb_dir=in_emb, out_emb_dir=out_emb,
            model=model, attest_fingerprint="fp-attest", store=store, sample_n=6)


def test_spot_verify_uses_min_not_mean(tmp_path):
    tile_dir, in_emb, model = _build_satimg(tmp_path, corrupt=True)
    emb, names = importer._load_satimg_embeddings(in_emb)
    ok, min_cos = importer.spot_verify(emb, names, tile_dir, model, sample_n=6, threshold=0.9)
    assert ok is False       # one orthogonal tile fails the MIN even though others are ~1.0
    assert min_cos < 0.9


def test_missing_tiles_precondition(tmp_path):
    tile_dir, in_emb, model = _build_satimg(tmp_path)
    store = Store(calibrate=model.calibrate)
    # remove the tile imagery → precondition fails
    import shutil
    shutil.rmtree(tile_dir)
    with pytest.raises(FileNotFoundError):
        importer.import_satimg_city(
            city="lahore", tile_dir=tile_dir, in_emb_dir=in_emb,
            out_emb_dir=str(tmp_path / "out"), model=model,
            attest_fingerprint="fp-attest", store=store, sample_n=6)
