"""Content-hash sidecar version for the spawn/attach handshake (spec §4).

Both the running sidecar and Electron compute this over the sidecar source tree; an
app update that changes the source changes the hash, so Electron refuses to attach to a
stale process and respawns instead.
"""

from __future__ import annotations

import glob
import hashlib
import os


def compute_version(pkg_dir: str | None = None) -> str:
    pkg_dir = pkg_dir or os.path.dirname(__file__)
    h = hashlib.sha256()
    for path in sorted(glob.glob(os.path.join(pkg_dir, "*.py"))):
        h.update(os.path.basename(path).encode("utf-8"))
        h.update(b"\0")
        with open(path, "rb") as f:
            h.update(f.read())
        h.update(b"\0")
    return h.hexdigest()[:16]
