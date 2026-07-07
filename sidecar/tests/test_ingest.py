import numpy as np
from PIL import Image

from satsearch_sidecar import ingest
from satsearch_sidecar.jobs import Jobs
from satsearch_sidecar.siglip import Model
from satsearch_sidecar.sources import Source
from satsearch_sidecar.store import Store


class FakeBackend:
    dims = 8
    device = "cpu"
    logit_scale = 1.0
    logit_bias = 0.0

    def encode_images(self, pils):
        return np.random.default_rng(0).standard_normal((len(pils), self.dims)).astype(np.float32)

    def encode_text(self, text):
        return np.ones(self.dims, dtype=np.float32)


def _make_xyz(root, zlevels):
    """Create a tiny XYZ pyramid: root/{z}/{x}/{y}.jpg for given zoom levels."""
    for z in zlevels:
        for x in range(2):
            for y in range(2):
                d = root / str(z) / str(x)
                d.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (4, 4), (z % 256, x, y)).save(d / f"{y}.jpg")


def test_enumerate_xyz_picks_embed_zoom_only(tmp_path):
    root = tmp_path / "pyr"
    _make_xyz(root, [17, 18])
    entries = ingest.enumerate_xyz(str(root))
    zs = {z for (_n, _p, z, _x, _y) in entries}
    assert zs == {17, 18}
    embed_zoom = ingest.pick_embed_zoom(entries)
    assert embed_zoom == 18
    at_zoom = ingest.filter_zoom(entries, embed_zoom)
    assert all(z == 18 for (_n, _p, z, _x, _y) in at_zoom)
    assert len(at_zoom) == 4  # 2x2 tiles at z18


def test_enumerate_plain(tmp_path):
    root = tmp_path / "imgs"
    (root / "sub").mkdir(parents=True)
    Image.new("RGB", (4, 4)).save(root / "a.jpg")
    Image.new("RGB", (4, 4)).save(root / "sub" / "b.png")
    entries = ingest.enumerate_plain(str(root))
    names = sorted(n for (n, _p) in entries)
    assert names == ["a.jpg", "sub/b.png"]


def test_run_ingest_plain_end_to_end(tmp_path):
    root = tmp_path / "imgs"
    root.mkdir()
    for i in range(5):
        Image.new("RGB", (4, 4)).save(root / f"{i}.jpg")
    model = Model(FakeBackend(), "fp")
    store = Store(calibrate=model.calibrate)
    jobs = Jobs()
    emb_dir = tmp_path / "emb"
    src = Source(id="s", label="s", kind="plain", rootPath=str(root),
                 projection="none", fingerprint="fp")
    ingest.run_ingest(src, model, store, jobs, str(emb_dir), job_id="j1", batch_size=2)
    job = jobs.get("j1")
    assert job.state == "done"
    assert job.done == 5
    # searchable
    res = store.search(np.ones(8, np.float32), active_fp="fp", limit=10, query_hash="q")
    assert res["total"] == 5


def test_run_ingest_resumes(tmp_path):
    root = tmp_path / "imgs"
    root.mkdir()
    for i in range(4):
        Image.new("RGB", (4, 4)).save(root / f"{i}.jpg")
    model = Model(FakeBackend(), "fp")
    store = Store(calibrate=model.calibrate)
    jobs = Jobs()
    emb_dir = tmp_path / "emb"
    src = Source(id="s", label="s", kind="plain", rootPath=str(root),
                 projection="none", fingerprint="fp")
    ingest.run_ingest(src, model, store, jobs, str(emb_dir), job_id="j1", batch_size=2)
    # second run should resume: nothing new, job marked done and resumed
    ingest.run_ingest(src, model, store, jobs, str(emb_dir), job_id="j2", batch_size=2)
    job = jobs.get("j2")
    assert job.state == "done"
    assert job.resumed is True


def test_run_ingest_cancel_hot_loads_partial(tmp_path):
    root = tmp_path / "imgs"
    root.mkdir()
    for i in range(10):
        Image.new("RGB", (4, 4)).save(root / f"{i:02d}.jpg")
    model = Model(FakeBackend(), "fp")
    store = Store(calibrate=model.calibrate)
    jobs = Jobs()
    jobs.create("j1", "s", "ingest", total=10)
    jobs.request_cancel("j1")  # cancel before it starts → first batch flush then stop
    emb_dir = tmp_path / "emb"
    src = Source(id="s", label="s", kind="plain", rootPath=str(root),
                 projection="none", fingerprint="fp")
    ingest.run_ingest(src, model, store, jobs, str(emb_dir), job_id="j1", batch_size=3)
    job = jobs.get("j1")
    assert job.state == "cancelled"
    # partial is hot-loaded and searchable (< 10)
    res = store.search(np.ones(8, np.float32), active_fp="fp", limit=100, query_hash="q")
    assert 0 < res["total"] < 10


def _make_ges(root, n=4):
    root.mkdir(parents=True, exist_ok=True)
    for i in range(n):
        Image.new("RGB", (4, 4), (i, 0, 0)).save(root / f"ges_{100 + i}_{200 + i}_20.jpg")
    Image.new("RGB", (4, 4), (0, 0, 0)).save(root / "note.jpg")  # non-ges → skipped


def test_enumerate_satimg_flat_parses_coords(tmp_path):
    from satsearch_sidecar import tiles
    from satsearch_sidecar.satimg_layout import GES_LAYOUT
    root = tmp_path / "lahore"
    _make_ges(root, 4)
    rows = ingest.enumerate_satimg_flat(str(root))
    assert len(rows) == 4  # the non-ges file is skipped
    name, rel, x, y, z = rows[0]
    assert name == rel and name.startswith("ges_")
    xfile, yfile, zfile = (int(p) for p in name[4:-4].split("_"))
    assert (z, x, y) == tiles.xyz_from_filename(GES_LAYOUT, "geodetic", xfile, yfile, zfile)


def test_rows_for_source_dispatches_satimg(tmp_path):
    root = tmp_path / "kar"
    _make_ges(root, 3)
    src = Source(id="s", label="s", kind="satimg-import", rootPath=str(root),
                 hasGeo=True, projection="geodetic", fingerprint="fp")
    rows, embed_zoom = ingest._rows_for_source(src)
    assert embed_zoom is None and len(rows) == 3
    assert all(len(r) == 5 for r in rows)  # (name, rel, x, y, z)
