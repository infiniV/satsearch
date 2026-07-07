import os
import time

from PIL import Image

from satsearch_sidecar import ingest, maintenance
from satsearch_sidecar.jobs import Jobs
from satsearch_sidecar.siglip import Model
from satsearch_sidecar.sources import Source, SourceRegistry
from satsearch_sidecar.store import Store
import numpy as np


class FakeBackend:
    dims = 8
    device = "cpu"
    logit_scale = 1.0
    logit_bias = 0.0

    def encode_images(self, pils):
        return np.random.default_rng(3).standard_normal((len(pils), self.dims)).astype(np.float32)

    def encode_text(self, text):
        return np.ones(self.dims, dtype=np.float32)


def test_check_availability(tmp_path):
    reg = SourceRegistry(str(tmp_path / "sources.json"))
    missing = str(tmp_path / "gone")
    reg.add(Source(id="s", label="s", kind="plain", rootPath=missing,
                   projection="none", fingerprint="fp", availability="available"))
    changed = maintenance.check_availability(reg)
    assert changed == ["s"]
    assert reg.get("s").availability == "unavailable"
    # create the dir -> back to available
    os.makedirs(missing)
    assert maintenance.check_availability(reg) == ["s"]
    assert reg.get("s").availability == "available"


def test_reconcile_detects_add_remove_edit(tmp_path):
    root = tmp_path / "imgs"
    root.mkdir()
    for i in range(3):
        Image.new("RGB", (4, 4), (i, 0, 0)).save(root / f"{i}.jpg")
    model = Model(FakeBackend(), "fp")
    store = Store(calibrate=model.calibrate)
    jobs = Jobs()
    emb_dir = str(tmp_path / "emb")
    src = Source(id="s", label="s", kind="plain", rootPath=str(root),
                 projection="none", fingerprint="fp")
    ingest.run_ingest(src, model, store, jobs, emb_dir, job_id="j", batch_size=2)

    # add one, remove one, edit one (noise image -> clearly different byte size)
    Image.new("RGB", (4, 4)).save(root / "new.jpg")
    os.remove(root / "0.jpg")
    noise = (np.random.default_rng(9).integers(0, 255, (128, 128, 3))).astype("uint8")
    Image.fromarray(noise).save(root / "1.jpg")  # KB-scale vs the original tiny tile

    diff = maintenance.reconcile_diff(src, emb_dir)
    assert "new.jpg" in diff["added"]
    assert "0.jpg" in diff["removed"]
    assert "1.jpg" in diff["changed"]
    assert diff["counts"]["added"] == 1
