"""Job registry + change signal for the SSE stream (spec §7).

Thread-safe: ingest runs on a background thread and calls update(); the async SSE
endpoint waits on `changed` and reads snapshot(). Cancellation is a flag checked by
the worker between batches. Source-mutation events piggyback on the same stream.
"""

from __future__ import annotations

import threading
import time
from typing import Literal, Optional

from pydantic import BaseModel

JobKind = Literal["ingest", "import", "reembed"]
JobState = Literal["running", "done", "error", "cancelled"]
Mutation = Literal["add", "import", "delete", "relink", "reembed"]


class Job(BaseModel):
    id: str
    sourceId: str
    kind: JobKind
    state: JobState = "running"
    done: int = 0
    total: int = 0
    error: Optional[str] = None
    resumed: bool = False
    snapshotId: Optional[str] = None
    # Most-recently embedded tile (sourceId, rel_path) — drives the live preview
    # thumbnail in the ingest UI. None until the first batch completes.
    current: Optional[str] = None
    # Live embedding throughput (tiles/second), refreshed on the progress cadence.
    tilesPerSec: Optional[float] = None


class SourceMutationEvent(BaseModel):
    sourceId: str
    mutation: Mutation
    snapshotId: str


class Jobs:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._cancel: set[str] = set()
        self._mutations: list[SourceMutationEvent] = []
        self._changed = threading.Event()

    def _touch(self):
        self._changed.set()

    def create(self, job_id: str, source_id: str, kind: JobKind, total: int,
               resumed: bool = False) -> Job:
        with self._lock:
            job = Job(id=job_id, sourceId=source_id, kind=kind, total=total,
                      done=0, state="running", resumed=resumed)
            self._jobs[job_id] = job
            self._cancel.discard(job_id)
            self._touch()
            return job

    def update(self, job_id: str, **fields) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for k, v in fields.items():
                setattr(job, k, v)
            self._touch()

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        return list(self._jobs.values())

    def request_cancel(self, job_id: str) -> None:
        with self._lock:
            self._cancel.add(job_id)
            self._touch()

    def is_cancelled(self, job_id: str) -> bool:
        return job_id in self._cancel

    def push_mutation(self, source_id: str, mutation: Mutation, snapshot_id: str) -> None:
        with self._lock:
            self._mutations.append(
                SourceMutationEvent(sourceId=source_id, mutation=mutation,
                                    snapshotId=snapshot_id))
            self._touch()

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "jobs": [j.model_dump() for j in self._jobs.values()],
                "mutations": [m.model_dump() for m in self._mutations[-50:]],
            }

    def wait(self, timeout: float) -> bool:
        fired = self._changed.wait(timeout)
        if fired:
            self._changed.clear()
        return fired

    def new_job_id(self) -> str:
        return f"job-{int(time.monotonic_ns())}"
