"""Live boot smoke test: start the REAL uvicorn server (not TestClient) with a CPU
fake model, then drive it over HTTP end-to-end. Run: uv run python tests/live_smoke.py"""
import os
import tempfile
import threading
import time

import numpy as np
import uvicorn
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
        return np.random.default_rng(7).standard_normal((len(pils), self.dims)).astype(np.float32)

    def encode_text(self, text):
        return np.ones(self.dims, dtype=np.float32)


def main():
    import urllib.request
    import urllib.error
    import json

    tmp = tempfile.mkdtemp()
    cfg = Config(data_dir=os.path.join(tmp, "data"), token="live-tok", device="cpu")
    cfg.ensure()
    imgs = os.path.join(tmp, "imgs")
    os.makedirs(imgs)
    for i in range(6):
        Image.new("RGB", (8, 8), (i * 10, 0, 0)).save(os.path.join(imgs, f"{i}.jpg"))

    model = Model(FakeBackend(), "fp-live")
    deps = Deps(config=cfg, model=model, store=Store(calibrate=model.calibrate),
                registry=SourceRegistry(cfg.sources_json), jobs=Jobs(), labels=LabelStore(os.path.join(tmp, 'labels')))
    app = create_app(deps)

    port = 8731
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()

    def call(method, path, data=None, headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                     data=data, headers=headers or {})
        req.add_header("Authorization", "Bearer live-tok")
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode())

    # wait for boot
    for _ in range(100):
        try:
            s, _ = call("GET", "/health")
            if s == 200:
                break
        except Exception:
            time.sleep(0.05)

    ok = True

    # 1) health
    s, body = call("GET", "/health")
    print(f"health: {s} device={body['device']} dims={body['dims']} fp={body['fingerprint']}")
    ok &= s == 200 and body["ready"] is True

    # 2) 401 without token
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5)
        print("FAIL: unauth request succeeded")
        ok = False
    except urllib.error.HTTPError as e:
        print(f"unauth health -> {e.code} (expected 401)")
        ok &= e.code == 401

    # 3) add plain source
    payload = json.dumps({"kind": "plain", "path": imgs}).encode()
    s, body = call("POST", "/sources", data=payload,
                   headers={"content-type": "application/json"})
    job_id = body["jobId"]
    print(f"add source: {s} job={job_id}")

    # 4) poll job
    for _ in range(200):
        s, job = call("GET", f"/jobs/{job_id}")
        if job["state"] == "done":
            break
        time.sleep(0.02)
    print(f"ingest: state={job['state']} done={job['done']}/{job['total']}")
    ok &= job["state"] == "done" and job["done"] == 6

    # 5) search (multipart)
    import io
    boundary = "----live"
    body_bytes = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"query\"\r\n\r\nkiln\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"limit\"\r\n\r\n50\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    s, res = call("POST", "/search", data=body_bytes,
                  headers={"content-type": f"multipart/form-data; boundary={boundary}"})
    print(f"search: {s} total={res['total']} returned={len(res['results'])} "
          f"thumb0={res['results'][0]['thumbUrl'] if res['results'] else None}")
    ok &= s == 200 and res["total"] == 6 and len(res["results"]) == 6
    ok &= res["results"][0]["thumbUrl"].startswith("app://thumb/")

    print("\nLIVE SMOKE:", "PASS" if ok else "FAIL")
    import sys
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0 if ok else 1)


if __name__ == "__main__":
    main()
