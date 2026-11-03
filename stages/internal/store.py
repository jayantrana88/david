"""All SQL of the internal stage: its queue (`pending_scrapes`), the subpage emails added to `websites.email`,
and the lead's `website_pages` rows (replaced as a whole, in one transaction).
"""

from __future__ import annotations

import re

from core.db import Db, Tx
from core.sqlite import insert_sql
from stages.internal.models import PagesResult, QualifiedScrape

QUEUE_LIMIT = 100           # rows per queue load (reloaded once worked through)


async def pending_scrapes(db: Db) -> list[QualifiedScrape]:
    """The internal pool's queue: qualified scrapes (`is_qualified` = 1) with no page read yet — no
    `website_pages` row at all, or only the `content_json IS NULL` placeholder `run_internal_pages` saves
    when every internal link failed to read (retried in full, from the scrape's own `main_links`)."""
    rows = await db.fetch_all(
        """SELECT s.id, s.website_id, s.summary, s.main_links
           FROM website_scrapes s
           WHERE s.is_qualified = 1
             AND NOT EXISTS (SELECT 1 FROM website_pages p WHERE p.scrape_id = s.id AND p.content_json IS NOT NULL)
           ORDER BY s.created_at LIMIT ?""", (QUEUE_LIMIT,), what="qualified scrapes without pages")
    return [QualifiedScrape.from_row(r) for r in rows]


async def add_emails(db: Db, website_id: str, emails: list[str]) -> None:
    """Add `emails` (found on the lead's subpages) to `websites.email`, after the addresses already there
    (the homepage's come first, so they stay the one `pick_email` prefers). Only writes when something is
    new. Raises if the read or the update fails."""
    if not emails or not website_id:
        return

    def merge(tx: Tx) -> None:
        row = tx.fetch_one("SELECT email FROM websites WHERE id = ?", (website_id,))
        have = [e.strip().lower() for e in re.split(r"[,;\s]+", (row.get("email") if row else "") or "") if e.strip()]
        merged = list(dict.fromkeys([*have, *emails]))
        if len(merged) > len(have):
            tx.execute("UPDATE websites SET email = ? WHERE id = ?", (", ".join(merged), website_id))

    await db.transaction(merge, what="save emails")


async def persist_pages(db: Db, result: PagesResult) -> None:
    """Replace the lead's `website_pages` rows with this read's result, in one transaction (all of a lead's
    rows or none). The delete is a no-op the first time; on a retry it clears the stale
    `content_json=None` placeholder (or an earlier attempt's rows) so it isn't left behind next to the
    fresh ones. Raises if it fails."""
    rows = [{
        "scrape_id": result.scrape_id,
        "page_name": page.name,
        "page_url": page.url,
        "content_json": page.content_json,
    } for page in result.pages]

    def replace(tx: Tx) -> None:
        tx.execute("DELETE FROM website_pages WHERE scrape_id = ?", (result.scrape_id,))
        if rows:
            tx.execute_many(insert_sql("website_pages", rows[0])[0], rows)

    await db.transaction(replace, what="save website_pages")
