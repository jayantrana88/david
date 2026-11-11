"""Sourcing pool: the lead sources, driven by the `tasks` table.

Its queue is `tasks` (db/schema.sql): the user inserts a row (category, location, candidates) and the pool
takes the oldest `pending` one, one task at a time. Per task: claim it (`running`) → load the known URLs →
run the source's service, which hands each lead to `store.insert_website` as soon as it is found
(`tasks.leads_saved` counts them as they go) → mark it `completed`, or `failed` with the reason in `error`.
A failed task isn't retried; the user re-queues it by setting its status back to `pending`. The leads it
saves are what the scrape pool picks up next.
"""

from __future__ import annotations

import logging
import time

from core.clients import get_browser, get_serper
from core.db import Db
from core.errors import LeadFailed
from core.log import slog
from core.worker import Worker
from stages.sourcing import store
from stages.sourcing.models import LeadRecord, SAVED, SourcingRun, SourcingTask

log = logging.getLogger(__name__)

COMPLETED = "completed"
FAILED = "failed"
SOURCES = ("linkedin",)     # `tasks.source` values this pool runs (the CHECK on tasks.source, db/schema.sql)


async def run_source(db: Db, task: SourcingTask, on_saved) -> SourcingRun:
    """One run of the task's lead source; every lead found is saved at once, deduped against `websites`.
    Raises ValueError for a value the source can't use."""
    if task.source not in SOURCES:
        raise ValueError(f"no lead source called {task.source!r} (known: {', '.join(SOURCES)})")
    known = await store.known_urls(db)
    slog(f"{task.label}: {len(known)} existing lead(s) loaded for duplicate detection")

    async def save(record: LeadRecord) -> str:
        outcome = await store.insert_website(db, record)
        if outcome == SAVED:
            await on_saved()
        return outcome

    from stages.sourcing.linkedin.service import run_linkedin   # builds the gazetteer: only when needed
    return await run_linkedin(task, known, save)


async def run_task(db: Db, queued: SourcingTask) -> None:
    """Claim one task, run it, and record how it ended on its row.

    Raises `LeadFailed(permanent=True)` for a task that failed (after marking it `failed`), so the Worker
    logs it; the row is no longer `pending`, so it isn't picked up again until the user re-queues it.
    """
    row = await store.claim_task(db, queued.task_id)
    if row is None:
        slog(f"{queued.label}: no longer pending (changed since it was loaded), left alone")
        return
    task = SourcingTask.from_row(row)
    saved = task.leads_saved
    log.info("sourcing %s: %d lead(s) wanted", task.label, task.candidates)

    async def count_saved() -> None:
        nonlocal saved
        saved += 1
        await store.update_task_progress(db, task.task_id, saved)

    started = time.monotonic()
    try:
        result = await run_source(db, task, count_saved)
    except ValueError as exc:       # a value the source can't use (ConfigError), or a location it doesn't know
        await store.finish_task(db, task.task_id, FAILED, saved, str(exc))
        raise LeadFailed(str(exc), permanent=True) from exc
    except Exception as exc:        # unexpected: recorded on the row, re-raised for the Worker's traceback
        await store.finish_task(db, task.task_id, FAILED, saved, f"{type(exc).__name__}: {exc}")
        raise

    minutes = (time.monotonic() - started) / 60
    summary = f"{task.label} finished in {minutes:.0f} min: {result.summary()}"
    slog(summary)
    log.info("%s", summary)
    if result.aborted or result.failed:
        error = result.aborted or f"nothing usable came out ({result.summary()})"
        await store.finish_task(db, task.task_id, FAILED, saved, error)
        raise LeadFailed(error, permanent=True)
    # `completed` = the run ended normally; a shortfall is noted in `error` so it isn't mistaken for a full run
    note = "fewer leads than wanted: " + "; ".join(result.shortfalls) if result.shortfalls else None
    await store.finish_task(db, task.task_id, COMPLETED, saved, note)


def make_worker(db: Db) -> Worker:
    """The sourcing pool. Raises RuntimeError when a task source's client can't be built (a missing key)."""
    get_serper()
    get_browser()       # only checks playwright is installed; Chromium starts at the first page fetch

    return Worker(
        name="sourcing",
        db=db,
        load=store.next_pending_task,
        run=run_task,
        batch_size=1,                   # one task at a time, oldest first
        idle_sleep=30.0,                # how often an empty queue is looked at again
        failure_backoff=60.0,           # a task whose claim hit a DB error is tried again this soon
        max_consecutive_failures=None,  # a failed task is recorded on its row; the next one runs as usual
    )
