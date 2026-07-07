"""Labeling & gold-set export (spec §10).

Free-form classes + an append-only JSONL ledger keyed (source_id, tile). Current state
is the last record per key (replayed on load). Export materializes per-class tile copies
+ a manifest.
"""

from __future__ import annotations

import json
import os
import shutil

SCHEMA_VERSION = 1


def _key(source_id: str, tile: str) -> str:
    return f"{source_id}\x00{tile}"


class LabelStore:
    def __init__(self, labels_dir: str):
        self._dir = labels_dir
        os.makedirs(labels_dir, exist_ok=True)
        self._classes_path = os.path.join(labels_dir, "classes.json")
        self._ledger_path = os.path.join(labels_dir, "labels.jsonl")
        self._classes: set[str] = set()
        self._state: dict[str, dict] = {}  # key -> record
        self._load()

    # ---- persistence --------------------------------------------------------
    def _load(self) -> None:
        if os.path.exists(self._classes_path):
            with open(self._classes_path, encoding="utf-8") as f:
                self._classes = set(json.load(f).get("classes", []))
        if os.path.exists(self._ledger_path):
            with open(self._ledger_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    rec = json.loads(line)
                    k = _key(rec["source_id"], rec["tile"])
                    if rec.get("label") is None:
                        self._state.pop(k, None)
                    else:
                        self._state[k] = rec

    def _save_classes(self) -> None:
        with open(self._classes_path, "w", encoding="utf-8") as f:
            json.dump({"schemaVersion": SCHEMA_VERSION, "classes": sorted(self._classes)}, f)

    def _append(self, rec: dict) -> None:
        with open(self._ledger_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"schemaVersion": SCHEMA_VERSION, **rec}, ensure_ascii=False) + "\n")

    # ---- classes ------------------------------------------------------------
    def add_class(self, name: str) -> None:
        self._classes.add(name)
        self._save_classes()

    def classes_with_counts(self) -> list[dict]:
        counts: dict[str, int] = {c: 0 for c in self._classes}
        for rec in self._state.values():
            counts[rec["label"]] = counts.get(rec["label"], 0) + 1
        return [{"name": n, "count": counts.get(n, 0)} for n in sorted(counts)]

    def rename_class(self, old: str, new: str, ts: str) -> None:
        if old not in self._classes and not any(r["label"] == old for r in self._state.values()):
            raise KeyError(old)
        self._classes.discard(old)
        self._classes.add(new)
        self._save_classes()
        for k, rec in list(self._state.items()):
            if rec["label"] == old:
                self.set_label(rec["source_id"], rec["tile"], new, ts)

    def delete_class(self, name: str) -> None:
        if any(r["label"] == name for r in self._state.values()):
            raise ValueError(f"class '{name}' still has labeled tiles")
        self._classes.discard(name)
        self._save_classes()

    # ---- labels -------------------------------------------------------------
    def set_label(self, source_id: str, tile: str, label: str, ts: str,
                  provenance: dict | None = None) -> dict:
        self._classes.add(label)
        self._save_classes()
        rec = {"source_id": source_id, "tile": tile, "label": label, "at": ts,
               **(provenance or {})}
        self._append(rec)
        self._state[_key(source_id, tile)] = rec
        return rec

    def del_label(self, source_id: str, tile: str, ts: str) -> bool:
        k = _key(source_id, tile)
        existed = k in self._state
        if existed:
            self._append({"source_id": source_id, "tile": tile, "label": None, "at": ts})
            self._state.pop(k, None)
        return existed

    def state_for(self, keys: list[tuple[str, str]]) -> dict:
        want = {_key(s, t) for (s, t) in keys}
        return {k: rec["label"] for k, rec in self._state.items() if k in want}

    def list_labeled(self, cls: str | None = None) -> list[dict]:
        return [r for r in self._state.values() if cls is None or r["label"] == cls]

    # ---- export -------------------------------------------------------------
    def export(self, dest: str, resolver) -> dict:
        os.makedirs(dest, exist_ok=True)
        manifest_path = os.path.join(dest, "manifest.jsonl")
        count = 0
        with open(manifest_path, "w", encoding="utf-8") as mf:
            for rec in self._state.values():
                src_path = resolver(rec["source_id"], rec["tile"])
                if not src_path or not os.path.exists(src_path):
                    continue
                cls_dir = os.path.join(dest, rec["label"])
                os.makedirs(cls_dir, exist_ok=True)
                safe = rec["tile"].replace("/", "_").replace("\\", "_")
                out_name = f"{rec['source_id']}__{safe}"
                shutil.copy2(src_path, os.path.join(cls_dir, out_name))
                mf.write(json.dumps({**rec, "file": os.path.join(rec["label"], out_name)},
                                    ensure_ascii=False) + "\n")
                count += 1
        return {"classes": sorted(self._classes), "count": count, "dest": dest}
