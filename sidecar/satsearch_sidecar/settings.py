"""User-editable app settings persisted to settings.json in the data dir.

v1 holds a single knob: searchK (the ranked-list depth). Load is tolerant — a
missing or corrupt file falls back to defaults rather than crashing startup.
"""

from __future__ import annotations

import json
import os

from .store import K_DEFAULT, K_MIN, K_MAX

SCHEMA_VERSION = 1


class AppSettings:
    def __init__(self, path: str):
        self._path = path
        self._search_k = K_DEFAULT
        self._load()

    def _load(self) -> None:
        try:
            with open(self._path, encoding="utf-8") as f:
                data = json.load(f)
            self._search_k = self._clamp(data.get("searchK", K_DEFAULT))
        except (OSError, ValueError, TypeError):
            self._search_k = K_DEFAULT

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        with open(self._path, "w", encoding="utf-8") as f:
            json.dump({"schemaVersion": SCHEMA_VERSION, "searchK": self._search_k}, f)

    @staticmethod
    def _clamp(k) -> int:
        return max(K_MIN, min(K_MAX, int(k)))

    @property
    def search_k(self) -> int:
        return self._search_k

    def set_search_k(self, k: int) -> int:
        self._search_k = self._clamp(k)
        self._save()
        return self._search_k
