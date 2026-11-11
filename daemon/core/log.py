"""Centralised logging: one console+file 'main' logger for the daemon loops, plus a file-only logger per
worker pool (sourcing / scrape / internal / email) for the per-lead work.

Why a contextvar
----------------
Every pool runs concurrently in one asyncio process, so a shared client (`core/`, `apis/`) can't know which
pool is calling it. A worker binds its pool into a contextvar once at the top of its loop; because
everything it then awaits runs in that context, and `asyncio.gather` copies the context into its child
tasks, `slog()` routes each service/client line to the right pool file.

Outside any worker (the test/ harnesses, ad-hoc scripts) the contextvar is unset and `slog()` falls back
to the "main" logger.

Topology
--------
* root: ``logs/main/main.log``, echoed to the console when config.py -> LOGGING.console. The daemon
  loops (worker lifecycle) log via ``getLogger(__name__)`` and propagate here.
* ``pool.<name>``: file-only ``logs/<name>/<name>.log``, ``propagate=False`` so per-lead output never reaches
  the console. Each file rotates at midnight and keeps 7 days.

Levels come from config.py -> LOGGING (`level`, and `levels` keyed by "main" or a pool name); the
LOG_LEVEL environment variable overrides them for one run.
"""

from __future__ import annotations

import contextvars
import logging
import os
import sys
from logging.handlers import TimedRotatingFileHandler
from typing import Iterable

from config import LOGGING, PROJECT_ROOT

LOG_DIR = PROJECT_ROOT / "logs"
_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
_BACKUP_DAYS = 7

# Libraries that log one INFO line per HTTP request or call: at WARNING they only report trouble.
_NOISY_LOGGERS = ("httpx", "httpcore", "hpack", "urllib3", "LiteLLM", "litellm", "LiteLLM Router",
                  "LiteLLM Proxy", "asyncio")

# Pool of the worker currently executing in this context; None on the daemon's main loops and outside
# any worker.
_current_pool: contextvars.ContextVar[str | None] = contextvars.ContextVar("log_pool", default=None)


class _ConsoleHandler(logging.StreamHandler):
    """stdout handler that survives a console that can't show a character (cp1252 vs the ✅ in messages)."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.stream.write(self.format(record) + self.terminator)
            self.flush()
        except UnicodeEncodeError:
            encoding = getattr(self.stream, "encoding", None) or "ascii"
            safe = (self.format(record) + self.terminator).encode(encoding, "replace").decode(encoding)
            self.stream.write(safe)
            self.flush()
        except Exception:  # noqa: BLE001 — same contract as StreamHandler
            self.handleError(record)


def _file_handler(name: str) -> TimedRotatingFileHandler:
    """``logs/<name>/<name>.log`` (rotated copies sit beside it), creating the folder on first use."""
    folder = LOG_DIR / name
    folder.mkdir(parents=True, exist_ok=True)
    handler = TimedRotatingFileHandler(
        folder / f"{name}.log", when="midnight", backupCount=_BACKUP_DAYS, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter(_FORMAT))
    return handler


def _level(name: str) -> int:
    """LOG_LEVEL env var > config.py LOGGING.levels[name] > LOGGING.level."""
    override = logging.getLevelName((os.environ.get("LOG_LEVEL") or "").strip().upper())
    return override if isinstance(override, int) else LOGGING.level_for(name)


def setup_logging(pools: Iterable[str] = ()) -> None:
    """Configure the main (root) logger and a file-only logger for each of `pools` (main.py passes every pool).

    Idempotent: clears existing handlers so a re-run (a harness) doesn't duplicate output.
    """
    LOG_DIR.mkdir(exist_ok=True)

    root = logging.getLogger()
    root.setLevel(_level("main"))
    root.handlers.clear()
    if LOGGING.console:
        console = _ConsoleHandler(sys.stdout)
        console.setFormatter(logging.Formatter(_FORMAT))
        root.addHandler(console)
    root.addHandler(_file_handler("main"))

    for pool in pools:
        logger = logging.getLogger(f"pool.{pool}")
        logger.setLevel(_level(pool))
        logger.handlers.clear()
        logger.addHandler(_file_handler(pool))
        logger.propagate = False  # file-only: keep per-lead lines off the console

    for noisy in _NOISY_LOGGERS:
        logging.getLogger(noisy).setLevel(logging.WARNING)


def bind_pool(pool: str) -> None:
    """Bind the current worker's pool so `slog` routes to its file.

    Called once at the top of a worker coroutine. Each worker runs as its own
    asyncio Task with its own copied context, so this never leaks across pools.
    """
    _current_pool.set(pool)


def pool_logger(pool: str) -> logging.Logger:
    """The file-only logger for an explicit pool (worker per-lead lines)."""
    return logging.getLogger(f"pool.{pool}")


def _active_logger() -> logging.Logger:
    pool = _current_pool.get()
    if pool:
        return logging.getLogger(f"pool.{pool}")
    return logging.getLogger("main")  # propagates to the root: logs/main/main.log + console


def slog(msg: str, *args: object, level: int = logging.INFO, exc_info: bool = False) -> None:
    """Log a service/client line to the running worker's pool file (or the main logger outside any worker).

    Callers usually pass pre-formatted f-strings, so when there are no `args` the message is logged via a
    literal ``%s`` to avoid a stray ``%`` being read as a format spec.
    """
    logger = _active_logger()
    if args:
        logger.log(level, msg, *args, exc_info=exc_info)
    else:
        logger.log(level, "%s", msg, exc_info=exc_info)
