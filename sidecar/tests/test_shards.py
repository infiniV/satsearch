import numpy as np
import pandas as pd

from satsearch_sidecar import shards


def _meta(names):
    return pd.DataFrame({"name": names, "rel_path": names,
                         "mtime": [0] * len(names), "size": [0] * len(names)})


def test_write_then_scan_complete(tmp_path):
    d = tmp_path / "src"
    d.mkdir()
    shards.write_shard(str(d), 0, np.zeros((3, 4), np.float16), _meta(["a", "b", "c"]))
    done, nxt = shards.scan_complete(str(d))
    assert done == {"a", "b", "c"}
    assert nxt == 1


def test_npy_without_parquet_is_ignored(tmp_path):
    d = tmp_path / "src"
    d.mkdir()
    shards.write_shard(str(d), 0, np.zeros((2, 4), np.float16), _meta(["a", "b"]))
    # simulate a crashed half-write: an emb_ with no matching parquet
    np.save(str(d / "emb_0001.npy"), np.zeros((2, 4), np.float16))
    done, nxt = shards.scan_complete(str(d))
    assert done == {"a", "b"}
    assert nxt == 1  # 0001 ignored (no parquet)


def test_rowcount_mismatch_dropped(tmp_path):
    d = tmp_path / "src"
    d.mkdir()
    np.save(str(d / "emb_0000.npy"), np.zeros((3, 4), np.float16))
    _meta(["a", "b"]).to_parquet(str(d / "meta_0000.parquet"))  # 2 rows vs 3 emb
    done, nxt = shards.scan_complete(str(d))
    assert done == set()
    assert nxt == 0


def test_next_idx_continues_after_highest(tmp_path):
    d = tmp_path / "src"
    d.mkdir()
    shards.write_shard(str(d), 0, np.zeros((1, 4), np.float16), _meta(["a"]))
    shards.write_shard(str(d), 1, np.zeros((1, 4), np.float16), _meta(["b"]))
    done, nxt = shards.scan_complete(str(d))
    assert done == {"a", "b"}
    assert nxt == 2


def test_load_block(tmp_path):
    d = tmp_path / "src"
    d.mkdir()
    shards.write_shard(str(d), 0, np.ones((2, 4), np.float16), _meta(["a", "b"]))
    block = shards.load_block(str(d), source_id="src", fingerprint="fp")
    assert block.matrix.shape == (2, 4)
    assert block.names == ("a", "b")
    assert block.source_id == "src" and block.fingerprint == "fp"
