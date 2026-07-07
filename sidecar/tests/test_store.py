import threading

import numpy as np
import pytest

from satsearch_sidecar.store import Block, Store


def _norm(x):
    x = np.asarray(x, dtype=np.float32)
    return x / (np.linalg.norm(x, axis=-1, keepdims=True) + 1e-12)


def make_block(source_id, fp, vecs, names):
    m = _norm(vecs).astype(np.float16)
    return Block(source_id=source_id, fingerprint=fp, matrix=m, names=tuple(names))


def identity_store():
    # calibrate = identity so score == cosine (easy to reason about)
    return Store(calibrate=lambda c: c, cache_cap=8, k=5000, block_rows=2)


def test_matvec_matches_direct_fp32():
    rng = np.random.default_rng(0)
    vecs = rng.standard_normal((7, 1152)).astype(np.float32)
    names = [f"t{i}" for i in range(7)]
    st = identity_store()
    st.swap([make_block("s", "fp", vecs, names)])
    q = _norm(rng.standard_normal(1152))[0] if False else _norm(rng.standard_normal((1, 1152)))[0]
    res = st.search(q, active_fp="fp", limit=7, query_hash="q")
    # reference: normalized fp16 corpus dot normalized q
    ref = _norm(vecs).astype(np.float16).astype(np.float32) @ q
    got = {r["name"]: r["score"] for r in res["results"]}
    for i, n in enumerate(names):
        assert got[n] == pytest.approx(float(ref[i]), abs=1e-3)


def test_ranking_matches_bruteforce_with_real_calibration():
    """Top-K set, order, and scores must match a brute-force reference even when
    calibrate is a real (non-identity) monotonic sigmoid — guards the raw-cosine
    ranking + calibrate-only-K optimization."""
    def calibrate(c):
        c = np.asarray(c, dtype=np.float32)
        return 1.0 / (1.0 + np.exp(-(4.0 * c - 1.0)))

    rng = np.random.default_rng(7)
    n_a, n_b, d, k = 30, 25, 1152, 10
    va = rng.standard_normal((n_a, d)).astype(np.float32)
    vb = rng.standard_normal((n_b, d)).astype(np.float32)
    st = Store(calibrate=calibrate, cache_cap=8, k=k, block_rows=4)
    st.swap([make_block("a", "fp", va, [f"a{i}" for i in range(n_a)]),
             make_block("b", "fp", vb, [f"b{i}" for i in range(n_b)])])

    q = _norm(rng.standard_normal((1, d)))[0]
    res = st.search(q, active_fp="fp", limit=k, query_hash="q")

    # brute-force reference: fp16 corpus upcast → cosine → calibrate → deterministic sort
    corpus = np.concatenate([_norm(va).astype(np.float16), _norm(vb).astype(np.float16)])
    meta = [("a", f"a{i}") for i in range(n_a)] + [("b", f"b{i}") for i in range(n_b)]
    cos = corpus.astype(np.float32) @ q
    prob = calibrate(cos)
    ref = sorted(range(len(meta)), key=lambda i: (-float(prob[i]), meta[i][0], meta[i][1]))[:k]

    got = [(r["source_id"], r["name"]) for r in res["results"]]
    assert got == [meta[i] for i in ref]                       # identical order + set
    for r, i in zip(res["results"], ref):
        assert r["score"] == pytest.approx(float(prob[i]), abs=1e-6)  # calibrated score
    assert res["total"] == n_a + n_b


def test_blocked_matvec_threaded_equals_serial():
    """The multi-threaded span split must be bit-identical to a single-span pass."""
    rng = np.random.default_rng(3)
    n, d = 40_000, 1152  # > MATVEC_THREAD_MIN_ROWS so the threaded path engages
    m = _norm(rng.standard_normal((n, d))).astype(np.float16)
    q = _norm(rng.standard_normal((1, d)))[0]
    st = Store(calibrate=lambda c: c, block_rows=2048)
    st._matvec_workers = 1
    serial = st._blocked_matvec(m, q)
    st._matvec_workers = 8
    threaded = st._blocked_matvec(m, q)
    assert np.array_equal(serial, threaded)      # exact, not approximate
    ref = m.astype(np.float32) @ q
    assert np.allclose(threaded, ref, atol=1e-3)


def test_tiles_for_returns_block_rows_with_relpaths():
    st = identity_store()
    b = Block(source_id="s", fingerprint="fp",
              matrix=_norm(np.eye(3, 1152)).astype(np.float16),
              names=("n0", "n1", "n2"), rel_paths=("r0", "r1", "r2"))
    st.swap([b, make_block("other", "fp", np.eye(2, 1152), ["x", "y"])])
    assert st.tiles_for("s") == [("n0", "r0"), ("n1", "r1"), ("n2", "r2")]
    assert st.tiles_for("missing") == []


def test_fingerprint_gating_excludes_mismatched_block():
    st = identity_store()
    st.swap([
        make_block("a", "fpA", np.eye(3, 1152), ["a0", "a1", "a2"]),
        make_block("b", "fpB", np.eye(3, 1152), ["b0", "b1", "b2"]),
    ])
    res = st.search(np.eye(1, 1152)[0], active_fp="fpA", limit=10, query_hash="q")
    srcs = {r["source_id"] for r in res["results"]}
    assert srcs == {"a"}
    assert res["total"] == 3  # only fpA rows are candidates


def test_topk_sorted_desc_with_tiebreak():
    st = identity_store()
    # two sources share identical vectors → identical scores → tiebreak on (source,name)
    v = np.tile(np.eye(1, 1152), (2, 1))
    st.swap([
        make_block("z", "fp", v, ["n1", "n0"]),
        make_block("a", "fp", v, ["n0", "n1"]),
    ])
    res = st.search(np.eye(1, 1152)[0], active_fp="fp", limit=10, query_hash="q")
    order = [(r["source_id"], r["name"]) for r in res["results"]]
    assert order == sorted(order)  # deterministic (source_id, name) tiebreak


def test_score_floor_trims_tail():
    st = identity_store()
    vecs = np.array([[1.0] + [0.0] * 1151, [0.7] + [0.7] + [0.0] * 1150, [0.0, 1.0] + [0.0] * 1150])
    st.swap([make_block("s", "fp", vecs, ["hi", "mid", "lo"])])
    res = st.search(np.eye(1, 1152)[0], active_fp="fp", min_score=0.5, limit=10, query_hash="q")
    names = [r["name"] for r in res["results"]]
    assert "lo" not in names and "hi" in names


def test_ceiling_below_window_flags_empty():
    st = identity_store()
    vecs = np.array([[1.0] + [0.0] * 1151, [0.9] + [0.1] + [0.0] * 1150])
    st.swap([make_block("s", "fp", vecs, ["a", "b"])])
    res = st.search(np.eye(1, 1152)[0], active_fp="fp", max_score=-1.0, limit=10, query_hash="q")
    assert res["results"] == []
    assert res["below_window"] is True
    assert res["total"] == 2  # candidates still counted


def test_find_similar_self_exclude():
    st = identity_store()
    vecs = np.eye(3, 1152)
    st.swap([make_block("s", "fp", vecs, ["a", "b", "c"])])
    v = st.vector_for("s", "a")
    assert v is not None
    res = st.search(v, active_fp="fp", limit=10, query_hash="ref", exclude=("s", "a"))
    names = [r["name"] for r in res["results"]]
    assert "a" not in names


def test_total_is_source_filtered_count():
    st = identity_store()
    st.swap([
        make_block("a", "fp", np.eye(4, 1152), ["a0", "a1", "a2", "a3"]),
        make_block("b", "fp", np.eye(2, 1152), ["b0", "b1"]),
    ])
    res = st.search(np.eye(1, 1152)[0], active_fp="fp", source_ids=["a"], limit=10, query_hash="q")
    assert res["total"] == 4


def test_swap_during_search_no_corruption():
    st = identity_store()
    big = np.random.default_rng(1).standard_normal((2000, 1152))
    st.swap([make_block("s", "fp", big, [f"t{i}" for i in range(2000)])])
    errors = []

    def searcher():
        try:
            for _ in range(50):
                r = st.search(np.eye(1, 1152)[0], active_fp="fp", limit=20, query_hash=None)
                assert len(r["results"]) == 20
        except Exception as e:  # pragma: no cover
            errors.append(e)

    def swapper():
        for i in range(50):
            st.swap([make_block("s", "fp", big, [f"t{j}" for j in range(2000)])])

    ts = [threading.Thread(target=searcher) for _ in range(4)] + [threading.Thread(target=swapper)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errors


def test_snapshot_id_changes_on_swap():
    st = identity_store()
    id1 = st.swap([make_block("s", "fp", np.eye(2, 1152), ["a", "b"])])
    id2 = st.swap([make_block("s", "fp", np.eye(2, 1152), ["a", "b"])])
    assert id1 != id2


def test_search_reports_effective_k():
    st = identity_store()  # k=5000
    st.swap([make_block("s", "fp", np.eye(4, 1152), [f"t{i}" for i in range(4)])])
    res = st.search(_norm(np.ones((1, 1152)))[0], active_fp="fp", limit=10, query_hash="q")
    assert res["k"] == 5000


def test_small_k_truncates_ranked_but_reports_full_total():
    from satsearch_sidecar.store import Store
    st = Store(calibrate=lambda c: c, cache_cap=8, k=3, block_rows=2)
    vecs = np.random.default_rng(0).standard_normal((10, 1152))
    st.swap([make_block("s", "fp", vecs, [f"t{i}" for i in range(10)])])
    res = st.search(_norm(np.random.default_rng(1).standard_normal((1, 1152)))[0],
                    active_fp="fp", limit=100, query_hash="q")
    assert len(res["results"]) == 3      # ranked list capped at k
    assert res["total"] == 10            # but total = full candidate count
    assert res["k"] == 3


def test_set_k_clamps_and_clears_cache():
    from satsearch_sidecar.store import Store, K_MIN, K_MAX
    st = identity_store()
    st.swap([make_block("s", "fp", np.eye(4, 1152), [f"t{i}" for i in range(4)])])
    st.search(_norm(np.ones((1, 1152)))[0], active_fp="fp", limit=4, query_hash="q")
    assert len(st._cache) == 1
    st.set_k(10)             # below floor
    assert st.k == K_MIN
    assert len(st._cache) == 0
    st.set_k(10**9)          # above ceiling
    assert st.k == K_MAX
