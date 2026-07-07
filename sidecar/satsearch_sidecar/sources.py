"""Source registry (spec §3, §7). Persisted as sources.json with schemaVersion.

The `Source` model mirrors src/shared/types.ts exactly so the Electron and sidecar
contracts stay in lockstep.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Literal, Optional

from pydantic import BaseModel

SCHEMA_VERSION = 1

SourceKind = Literal["xyz", "plain", "satimg-import"]
Projection = Literal["web-mercator", "geodetic", "none"]
Availability = Literal["available", "unavailable", "incompatible", "interrupted"]


class TileLayout(BaseModel):
    template: str
    ext: str
    zOffset: int = 0
    yScheme: Literal["xyz", "tms"] = "xyz"


class Source(BaseModel):
    id: str
    label: str
    kind: SourceKind
    rootPath: str
    tileCount: int = 0
    hasGeo: bool = False
    projection: Projection = "none"
    minZoom: Optional[int] = None
    maxZoom: Optional[int] = None
    embedZoom: Optional[int] = None
    tileLayout: Optional[TileLayout] = None
    fingerprint: str = ""
    attested: bool = False
    availability: Availability = "available"
    active: bool = True
    rev: int = 0
    createdAt: str = ""


class SourceRegistry:
    def __init__(self, path: str):
        self._path = path
        self._lock = threading.Lock()
        self._sources: dict[str, Source] = {}
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self._path):
            return
        with open(self._path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for raw in data.get("sources", []):
            s = Source(**raw)
            self._sources[s.id] = s

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self._path) or ".", exist_ok=True)
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "sources": [s.model_dump() for s in self._sources.values()],
        }
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self._path)

    def add(self, source: Source) -> None:
        with self._lock:
            self._sources[source.id] = source
            self._save()

    def get(self, source_id: str) -> Optional[Source]:
        return self._sources.get(source_id)

    def list(self) -> list[Source]:
        return list(self._sources.values())

    def delete(self, source_id: str) -> bool:
        with self._lock:
            existed = self._sources.pop(source_id, None) is not None
            if existed:
                self._save()
            return existed

    def bump_rev(self, source_id: str) -> None:
        with self._lock:
            s = self._sources.get(source_id)
            if s is not None:
                s.rev += 1
                self._save()

    def set_availability(self, source_id: str, availability: Availability) -> None:
        self.patch(source_id, availability=availability)

    def patch(self, source_id: str, **fields) -> None:
        with self._lock:
            s = self._sources.get(source_id)
            if s is not None:
                for k, v in fields.items():
                    setattr(s, k, v)
                self._save()
