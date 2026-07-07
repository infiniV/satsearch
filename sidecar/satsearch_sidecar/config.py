"""Runtime config: data-dir layout, token, model checkpoint (spec §3, §4)."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Config:
    data_dir: str
    token: str
    checkpoint: str = "google/siglip2-so400m-patch16-256"
    device: str = "cuda"

    @classmethod
    def from_env(cls) -> "Config":
        data_dir = os.environ.get("SATSEARCH_DATA_DIR", os.path.expanduser("~/.config/satsearch"))
        token = os.environ.get("SATSEARCH_TOKEN", "")
        checkpoint = os.environ.get("SATSEARCH_MODEL", "google/siglip2-so400m-patch16-256")
        device = os.environ.get("SATSEARCH_DEVICE", "cuda")
        return cls(data_dir=data_dir, token=token, checkpoint=checkpoint, device=device)

    @property
    def sources_json(self) -> str:
        return os.path.join(self.data_dir, "sources.json")

    def embeddings_dir(self, source_id: str) -> str:
        return os.path.join(self.data_dir, "embeddings", source_id)

    def ensure(self) -> None:
        os.makedirs(os.path.join(self.data_dir, "embeddings"), exist_ok=True)
