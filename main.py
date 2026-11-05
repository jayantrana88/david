"""Daemon entry point: one process, several cooperating loops.

Starts the five worker pools and runs them together. They share one interpreter, one database connection,
the API clients and each API's rate limiter (config.py -> RATE_LIMITS):

    profile    the uploaded resume (+ notes) → the AI derives the career profile   → candidate_profile
    sourcing   runs the `tasks` table's pending tasks, oldest first, one at a time   → websites
    scrape     homepage via Jina + the AI checks the company fits the candidate    → website_scrapes (+ websites.email)
    internal   internal pages of the qualified companies via Jina                  → website_pages
    email      the AI writes the application, it goes to the Telegram chat or out by Gmail / Outlook
               (or a dry run)                                                     → cold_emails

The scrape and email pools wait until the candidate profile is ready.

The pools don't call each other: each one polls its own "pending work" query, so a lead flows on by
itself once the previous pool has written its row. The sourcing pool's work is what the user adds to
`tasks` (db/schema.sql). A pool whose API key is missing is not started (the others run); a pool whose AI key is rejected, or whose AI models are all out of quota, holds and retries later.

Shutdown is graceful: on SIGINT/SIGTERM the loops stop taking new work and in-flight leads get a short
grace period to finish; whatever's still running is cancelled and simply picked up again next start (a lead
is pending until its row is written; a task left `running` is put back to `pending` at startup).

Run with:  python main.py                     # every pool
           python main.py --pools scrape      # only these pool(s)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import subprocess
import sys

from core import app_settings
from core.config_models import ConfigError

# config.py validates itself on import: report a bad value as a message, not a traceback.
try:
    import config
    from core.clients import aclose_all, get_db
    from core.log import setup_logging
    from stages.email import worker as email
    from stages.internal import worker as internal
    from stages.profile import worker as profile
    from stages.scrape import worker as scrape
    from stages.sourcing import worker as sourcing
    from stages.sourcing.store import reset_interrupted_tasks
except ConfigError as exc:
    print(f"[ERROR] config.py: {exc}")
    # Tell the dashboard why the daemon didn't start (best-effort).
    app_settings.report({"apply_error": str(exc)[:2000], "applied_at": app_settings.now_iso()})
    sys.exit(1)

log = logging.getLogger(__name__)

# Every pool, in pipeline order: its name -> the stage's `make_worker(db)` (stages/<name>/worker.py)
POOLS = {
    "profile": profile.make_worker,
    "sourcing": sourcing.make_worker,
    "scrape": scrape.make_worker,
    "internal": internal.make_worker,
    "email": email.make_worker,
}

GRACE_SECS = 30.0  # how long in-flight leads may finish after a shutdown signal
SETTINGS_POLL_SECS = 5.0   # how often a live daemon checks whether the dashboard saved new settings
RESTART_EXIT_CODE = 75     # "settings changed, start me again": the supervisor (below) relaunches on it
CHILD_ENV = "DAVID_CHILD"   # set for the daemon process the supervisor launches


def _install_signal_handlers(shutdown: asyncio.Event) -> None:
    """Wire SIGINT/SIGTERM to set `shutdown`, portably.

    `loop.add_signal_handler` is the clean path (Linux). It's unsupported on Windows, where we fall back to
    `signal.signal` so Ctrl+C still shuts down gracefully instead of hard-killing in-flight leads.
    """
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, shutdown.set)
        except NotImplementedError:
            try:
                signal.signal(sig, lambda *_: loop.call_soon_threadsafe(shutdown.set))
            except (ValueError, OSError):
                pass  # e.g. SIGTERM not deliverable on Windows


async def _report_applied_settings() -> None:
    """Record in app_settings which settings this daemon runs with, for the dashboard's "restart required"
    note."""
    log.info("settings: dashboard settings v%s", config.APP_SETTINGS.version)
    fields = {"applied_at": app_settings.now_iso(), "apply_error": None,
              "applied_version": config.APP_SETTINGS.version}
    error = await asyncio.to_thread(app_settings.report, fields)
    if error:
        log.warning("could not record the applied settings in app_settings: %s", error)


async def _watch_settings(shutdown: asyncio.Event, restart: asyncio.Event) -> None:
    """When the dashboard saves settings (the version moves past the one seen at start), ask for a graceful
    shutdown that ends in a restart, so a change takes effect without a manual restart."""
    loaded = config.APP_SETTINGS.version
    while not shutdown.is_set():
        await asyncio.sleep(SETTINGS_POLL_SECS)
        current = await asyncio.to_thread(app_settings.current_version)
        if current is not None and current != loaded:
            log.info("settings changed on the dashboard (v%s -> v%s); restarting to apply them", loaded, current)
            restart.set()
            shutdown.set()


async def main(pools: list[str]) -> int:
    db = await get_db()
    shutdown = asyncio.Event()
    restart = asyncio.Event()
    _install_signal_handlers(shutdown)

    workers = []
    for name in pools:
        try:
            worker = POOLS[name](db)
        except RuntimeError as exc:   # a missing API key
            log.error("pool '%s' not started: %s", name, exc)
            continue
        if worker is None:
            log.info("pool '%s' not started: nothing to do (disabled in config.py)", name)
            continue
        workers.append(worker)
    if not workers:
        log.error("no pool could start; fix the messages above")
        return 1

    if any(w.name == "sourcing" for w in workers):
        try:
            if reset := await reset_interrupted_tasks(db):
                log.warning("%d task(s) left running by the last daemon put back to pending", reset)
        except Exception:  # noqa: BLE001 — they stay `running` until the next start; the rest can still run
            log.exception("could not reset interrupted tasks")

    await _report_applied_settings()

    tasks = [asyncio.create_task(w.run(shutdown), name=f"worker-{w.name}") for w in workers]
    log.info("daemon up: %s", ", ".join(t.get_name() for t in tasks))
    watcher = None
    if os.environ.get(CHILD_ENV) == "1":   # restarting needs the supervisor
        watcher = asyncio.create_task(_watch_settings(shutdown, restart), name="settings-watcher")

    try:
        await shutdown.wait()
        log.info("shutdown signal received; draining (grace %.0fs)…", GRACE_SECS)
        _, pending = await asyncio.wait(tasks, timeout=GRACE_SECS)
        if pending:
            log.warning("grace elapsed; cancelling %d loop(s) mid-lead", len(pending))
            for t in pending:
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        if watcher:
            watcher.cancel()
        await aclose_all()
        log.info("daemon stopped")
    return RESTART_EXIT_CODE if restart.is_set() else 0


def _supervise() -> int:
    """Run the daemon in a child process and start it again whenever it exits with RESTART_EXIT_CODE.

    config.py reads the dashboard settings at import, so applying new ones means a fresh process. Ctrl+C
    reaches the child too (same console); the supervisor just waits for it to finish draining."""
    cmd = [sys.executable, os.path.abspath(__file__), *sys.argv[1:]]
    env = {**os.environ, CHILD_ENV: "1"}
    while True:
        child = subprocess.Popen(cmd, env=env)
        interrupted = False
        while True:
            try:
                code = child.wait()
                break
            except KeyboardInterrupt:
                interrupted = True
        if code != RESTART_EXIT_CODE or interrupted:
            return code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="DAVID daemon: profile; sourcing tasks -> scrape -> internal -> email.")
    parser.add_argument("--pools", nargs="+", choices=POOLS, default=list(POOLS), metavar="POOL",
                        help=f"run only these pool(s): {', '.join(POOLS)} (default: all)")
    args = parser.parse_args()

    if os.environ.get(CHILD_ENV) != "1":
        sys.exit(_supervise())

    setup_logging(POOLS)
    try:
        sys.exit(asyncio.run(main(args.pools)))
    except KeyboardInterrupt:
        log.info("daemon interrupted")
    except RuntimeError as exc:
        log.error("%s", exc)
        sys.exit(1)
