import logging
import time

from PIL import Image

from satsearch_sidecar import ingest
from satsearch_sidecar.logging_setup import PACKAGE_LOGGER, configure_logging

from .test_main import _auth, make_client


def test_configure_logging_is_idempotent():
    logger = configure_logging("DEBUG")
    n = len([h for h in logger.handlers if getattr(h, "_satsearch", False)])
    configure_logging("INFO")
    m = len([h for h in logger.handlers if getattr(h, "_satsearch", False)])
    assert n == 1 and m == 1  # no duplicate handlers on repeated calls
    assert logger.name == PACKAGE_LOGGER
    # restore default so we don't leak propagate=False into other tests
    logging.getLogger(PACKAGE_LOGGER).propagate = True


def test_enumerate_satimg_flat_logs_skipped(tmp_path, caplog):
    root = tmp_path / "city"
    root.mkdir()
    (root / "note.txt").write_text("x")  # non-ges → skipped and logged
    with caplog.at_level(logging.INFO, logger="satsearch_sidecar"):
        ingest.enumerate_satimg_flat(str(root))
    assert any("skipped" in r.message for r in caplog.records)


def test_ingest_worker_logs_exception_with_traceback(tmp_path, caplog):
    client, _cfg = make_client(tmp_path)
    imgs = tmp_path / "imgs"
    imgs.mkdir()
    Image.new("RGB", (4, 4)).save(imgs / "ok.jpg")
    (imgs / "broken.jpg").write_text("not really a jpeg")  # PIL.open().convert raises

    with caplog.at_level(logging.INFO, logger="satsearch_sidecar"):
        r = client.post("/sources", json={"kind": "plain", "path": str(imgs)},
                        headers=_auth())
        job_id = r.json()["jobId"]
        for _ in range(200):  # wait for the daemon worker thread to fail
            if client.get(f"/jobs/{job_id}", headers=_auth()).json()["state"] == "error":
                break
            time.sleep(0.02)

    failed = [r for r in caplog.records if "ingest worker failed" in r.message]
    assert failed, "worker exception should be logged"
    assert failed[0].exc_info is not None  # logger.exception attaches the traceback
