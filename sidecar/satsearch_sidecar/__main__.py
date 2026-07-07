"""Sidecar entrypoint: `python -m satsearch_sidecar`.

Electron picks a free port and passes it (SATSEARCH_PORT) with the token and data dir.
We write sidecar.lock ({pid, port, token, sidecarVersion}) then serve on 127.0.0.1.
Electron only trusts the lock after a successful token-authed /health.
"""

from __future__ import annotations

import json
import os
import tempfile

import uvicorn

from .config import Config
from .version import compute_version


def _write_lock(config: Config, port: int, token: str, version: str) -> None:
    os.makedirs(config.data_dir, exist_ok=True)
    lock = os.path.join(config.data_dir, "sidecar.lock")
    payload = {"pid": os.getpid(), "port": port, "token": token, "sidecarVersion": version}
    fd, tmp = tempfile.mkstemp(dir=config.data_dir)
    with os.fdopen(fd, "w") as f:
        json.dump(payload, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, lock)


def main() -> None:
    config = Config.from_env()
    config.ensure()
    port = int(os.environ.get("SATSEARCH_PORT", "8000"))
    version = compute_version()
    os.environ["SATSEARCH_SIDECAR_VERSION"] = version
    _write_lock(config, port, config.token, version)

    from .main import build_default_app
    app = build_default_app()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
