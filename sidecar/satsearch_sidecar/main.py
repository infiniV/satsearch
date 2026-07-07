"""FastAPI app (spec §2 contract, §8 auth). `create_app` takes injected deps so tests
run without CUDA; the real entrypoint builds deps with the GPU model."""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import quote

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from datetime import datetime, timezone

from . import geo, ingest as ingest_mod, maintenance
from .config import Config
from .ingest import run_ingest
from .jobs import Jobs
from .labels import LabelStore
from .siglip import Model
from .sources import Source, SourceRegistry, TileLayout
from .store import Store


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Deps:
    config: Config
    model: Model
    store: Store
    registry: SourceRegistry
    jobs: Jobs
    labels: LabelStore


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slug(text: str) -> str:
    return _SLUG_RE.sub("-", text.lower()).strip("-") or "source"


def _thumb_url(source_id: str, rel_path: str) -> str:
    return f"app://thumb/{source_id}/{quote(rel_path)}"


def create_app(deps: Deps) -> FastAPI:
    app = FastAPI(title="satsearch sidecar")
    d = deps

    def serialize(row: dict) -> dict:
        out = {
            "name": row["name"],
            "sourceId": row["source_id"],
            "score": float(row["score"]),
            "thumbUrl": _thumb_url(row["source_id"], row["rel_path"]),
        }
        src = d.registry.get(row["source_id"])
        if src is not None:
            ll = geo.latlon_for(src, row["name"])
            if ll:
                lat, lon, x, y, z = ll
                out.update(lat=lat, lon=lon, x=x, y=y, z=z)
        return out

    @app.middleware("http")
    async def auth(request: Request, call_next):
        expected = f"Bearer {d.config.token}" if d.config.token else None
        if expected is not None and request.headers.get("authorization") != expected:
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)

    # ---- health ----------------------------------------------------------
    @app.get("/health")
    def health():
        return {
            "ready": True,
            "phase": "ready",
            "device": d.model.device,
            "dims": d.model.dims,
            "fingerprint": d.model.fingerprint,
            "sidecarVersion": os.environ.get("SATSEARCH_SIDECAR_VERSION", "dev"),
            "vram": None,
            "ram": None,
        }

    # ---- search ----------------------------------------------------------
    @app.post("/search")
    async def search(
        query: Optional[str] = Form(None),
        image: Optional[UploadFile] = File(None),
        ref: Optional[str] = Form(None),
        sources: Optional[str] = Form(None),
        min_score: Optional[float] = Form(None),
        max_score: Optional[float] = Form(None),
        sort: str = Form("score-desc"),
        from_: int = Form(0),
        limit: int = Form(100),
    ):
        if sort != "score-desc":
            raise HTTPException(400, "v1 supports sort=score-desc only")
        exclude = None
        if image is not None:
            data = await image.read()
            q = d.model.encode_image(data)
            qhash = "img-" + str(hash(data))
        elif ref is not None:
            r = json.loads(ref)
            q = d.store.vector_for(r["sourceId"], r["name"])
            if q is None:
                raise HTTPException(404, "ref tile not found")
            exclude = (r["sourceId"], r["name"])
            qhash = f"ref-{r['sourceId']}\0{r['name']}"
        elif query:
            q = d.model.encode_text(query)
            qhash = "txt-" + query
        else:
            raise HTTPException(400, "provide query, image, or ref")

        source_ids = [s for s in sources.split(",") if s] if sources else None
        res = d.store.search(
            np.asarray(q, dtype=np.float32), active_fp=d.model.fingerprint,
            source_ids=source_ids, min_score=min_score, max_score=max_score,
            from_=from_, limit=limit, query_hash=qhash, exclude=exclude)
        return {
            "total": res["total"], "snapshotId": res["snapshot_id"], "from": res["from"],
            "belowWindow": res["below_window"],
            "results": [serialize(r) for r in res["results"]],
        }

    @app.post("/tiles/resolve")
    def tiles_resolve(payload: dict):
        z, x, y = int(payload["z"]), int(payload["x"]), int(payload["y"])
        ids = payload.get("sources")
        srcs = [s for s in d.registry.list()
                if s.hasGeo and (ids is None or s.id in ids)]
        return geo.resolve_basemap(z, x, y, srcs) or {"file": None, "crop": None}

    # ---- sources ---------------------------------------------------------
    @app.get("/sources")
    def list_sources():
        return [s.model_dump() for s in d.registry.list()]

    @app.post("/sources")
    def add_source(payload: dict):
        kind = payload.get("kind")
        path = payload.get("path")
        if kind not in ("xyz", "plain") or not path or not os.path.isdir(path):
            raise HTTPException(400, "kind must be xyz|plain and path must be a directory")
        label = payload.get("label") or os.path.basename(path.rstrip("/"))
        sid = _slug(label + "-" + str(int(time.monotonic_ns())))
        source = Source(
            id=sid, label=label, kind=kind, rootPath=path,
            hasGeo=(kind == "xyz"),
            projection=("web-mercator" if kind == "xyz" else "none"),
            embedZoom=payload.get("embedZoom"),
            fingerprint=d.model.fingerprint, availability="available", active=True, rev=0,
        )
        d.registry.add(source)
        job_id = d.jobs.new_job_id()
        d.jobs.create(job_id, sid, "ingest", total=0)  # exists before the worker starts
        emb_dir = d.config.embeddings_dir(sid)

        def worker():
            try:
                if kind == "xyz":
                    entries = ingest_mod.enumerate_xyz(path)
                    if entries:
                        zs = [z for (_n, _p, z, _x, _y) in entries]
                        ext = os.path.splitext(entries[0][1])[1].lstrip(".").lower() or "jpg"
                        d.registry.patch(
                            sid, minZoom=min(zs), maxZoom=max(zs),
                            embedZoom=source.embedZoom or max(zs),
                            tileLayout=TileLayout(template="{z}/{x}/{y}.{ext}", ext=ext,
                                                  zOffset=0, yScheme="xyz"))
                        # re-read the patched source so ingest embeds the right zoom
                        source.minZoom, source.maxZoom = min(zs), max(zs)
                        source.embedZoom = source.embedZoom or max(zs)
                run_ingest(source, d.model, d.store, d.jobs, emb_dir, job_id)
                job = d.jobs.get(job_id)
                d.registry.patch(sid, tileCount=job.done if job else 0)
            except Exception as e:  # pragma: no cover
                d.jobs.update(job_id, state="error", error=str(e))

        threading.Thread(target=worker, daemon=True).start()
        return {"jobId": job_id, "sourceId": sid}

    @app.post("/sources/{source_id}/relink")
    def relink_source(source_id: str, payload: dict):
        new_path = payload.get("path")
        if not new_path or not os.path.isdir(new_path):
            raise HTTPException(400, "path must be an existing directory")
        d.registry.patch(source_id, rootPath=new_path, availability="available")
        d.registry.bump_rev(source_id)
        snap = d.store.snapshot().snapshot_id
        d.jobs.push_mutation(source_id, "relink", snap)
        return {"ok": True}

    @app.post("/sources/{source_id}/reconcile")
    def reconcile_source(source_id: str):
        src = d.registry.get(source_id)
        if src is None:
            raise HTTPException(404, "no such source")
        return maintenance.reconcile_diff(src, d.config.embeddings_dir(source_id))

    @app.post("/reembed/{source_id}")
    def reembed_source(source_id: str):
        src = d.registry.get(source_id)
        if src is None:
            raise HTTPException(404, "no such source")
        if not os.path.isdir(src.rootPath):
            raise HTTPException(409, "source imagery unavailable; relink first")
        emb_dir = d.config.embeddings_dir(source_id)
        job_id = d.jobs.new_job_id()
        d.jobs.create(job_id, source_id, "reembed", total=0)
        # build-then-swap: write to a fresh dir, then replace on completion
        new_dir = emb_dir + ".new"
        src.fingerprint = d.model.fingerprint

        def worker():
            try:
                import shutil
                shutil.rmtree(new_dir, ignore_errors=True)
                run_ingest(src, d.model, d.store, d.jobs, new_dir, job_id, kind="reembed")
                shutil.rmtree(emb_dir, ignore_errors=True)
                os.replace(new_dir, emb_dir)
                d.registry.patch(source_id, fingerprint=d.model.fingerprint,
                                 availability="available")
                d.registry.bump_rev(source_id)
            except Exception as e:  # pragma: no cover
                d.jobs.update(job_id, state="error", error=str(e))

        threading.Thread(target=worker, daemon=True).start()
        return {"jobId": job_id}

    @app.delete("/sources/{source_id}")
    def delete_source(source_id: str):
        snap = d.store.remove_source(source_id)
        existed = d.registry.delete(source_id)
        emb_dir = d.config.embeddings_dir(source_id)
        if os.path.isdir(emb_dir):
            import shutil
            shutil.rmtree(emb_dir, ignore_errors=True)
        d.jobs.push_mutation(source_id, "delete", snap)
        return {"deleted": existed}

    # ---- satImg import: attest precomputed embeddings, or embed images fresh (§5) ----
    @app.post("/import/satimg")
    def import_satimg(payload: dict):
        from . import importer
        path = payload.get("path")
        if not path or not os.path.isdir(path):
            raise HTTPException(400, "path must be an existing satImg city directory")
        in_emb_dir = payload.get("embDir") or path
        has_emb = importer.has_satimg_embeddings(in_emb_dir)
        if not has_emb and not importer.has_ges_tiles(path):
            raise HTTPException(400, "not a satImg city (no embeddings and no ges_* tiles)")
        city = payload.get("city") or os.path.basename(path.rstrip("/"))
        sid = _slug("satimg-" + city + "-" + str(int(time.monotonic_ns())))
        job_id = d.jobs.new_job_id()
        d.jobs.create(job_id, sid, "import", total=0)  # exists before the worker starts
        out_emb_dir = d.config.embeddings_dir(sid)

        def worker():
            try:
                if has_emb:
                    # attest against the ACTIVE model; spot-verify rejects a wrong
                    # checkpoint (§5). No GPU re-embed of the full set.
                    src = importer.import_satimg_city(
                        city=city, tile_dir=path, in_emb_dir=in_emb_dir,
                        out_emb_dir=out_emb_dir, model=d.model,
                        attest_fingerprint=d.model.fingerprint, store=d.store,
                        source_id=sid)
                    d.registry.add(src)
                    snap = d.store.snapshot().snapshot_id
                    d.jobs.update(job_id, state="done", done=src.tileCount,
                                  total=src.tileCount)
                    d.jobs.push_mutation(sid, "import", snap)
                else:
                    # images-only: embed fresh through the resumable ingest job runner,
                    # which flips the job to done/cancelled, hot-loads, and pushes the
                    # source-mutation event itself.
                    src = importer.make_fresh_satimg_source(
                        sid, city, path, d.model.fingerprint)
                    run_ingest(src, d.model, d.store, d.jobs, out_emb_dir, job_id,
                               kind="import")
                    src.tileCount = d.jobs.get(job_id).total
                    d.registry.add(src)
            except Exception as e:
                d.jobs.update(job_id, state="error", error=str(e))

        threading.Thread(target=worker, daemon=True).start()
        return {"jobId": job_id, "sourceId": sid}

    # ---- jobs ------------------------------------------------------------
    # ---- labels ----------------------------------------------------------
    @app.get("/labels/classes")
    def labels_classes():
        return d.labels.classes_with_counts()

    @app.post("/labels/classes")
    def labels_add_class(payload: dict):
        name = (payload.get("name") or "").strip()
        if not name:
            raise HTTPException(400, "class name required")
        d.labels.add_class(name)
        return d.labels.classes_with_counts()

    @app.delete("/labels/classes/{name}")
    def labels_delete_class(name: str):
        try:
            d.labels.delete_class(name)
        except ValueError as e:
            raise HTTPException(409, str(e))
        return d.labels.classes_with_counts()

    @app.get("/labels")
    def labels_list(cls: Optional[str] = None):
        return d.labels.list_labeled(cls)

    @app.post("/labels/state")
    def labels_state(payload: dict):
        keys = [(k[0], k[1]) for k in payload.get("keys", [])]
        return d.labels.state_for(keys)

    @app.post("/labels")
    def labels_set(payload: dict):
        sid = (payload.get("sourceId") or "").strip()
        tile = (payload.get("tile") or "").strip()
        label = (payload.get("label") or "").strip()
        if not sid or not tile or not label:
            raise HTTPException(400, "sourceId, tile and label are required")
        prov = {k: payload.get(k) for k in ("score", "query", "x", "y", "z")}
        return d.labels.set_label(sid, tile, label, _now_iso(), prov)

    @app.delete("/labels/{source_id}/{tile:path}")
    def labels_del(source_id: str, tile: str):
        return {"existed": d.labels.del_label(source_id, tile, _now_iso())}

    @app.post("/labels/export")
    def labels_export():
        dest = os.path.join(d.config.data_dir, "labels", "export")

        def resolver(source_id: str, tile: str):
            src = d.registry.get(source_id)
            rel = d.store.rel_path_for(source_id, tile) or tile
            return os.path.join(src.rootPath, rel) if src else None

        return d.labels.export(dest, resolver)

    @app.get("/jobs")
    def list_jobs():
        return [j.model_dump() for j in d.jobs.list()]

    # NOTE: register the literal `/jobs/stream` BEFORE the `/jobs/{job_id}` param
    # route — Starlette matches in registration order, so the reverse order makes
    # `/jobs/stream` resolve as job_id="stream" (404 "no such job") and silently
    # kills the renderer's only progress + source-mutation channel.
    @app.get("/jobs/stream")
    async def jobs_stream():
        async def gen():
            loop = asyncio.get_running_loop()
            last = None
            while True:
                snap = d.jobs.snapshot()
                payload = json.dumps(snap)
                if payload != last:
                    yield f"event: status\ndata: {payload}\n\n"
                    last = payload
                else:
                    yield ": hb\n\n"
                await loop.run_in_executor(None, d.jobs.wait, 15.0)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache",
                                          "X-Accel-Buffering": "no"})

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str):
        job = d.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "no such job")
        return job.model_dump()

    @app.post("/jobs/{job_id}/cancel")
    def cancel_job(job_id: str):
        d.jobs.request_cancel(job_id)
        return {"ok": True}

    return app


def build_default_app() -> FastAPI:  # pragma: no cover — real entrypoint (needs CUDA)
    from .siglip import load_model
    config = Config.from_env()
    config.ensure()
    model = load_model(config.checkpoint, config.device)
    store = Store(calibrate=model.calibrate)
    registry = SourceRegistry(config.sources_json)
    jobs = Jobs()
    labels = LabelStore(os.path.join(config.data_dir, "labels"))
    # refresh availability (moved/unmounted folders) then hot-load existing sources
    maintenance.check_availability(registry)
    from . import shards
    for s in registry.list():
        blk = shards.load_block(config.embeddings_dir(s.id), s.id, s.fingerprint)
        if blk is not None:
            store.upsert_block(blk)
    return create_app(Deps(config=config, model=model, store=store,
                           registry=registry, jobs=jobs, labels=labels))
