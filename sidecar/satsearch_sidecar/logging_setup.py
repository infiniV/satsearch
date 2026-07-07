"""Centralized logging config for the sidecar.

Everything logs through the `satsearch_sidecar` package logger (modules use
`logging.getLogger(__name__)`, which are children of it). We log to **stderr** so
stdout stays clean for Electron's `sidecar.ts`, which pipes our stdio. Level is
`SATSEARCH_LOG_LEVEL` (default INFO). `configure_logging` is idempotent so repeated
calls (e.g. tests) don't stack duplicate handlers.
"""

from __future__ import annotations

import logging
import sys

PACKAGE_LOGGER = "satsearch_sidecar"

_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
_DATEFMT = "%Y-%m-%dT%H:%M:%S"


def configure_logging(level: str = "INFO") -> logging.Logger:
    """Attach a single stderr handler to the package logger and set its level.

    Returns the package logger. Safe to call more than once.
    """
    logger = logging.getLogger(PACKAGE_LOGGER)
    numeric = logging.getLevelName(str(level).upper())
    if not isinstance(numeric, int):
        numeric = logging.INFO
    logger.setLevel(numeric)
    logger.propagate = False  # don't double-emit through the root logger

    if not any(getattr(h, "_satsearch", False) for h in logger.handlers):
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(_FORMAT, datefmt=_DATEFMT))
        handler._satsearch = True  # type: ignore[attr-defined]  # marker for idempotency
        logger.addHandler(handler)

    return logger
