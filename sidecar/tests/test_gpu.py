"""Unit tests for the GPU adaptation module — all CPU, no torch/CUDA required.

The real probing path (`autotune_batch` on a live GPU) is covered by the opt-in
`tests/gpu_smoke.py`; here we pin the pure selection logic, the cache, and env overrides.
"""

import json

import pytest

from satsearch_sidecar import gpu


# ---- choose_batch (pure selection) ---------------------------------------------
def test_choose_batch_picks_largest_that_fits():
    # everything up to 128 fits, 256+ does not
    got = gpu.choose_batch(gpu.CANDIDATES, fits=lambda bs: bs <= 128)
    assert got == 128


def test_choose_batch_all_fit_returns_max():
    got = gpu.choose_batch([8, 16, 32], fits=lambda bs: True)
    assert got == 32


def test_choose_batch_none_beyond_smallest():
    # even 16 doesn't fit → fall back to the smallest candidate
    got = gpu.choose_batch([8, 16, 32], fits=lambda bs: bs <= 8)
    assert got == 8


def test_choose_batch_stops_on_throughput_plateau():
    # everything fits, but throughput flattens after 32 → don't keep doubling
    tps = {8: 100.0, 16: 190.0, 32: 360.0, 64: 370.0, 128: 372.0}
    got = gpu.choose_batch([8, 16, 32, 64, 128], fits=lambda bs: True,
                           throughput=lambda bs: tps[bs], plateau=1.10)
    # 64 fits but only 1.03× of 32 (< 1.10) → stop, keep 64 as it still fit
    assert got == 64


def test_choose_batch_throughput_keeps_climbing():
    tps = {8: 100.0, 16: 200.0, 32: 400.0}
    got = gpu.choose_batch([8, 16, 32], fits=lambda bs: True,
                           throughput=lambda bs: tps[bs], plateau=1.10)
    assert got == 32


# ---- cache round-trip + invalidation -------------------------------------------
def test_cache_put_get_roundtrip(tmp_path):
    p = str(tmp_path / "autotune.json")
    gpu.cache_put(p, "k1", 512)
    assert gpu.cache_get(p, "k1") == 512
    # a second key coexists
    gpu.cache_put(p, "k2", 128)
    assert gpu.cache_get(p, "k1") == 512
    assert gpu.cache_get(p, "k2") == 128


def test_cache_miss_returns_none(tmp_path):
    p = str(tmp_path / "nope.json")
    assert gpu.cache_get(p, "k") is None
    gpu.cache_put(p, "k", 64)
    assert gpu.cache_get(p, "other") is None


def test_cache_key_changes_with_gpu_and_model():
    a = gpu.DeviceInfo("cuda", "RTX 3060", 6_000_000_000, 5_000_000_000, "8.6")
    b = gpu.DeviceInfo("cuda", "H200", 141_000_000_000, 140_000_000_000, "9.0")
    k_a = gpu._cache_key(a, "fp1", 256, "2.11")
    k_b = gpu._cache_key(b, "fp1", 256, "2.11")
    k_a2 = gpu._cache_key(a, "fp2", 256, "2.11")  # different model
    assert k_a != k_b and k_a != k_a2


def test_cache_survives_corrupt_file(tmp_path):
    p = tmp_path / "autotune.json"
    p.write_text("{ not json")
    assert gpu.cache_get(str(p), "k") is None
    gpu.cache_put(str(p), "k", 32)  # overwrites the garbage
    assert gpu.cache_get(str(p), "k") == 32


# ---- env overrides -------------------------------------------------------------
def test_env_int_precedence(monkeypatch):
    monkeypatch.setenv("SATSEARCH_BATCH", "256")
    assert gpu._env_int("SATSEARCH_BATCH") == 256
    monkeypatch.setenv("SATSEARCH_BATCH", "0")   # 0 ⇒ auto
    assert gpu._env_int("SATSEARCH_BATCH") is None
    monkeypatch.setenv("SATSEARCH_BATCH", "junk")
    assert gpu._env_int("SATSEARCH_BATCH") is None


def test_resolve_num_workers_override(monkeypatch):
    monkeypatch.setenv("SATSEARCH_NUM_WORKERS", "3")
    assert gpu.resolve_num_workers() == 3
    monkeypatch.delenv("SATSEARCH_NUM_WORKERS", raising=False)
    assert gpu.resolve_num_workers() >= 1  # auto, cpu-derived


def test_resolve_prefetch_default(monkeypatch):
    monkeypatch.delenv("SATSEARCH_PREFETCH", raising=False)
    assert gpu.resolve_prefetch() == 3
    monkeypatch.setenv("SATSEARCH_PREFETCH", "5")
    assert gpu.resolve_prefetch() == 5


# ---- describe / autotune without CUDA ------------------------------------------
def test_describe_device_cpu():
    info = gpu.describe_device("cpu")
    assert info.name == "cpu" and not info.is_cuda and info.vram_total is None


def test_autotune_env_override_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("SATSEARCH_BATCH", "777")

    class _M:
        fingerprint = "fp"

    got = gpu.autotune_batch(_M(), 256, "cuda", str(tmp_path / "c.json"))
    assert got == 777  # never touches CUDA


def test_autotune_cpu_returns_cpu_default(monkeypatch, tmp_path):
    monkeypatch.delenv("SATSEARCH_BATCH", raising=False)

    class _M:
        fingerprint = "fp"

    got = gpu.autotune_batch(_M(), 256, "cpu", str(tmp_path / "c.json"))
    assert got == gpu.CPU_BATCH
