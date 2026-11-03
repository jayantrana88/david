"""Internal pool: the internal pages of every qualified lead (jina only).

Queue: `store.pending_scrapes`, qualified `website_scrapes` rows with no page read yet: no `website_pages`
row, or only the `content_json IS NULL` placeholder left when every internal link failed last time (see
`run.py`). Per lead: run_internal_pages (up to 5 subpages via Jina) → persist
the pages in one insert (replacing any placeholder).
"""

from __future__ import annotations

import logging

from core.clients import get_jina
from core.db import Db
from core.log import slog
from core.worker import Worker
from stages.internal import store
from stages.internal.models import QualifiedScrape
from stages.internal.run import run_internal_pages


async def run_internal(db: Db, scrape: QualifiedScrape) -> None:
    result = await run_internal_pages(scrape)
    # Before the pages row: the email pool only offers a lead once it has pages, so its addresses must be
    # in `websites.email` by then. A failure here is only logged; the lead's pages are still saved.
    try:
        await store.add_emails(db, result.website_id, result.emails)
    except Exception as exc:  # noqa: BLE001
        slog(f"[DB ERROR] failed to save subpage emails for website {result.website_id}: {exc}",
             level=logging.ERROR)
    await store.persist_pages(db, result)
    if result.fetch_failed:
        slog(f"[internal_pages] {scrape.label}: no internal page could be read, left content_json NULL "
             "for a retry")
    else:
        slog(f"[internal_pages] {scrape.label}: ✅ saved {len(result.pages)} page(s)"
             f"{' (homepage summary only)' if result.homepage_only else ''}")


def make_worker(db: Db) -> Worker:
    get_jina()   # fail now, with one clear message, if the key is missing
    return Worker(
        name="internal",
        db=db,
        load=store.pending_scrapes,
        run=run_internal,
        batch_size=3,       # each lead reads up to 5 pages side by side
        idle_sleep=30.0,
    )
