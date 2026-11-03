"""All SQL of the sourcing stage: the `tasks` table (the pool's queue, filled by the user) and the `websites`
rows a source saves. `tasks.updated_at` is kept by a DB trigger (db/schema.sql), so nothing here sets it.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from core.db import Db
from core.http import normalize_url
from core.log import slog
from core.sqlite import insert_sql, is_unique_violation, utc_now
from stages.sourcing.models import DUPLICATE, ERROR, SAVED, LeadRecord, SourcingTask

PAGE_SIZE = 1000            # rows per page when reading every known URL


REPEAT_EVERY = timedelta(hours=24)


async def requeue_due_repeats(db: Db) -> int:
    """Put back to `pending` every `repeat_daily` task that finished (completed or failed) 24 h ago or more.
    `leads_saved` restarts at 0, since the new run saves its own leads. Returns how many. Raises if the update fails."""
    cutoff = (datetime.now(timezone.utc) - REPEAT_EVERY).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return await db.execute(
        """UPDATE tasks SET status = 'pending', error = NULL, leads_saved = 0
           WHERE repeat_daily = 1 AND status IN ('completed', 'failed') AND finished_at <= ?""",
        (cutoff,), what="requeue daily tasks")


async def next_pending_task(db: Db) -> list[SourcingTask]:
    """The oldest `tasks` row still `pending`, or nothing (the sourcing pool's queue, one task at a time).
    Repeating tasks that are due are put back to `pending` first."""
    if requeued := await requeue_due_repeats(db):
        slog(f"{requeued} daily task(s) queued again")
    rows = await db.fetch_all("SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at, id LIMIT 1",
                              what="next pending task")
    return [SourcingTask.from_row(r) for r in rows]


async def known_urls(db: Db) -> set[str]:
    """Every website already in `websites`, normalized, so a lead source skips leads that are saved.

    Pages by id (`id > last id`) rather than by offset: an offset makes the database skip that many rows on
    every page, which gets slow as the table grows, and can skip or repeat rows if the table changes while
    it is being read. Raises if the DB can't be read: carrying on would insert duplicates.
    """
    known: set[str] = set()
    last_id = ""
    while True:
        batch = await db.fetch_all("SELECT id, website_url FROM websites WHERE id > ? ORDER BY id LIMIT ?",
                                   (last_id, PAGE_SIZE), what="load known URLs")
        known.update(normalize_url(row["website_url"]) for row in batch if row.get("website_url"))
        if len(batch) < PAGE_SIZE:
            return known
        last_id = batch[-1]["id"]


async def claim_task(db: Db, task_id: int) -> dict | None:
    """Mark a `pending` task `running`. Returns the claimed row, or None when the task isn't pending any
    more (the user changed or deleted it since it was loaded). Raises if the update fails."""
    return await db.fetch_one(
        """UPDATE tasks SET status = 'running', started_at = ?, finished_at = NULL, error = NULL
           WHERE id = ? AND status = 'pending' RETURNING *""", (utc_now(), task_id), what=f"claim task #{task_id}")


async def update_task_progress(db: Db, task_id: int, leads_saved: int) -> None:
    """Set how many leads a running task has saved so far. Best-effort: logged, never raises."""
    try:
        await db.execute("UPDATE tasks SET leads_saved = ? WHERE id = ?", (leads_saved, task_id),
                         what=f"task #{task_id} progress")
    except Exception as exc:  # noqa: BLE001 — a missed counter update must not stop the run
        slog(f"[DB ERROR] could not update the progress of task #{task_id}: {exc}", level=logging.ERROR)


async def finish_task(db: Db, task_id: int, status: str, leads_saved: int, error: str | None = None) -> None:
    """Record how a task ended: "completed", or "failed" with the reason. Never raises: a task that can't be
    marked stays `running` and goes back to `pending` at the next daemon start (logged)."""
    try:
        await db.execute("UPDATE tasks SET status = ?, leads_saved = ?, error = ?, finished_at = ? WHERE id = ?",
                         (status, leads_saved, error, utc_now(), task_id), what=f"finish task #{task_id}")
    except Exception as exc:  # noqa: BLE001 — bookkeeping must not break the pool
        slog(f"[DB ERROR] could not mark task #{task_id} {status}: {exc}", level=logging.ERROR)


async def reset_interrupted_tasks(db: Db) -> int:
    """Put back to `pending` every task left `running` by a daemon that stopped mid-task (called once at
    startup, before the sourcing pool runs). Returns how many there were. Raises if the update fails."""
    return await db.execute("UPDATE tasks SET status = 'pending', started_at = NULL WHERE status = 'running'",
                            what="reset interrupted tasks")


def _website_row(record: LeadRecord) -> dict:
    return {
        "name":         record.name,
        "website_url":  record.website_url,
        "phone_number": record.phone_number or None,
        "category":     record.category or None,
        "location":     record.location or None,
        "owner":        record.owner or None,
        "source":       record.source or None,
        "employee_size": record.employee_size or None,
        "employee_max": record.employee_max,
        "industry":     record.industry or None,
        "linkedin_url": record.linkedin_url or None,
        "target_role":  record.target_role or None,
        "opportunity_type": record.opportunity_type or None,
        # id, created_at and updated_at are DB defaults
    }


async def insert_website(db: Db, record: LeadRecord) -> str:
    """Insert one lead into `websites`. Returns SAVED, DUPLICATE (the site is already in the table, per a
    unique index) or ERROR (logged; the source moves on to the next lead). Never raises."""
    try:
        await db.execute(*insert_sql("websites", _website_row(record)), what=f"insert '{record.name}'")
        return SAVED
    except Exception as exc:  # noqa: BLE001 — one bad lead must not end the run
        if is_unique_violation(exc):
            slog(f"already in DB (unique key), skipping '{record.name}'")
            return DUPLICATE
        slog(f"[DB ERROR] failed to insert '{record.name}': {exc}", level=logging.ERROR)
        return ERROR
