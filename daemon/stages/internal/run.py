"""Internal-pages orchestrator: QualifiedScrape -> PagesResult.

Reads up to MAX_SUBPAGES of the lead's main internal pages (picked by the site_scrape service) through
Jina, side by side; the pool's `jina` limiter bounds how many really run at once. Scraping only: no AI.
Nothing is saved here: the worker saves the result (store.py).

Never raises for a Jina failure: a lead with no internal links to follow gets one "Homepage only" page,
and a lead whose internal links all failed to read gets one placeholder page with `content_json=None`
instead — that becomes a `website_pages` row the worker persists, and
`store.pending_scrapes` offers the lead again later so it's retried in full rather than
backed off forever in memory.
"""

from __future__ import annotations

import asyncio
import logging

from apis.jina_parsing import extract_emails
from core.clients import get_jina
from core.log import slog

from .models import Page, PagesResult, QualifiedScrape

MAX_SUBPAGES = 5            # internal pages scraped per lead
MAX_CONTENT_CHARS = 8000    # a page's text is cut to this many characters before it is saved

# Saved when a lead's homepage has no internal links to follow, so the lead still gets a `website_pages`
# row (it is pending exactly until it has one) and the email pool has something to work from.
HOMEPAGE_ONLY_URL = "Homepage only"

# page_name for the placeholder row saved when the lead HAD internal links but none of them could be
# read (content_json stays None; page_url has nothing meaningful to hold, so it's also None).
FETCH_FAILED_NAME = "Internal pages"


async def _read_page(name: str, url: str) -> Page | None:
    slog(f"[internal_pages] reading subpage {url}")
    resp = await get_jina().read(url)
    if not resp or resp.get("code") != 200:
        slog(f"[internal_pages] no usable page for {url} (code {resp.get('code') if resp else None})")
        return None
    data = resp.get("data") or {}
    content = (data.get("content") or "").strip()
    if not content:
        slog(f"[internal_pages] no content on {url}")
        return None
    title, description = (data.get("title") or "").strip(), (data.get("description") or "").strip()
    # Looked for in the whole page (links included), not just the part that is saved
    emails = extract_emails(data.get("links"), content, description, title)
    return Page(name=name, url=url, content_json={
        "title": title,
        "description": description,
        "content": content[:MAX_CONTENT_CHARS],
    }, emails=emails)


async def run_internal_pages(scrape: QualifiedScrape) -> PagesResult:
    """Read the lead's internal pages. Never raises: a lead with no internal links gets one "Homepage
    only" page, and a lead whose internal links all failed to read gets one `content_json=None`
    placeholder page instead of nothing, so there's always a result for the worker to persist.
    """
    if not scrape.main_links:
        slog(f"[internal_pages] {scrape.label}: no internal links, saving the homepage summary only")
        return PagesResult(scrape.id, scrape.website_id,
                           [Page("Homepage", HOMEPAGE_ONLY_URL, {"content": scrape.summary})], homepage_only=True)

    items = list(scrape.main_links.items())[:MAX_SUBPAGES]
    pages = [p for p in await asyncio.gather(*(_read_page(name, url) for name, url in items)) if p]
    if not pages:
        slog(f"[internal_pages] {scrape.label}: none of the {len(items)} internal pages could be read — "
             "saving a NULL placeholder for a retry", level=logging.WARNING)
        return PagesResult(scrape.id, scrape.website_id, [Page(FETCH_FAILED_NAME, None, None)], fetch_failed=True)
    result = PagesResult(scrape.id, scrape.website_id, pages)
    slog(f"[internal_pages] {scrape.label}: read {len(pages)}/{len(items)} internal page(s)"
         f"{f', {len(result.emails)} email(s)' if result.emails else ''}")
    return result
