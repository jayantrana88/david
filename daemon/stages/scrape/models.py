"""What the site_scrape service takes (a lead waiting on the scrape pool) and returns."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ScrapeJob:
    """A lead the scrape pool works on (a row of `store.pending_websites`): one with no
    `website_scrapes` row yet, or one whose row still waits on the AI's verdict (`scrape_id` set,
    `is_qualified IS NULL`: the homepage read is saved, only the AI is asked again)."""
    id: str                                 # websites.id
    name: str = ""
    website_url: str = ""
    target_role: str | None = None          # the task's override; None = the candidate profile's roles
    opportunity_type: str | None = None     # likewise
    scrape_id: str | None = None            # the saved website_scrapes row still waiting on a verdict

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "ScrapeJob":
        return cls(id=row["id"], name=row.get("name") or "", website_url=(row.get("website_url") or "").strip(),
                   target_role=row.get("target_role") or None, opportunity_type=row.get("opportunity_type") or None,
                   scrape_id=row.get("scrape_id") or None)

    @property
    def label(self) -> str:
        return self.name or self.website_url or self.id


@dataclass
class FitRequest:
    """One company for the AI to judge: its homepage text and what the candidate asks it about."""
    text: str
    seeking: str        # e.g. "Backend Developer (internship)"


@dataclass
class Verdict:
    """The AI's answer for one lead: is it a fit, and its short summary of the business (None if the reply
    had no summary, or no AI call was made)."""
    qualified: bool
    summary: str | None = None


@dataclass
class ScrapeResult:
    """One lead's outcome: the `website_scrapes` row (new, or `scrape_id`'s, now with a verdict) plus the
    emails for `websites.email`.

    is_qualified is True/False once the AI has answered, or None when it hasn't yet (the row is still
    saved so Jina's data isn't lost; `load.pending_websites` offers it again later). A Jina failure is
    recorded as False straight away — that's terminal, not retried.
    """
    website_id: str
    is_qualified: bool | None
    scrape_id: str | None = None        # set when this re-asked the AI about an already-saved row
    text: str = ""                      # the homepage text the AI judges ("" = the homepage couldn't be read)
    main_links: dict[str, str] | None = None   # {link text: url}, the pages the internal pool scrapes
    summary: str | None = None          # the AI's short summary of the business (None until the AI answers)
    emails: list[str] = field(default_factory=list)
    tokens: int | str = "?"             # Jina tokens the read cost
    llm_error: Exception | None = None  # an LLMUnavailable, set when is_qualified is None because the AI
                                        # provider rejected our credentials or every model is out of quota;
                                        # the worker saves the row, then reports it so the pool holds
