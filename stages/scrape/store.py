"""All SQL of the scrape stage: its queue (`pending_websites`), the saved homepage text of a lead the AI is
asked about again, and the `website_scrapes` row (+ `websites.email`) each lead ends with.
"""

from __future__ import annotations

import logging

from core.db import Db
from core.log import slog
from core.sqlite import insert_sql
from stages.scrape.models import ScrapeJob, ScrapeResult

QUEUE_LIMIT = 200           # rows per queue load (reloaded once worked through)


async def pending_websites(db: Db) -> list[ScrapeJob]:
    """The scrape pool's queue: leads with no `website_scrapes` row yet and leads whose row
    still waits on the AI's verdict (`is_qualified IS NULL`, `scrape_id` set: the homepage text is saved, only the
    AI is asked again — this feeds a lead back once an AI failure clears, e.g. a rejected key's credit is
    topped up)."""
    rows = await db.fetch_all(
        """SELECT w.id, w.name, w.website_url, w.target_role, w.opportunity_type, s.id AS scrape_id
            FROM websites w LEFT JOIN website_scrapes s ON s.website_id = w.id
            WHERE s.id IS NULL OR s.is_qualified IS NULL
            ORDER BY w.created_at LIMIT ?""", (QUEUE_LIMIT,), what="websites to scrape")
    return [ScrapeJob.from_row(r) for r in rows]


async def saved_read(db: Db, scrape_id: str) -> dict | None:
    """The saved homepage of one scrape, for re-asking the AI about it: `homepage_text`, or for a row saved
    before that column existed, Jina's whole read (`raw_json`). Fetched per lead rather than in the queue's
    load, since a page per row adds up."""
    return await db.fetch_one("SELECT homepage_text, raw_json FROM website_scrapes WHERE id = ?", (scrape_id,),
                              what="load the saved homepage")


async def persist_scrape(db: Db, result: ScrapeResult) -> None:
    """Insert the `website_scrapes` row (`is_qualified` True, False, or NULL when the AI hasn't answered
    yet, the AI's `summary` of the business, and the homepage text it judged, kept so it can be asked again)
    and save the emails found to `websites.email`. Raises if
    the scrape row can't be inserted; a failed email update is only logged."""
    row = {
        "website_id":   result.website_id,
        "homepage_text": result.text or None,
        "main_links":   result.main_links,
        "summary":      result.summary,
        "is_qualified": result.is_qualified,
        # id, created_at, updated_at are DB defaults
    }
    await db.execute(*insert_sql("website_scrapes", row), what="insert website_scrapes")

    if result.emails:
        # One comma-separated string: the column the email pool's queue (stages/email/store.py::uncontacted_leads) depends on.
        try:
            await db.execute("UPDATE websites SET email = ? WHERE id = ?",
                             (", ".join(result.emails), result.website_id), what="save emails")
        except Exception as exc:  # noqa: BLE001 — the scrape is saved; the emails can be found again
            slog(f"[DB ERROR] failed to save emails for website {result.website_id}: {exc}", level=logging.ERROR)


async def update_qualification(db: Db, scrape_id: str, is_qualified: bool, summary: str | None) -> None:
    """Set the verdict and the AI's summary on a `website_scrapes` row that was left `is_qualified IS NULL`
    (the AI's earlier call failed and has now been retried). Raises if the update fails."""
    await db.execute("UPDATE website_scrapes SET is_qualified = ?, summary = ? WHERE id = ?",
                     (is_qualified, summary, scrape_id), what="update website_scrapes.is_qualified")
