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
    log_level: str = "INFO"

    @classmethod
    def from_env(cls) -> "Config":
        data_dir = os.environ.get("SATSEARCH_DATA_DIR", os.path.expanduser("~/.config/satsearch"))
        token = os.environ.get("SATSEARCH_TOKEN", "")
        checkpoint = os.environ.get("SATSEARCH_MODEL", "google/siglip2-so400m-patch16-256")
        device = os.environ.get("SATSEARCH_DEVICE", "cuda")
        log_level = os.environ.get("SATSEARCH_LOG_LEVEL", "INFO")
        return cls(data_dir=data_dir, token=token, checkpoint=checkpoint, device=device,
                   log_level=log_level)

    @property
    def sources_json(self) -> str:
        return os.path.join(self.data_dir, "sources.json")

    @property
    def throughput_json(self) -> str:
        """Learned embedding throughput (tiles/s) per device — feeds import time estimates."""
        return os.path.join(self.data_dir, "throughput.json")

    def embeddings_dir(self, source_id: str) -> str:
        return os.path.join(self.data_dir, "embeddings", source_id)

    def ensure(self) -> None:
        os.makedirs(os.path.join(self.data_dir, "embeddings"), exist_ok=True)
