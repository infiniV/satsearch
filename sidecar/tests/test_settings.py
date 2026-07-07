from satsearch_sidecar.settings import AppSettings
from satsearch_sidecar.store import K_DEFAULT, K_MIN, K_MAX


def test_defaults_when_no_file(tmp_path):
    s = AppSettings(str(tmp_path / "settings.json"))
    assert s.search_k == K_DEFAULT


def test_set_persists_and_reloads(tmp_path):
    path = str(tmp_path / "settings.json")
    AppSettings(path).set_search_k(20000)
    assert AppSettings(path).search_k == 20000


def test_set_clamps(tmp_path):
    s = AppSettings(str(tmp_path / "settings.json"))
    assert s.set_search_k(10**9) == K_MAX
    assert s.set_search_k(0) == K_MIN


def test_corrupt_file_falls_back_to_default(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text("{not json")
    assert AppSettings(str(path)).search_k == K_DEFAULT
