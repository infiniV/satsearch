import time

import numpy as np
from fastapi.testclient import TestClient
from starlette.routing import Match
from PIL import Image

from satsearch_sidecar.config import Config
from satsearch_sidecar.jobs import Jobs
from satsearch_sidecar.labels import LabelStore
from satsearch_sidecar.main import Deps, create_app
from satsearch_sidecar.siglip import Model
from satsearch_sidecar.sources import SourceRegistry
from satsearch_sidecar.store import Store


class FakeBackend:
    dims = 8
    device = "cpu"
    logit_scale = 1.0
    logit_bias = 0.0

    def encode_images(self, pils):
        return np.random.default_rng(1).standard_normal((len(pils), self.dims)).astype(np.float32)

    def encode_text(self, text):
        return np.ones(self.dims, dtype=np.float32)


def make_client(tmp_path, token="secret"):
    cfg = Config(data_dir=str(tmp_path / "data"), token=token, device="cpu")
    cfg.ensure()
    model = Model(FakeBackend(), "fp")
    deps = Deps(config=cfg, model=model, store=Store(calibrate=model.calibrate),
                registry=SourceRegistry(cfg.sources_json), jobs=Jobs(),
                labels=LabelStore(str(tmp_path / 'labels')))
    return TestClient(create_app(deps)), cfg


def _auth(token="secret"):
    return {"Authorization": f"Bearer {token}"}


def test_health_requires_token(tmp_path):
    client, _ = make_client(tmp_path)
    assert client.get("/health").status_code == 401
    r = client.get("/health", headers=_auth())
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is True and body["dims"] == 8 and body["fingerprint"] == "fp"


def test_add_source_then_search(tmp_path):
    client, _cfg = make_client(tmp_path)
    imgs = tmp_path / "imgs"
    imgs.mkdir()
    for i in range(5):
        Image.new("RGB", (4, 4)).save(imgs / f"{i}.jpg")
    r = client.post("/sources", json={"kind": "plain", "path": str(imgs)}, headers=_auth())
    assert r.status_code == 200
    job_id = r.json()["jobId"]
    # poll until ingest done
    for _ in range(100):
        j = client.get(f"/jobs/{job_id}", headers=_auth()).json()
        if j["state"] == "done":
            break
        time.sleep(0.02)
    assert j["state"] == "done"
    # text search returns results with app://thumb urls
    r = client.post("/search", data={"query": "anything"}, headers=_auth())
    body = r.json()
    assert body["total"] == 5
    assert len(body["results"]) == 5
    assert body["results"][0]["thumbUrl"].startswith("app://thumb/")


def test_xyz_source_geo_and_basemap(tmp_path):
    client, _ = make_client(tmp_path)
    root = tmp_path / "pyr"
    for x in range(2):
        for y in range(2):
            d = root / "12" / str(x)
            d.mkdir(parents=True, exist_ok=True)
            Image.new("RGB", (8, 8)).save(d / f"{y}.jpg")
    r = client.post("/sources", json={"kind": "xyz", "path": str(root)}, headers=_auth())
    job_id = r.json()["jobId"]
    for _ in range(200):
        if client.get(f"/jobs/{job_id}", headers=_auth()).json()["state"] == "done":
            break
        time.sleep(0.02)
    # search results carry lat/lon (geo)
    body = client.post("/search", data={"query": "x"}, headers=_auth()).json()
    assert body["total"] == 4
    assert "lat" in body["results"][0] and "lon" in body["results"][0]
    # basemap resolve finds a native tile
    res = client.post("/tiles/resolve", json={"z": 12, "x": 0, "y": 0}, headers=_auth()).json()
    assert res["file"] is not None and res["file"].endswith("12/0/0.jpg")


def test_labels_flow(tmp_path):
    client, _ = make_client(tmp_path)
    # add a class, label a tile, read state, list, export
    client.post("/labels/classes", json={"name": "kiln"}, headers=_auth())
    client.post("/labels", json={"sourceId": "A", "tile": "t1", "label": "kiln"}, headers=_auth())
    state = client.post("/labels/state", json={"keys": [["A", "t1"]]}, headers=_auth()).json()
    assert state == {"A\x00t1": "kiln"}
    classes = {c["name"]: c["count"] for c in client.get("/labels/classes", headers=_auth()).json()}
    assert classes["kiln"] == 1
    # deleting a non-empty class is 409
    assert client.delete("/labels/classes/kiln", headers=_auth()).status_code == 409
    # delete the label, then the class is deletable
    client.delete("/labels/A/t1", headers=_auth())
    assert client.post("/labels/state", json={"keys": [["A", "t1"]]}, headers=_auth()).json() == {}
    assert client.delete("/labels/classes/kiln", headers=_auth()).status_code == 200


def test_search_rejects_non_score_sort(tmp_path):
    client, _ = make_client(tmp_path)
    r = client.post("/search", data={"query": "x", "sort": "name"}, headers=_auth())
    assert r.status_code == 400


class ContentBackend:
    """Deterministic per-image embedding so stored vectors match a re-embed (spot-verify)."""
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


def test_import_satimg_endpoint(tmp_path):
    # client whose model uses the deterministic backend so spot-verify passes
    cfg = Config(data_dir=str(tmp_path / "data"), token="secret", device="cpu")
    cfg.ensure()
    model = Model(ContentBackend(), "fp-attest")
    deps = Deps(config=cfg, model=model, store=Store(calibrate=model.calibrate),
                registry=SourceRegistry(cfg.sources_json), jobs=Jobs(),
                labels=LabelStore(str(tmp_path / "labels")))
    client = TestClient(create_app(deps))

    # build a satImg-shaped city: ges_* tiles + emb/meta shard in the same dir
    city = tmp_path / "lahore"
    city.mkdir()
    names, xs, ys, zs = [], [], [], []
    for i in range(6):
        fname = f"ges_{i}_{i + 1}_20.jpg"
        Image.new("RGB", (4, 4), (i * 20, 5, 9)).save(city / fname)
        names.append(fname); xs.append(i); ys.append(i + 1); zs.append(20)
    reloaded = [Image.open(city / n).convert("RGB") for n in names]
    emb = model.encode_images(reloaded).astype(np.float16)
    np.save(str(city / "emb_0000.npy"), emb)
    import pandas as pd
    pd.DataFrame({"name": names, "x": xs, "y": ys, "z": zs}).to_parquet(
        str(city / "meta_0000.parquet"))

    r = client.post("/import/satimg",
                    json={"path": str(city), "checkpoint": "google/siglip2-so400m-patch16-256"},
                    headers=_auth())
    assert r.status_code == 200
    job_id = r.json()["jobId"]
    for _ in range(200):
        j = client.get(f"/jobs/{job_id}", headers=_auth()).json()
        if j["state"] in ("done", "error"):
            break
        time.sleep(0.02)
    assert j["state"] == "done", j
    # the imported source is registered as satimg-import and is searchable
    srcs = client.get("/sources", headers=_auth()).json()
    assert any(s["kind"] == "satimg-import" for s in srcs)
    body = client.post("/search", data={"query": "x"}, headers=_auth()).json()
    assert body["total"] == 6


def test_list_and_delete_source(tmp_path):
    client, _ = make_client(tmp_path)
    imgs = tmp_path / "imgs"
    imgs.mkdir()
    Image.new("RGB", (4, 4)).save(imgs / "a.jpg")
    sid = client.post("/sources", json={"kind": "plain", "path": str(imgs)},
                      headers=_auth()).json()["sourceId"]
    for _ in range(100):
        if any(s["id"] == sid for s in client.get("/sources", headers=_auth()).json()):
            break
        time.sleep(0.01)
    assert client.delete(f"/sources/{sid}", headers=_auth()).json()["deleted"] is True
    assert all(s["id"] != sid for s in client.get("/sources", headers=_auth()).json())


def test_import_satimg_images_only_embeds_fresh(tmp_path):
    cfg = Config(data_dir=str(tmp_path / "data"), token="secret", device="cpu")
    cfg.ensure()
    model = Model(ContentBackend(), "fp-active")
    deps = Deps(config=cfg, model=model, store=Store(calibrate=model.calibrate),
                registry=SourceRegistry(cfg.sources_json), jobs=Jobs(),
                labels=LabelStore(str(tmp_path / "labels")))
    client = TestClient(create_app(deps))

    # images-only satImg city: ges_* tiles, NO emb_*.npy / meta_*.parquet
    city = tmp_path / "lahore"
    city.mkdir()
    for i in range(6):
        Image.new("RGB", (4, 4), (i * 20, 5, 9)).save(city / f"ges_{i}_{i + 1}_20.jpg")

    r = client.post("/import/satimg", json={"path": str(city)}, headers=_auth())
    assert r.status_code == 200
    job_id = r.json()["jobId"]
    for _ in range(200):
        j = client.get(f"/jobs/{job_id}", headers=_auth()).json()
        if j["state"] in ("done", "error"):
            break
        time.sleep(0.02)
    assert j["state"] == "done", j

    srcs = client.get("/sources", headers=_auth()).json()
    imported = [s for s in srcs if s["kind"] == "satimg-import"]
    assert len(imported) == 1
    assert imported[0]["projection"] == "geodetic"
    assert imported[0]["attested"] is False
    assert imported[0]["tileCount"] == 6
    # geolocated + searchable
    body = client.post("/search", data={"query": "x"}, headers=_auth()).json()
    assert body["total"] == 6
    assert body["results"][0]["lat"] is not None


def test_import_satimg_rejects_non_city(tmp_path):
    cfg = Config(data_dir=str(tmp_path / "data"), token="secret", device="cpu")
    cfg.ensure()
    model = Model(ContentBackend(), "fp-active")
    deps = Deps(config=cfg, model=model, store=Store(calibrate=model.calibrate),
                registry=SourceRegistry(cfg.sources_json), jobs=Jobs(),
                labels=LabelStore(str(tmp_path / "labels")))
    client = TestClient(create_app(deps))
    empty = tmp_path / "empty"
    empty.mkdir()
    r = client.post("/import/satimg", json={"path": str(empty)}, headers=_auth())
    assert r.status_code == 400


def test_jobs_stream_route_not_shadowed_by_job_id(tmp_path):
    # Regression: GET /jobs/stream must resolve to the SSE endpoint, not be captured
    # by /jobs/{job_id} (which 404s "no such job") — that stream is the renderer's
    # only channel for job progress + source-mutation refresh.
    client, _ = make_client(tmp_path)
    scope = {"type": "http", "method": "GET", "path": "/jobs/stream"}
    winner = next(r for r in client.app.routes if r.matches(scope)[0] == Match.FULL)
    assert winner.endpoint.__name__ == "jobs_stream", winner.endpoint.__name__
