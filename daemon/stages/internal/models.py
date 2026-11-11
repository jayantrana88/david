"""What the internal_pages service takes (a qualified scrape with no pages yet) and returns."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class QualifiedScrape:
    """A `website_scrapes` row with `is_qualified` = TRUE and no `website_pages` row yet."""
    id: str                             # website_scrapes.id
    website_id: str
    summary: str = ""
    main_links: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "QualifiedScrape":
        links = row.get("main_links")
        return cls(id=row["id"], website_id=row.get("website_id") or "", summary=row.get("summary") or "",
                   main_links=links if isinstance(links, dict) else {})

    @property
    def label(self) -> str:
        return f"scrape {self.id}"


@dataclass
class Page:
    """One internal page, as saved in `website_pages`. `content_json` is None on the placeholder row saved
    when every read failed (see PagesResult.fetch_failed) — the default value, not a JSON blob."""
    name: str                           # the link text
    url: str | None
    content_json: dict[str, Any] | None    # title, description, content (cut to MAX_CONTENT_CHARS)
    emails: list[str] = field(default_factory=list)   # found on the page (before the cut); not saved in the row


@dataclass
class PagesResult:
    scrape_id: str
    website_id: str
    pages: list[Page]
    homepage_only: bool = False         # no internal links: the one page is the homepage summary
    fetch_failed: bool = False          # every internal link failed: the one page is a NULL placeholder,
                                        # retried in full later (see `store.pending_scrapes`)

    @property
    def emails(self) -> list[str]:
        """Every address found on the subpages, unique, in first-seen order."""
        return list(dict.fromkeys(e for page in self.pages for e in page.emails))
