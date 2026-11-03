"""What the cold_email service takes (an uncontacted lead) and returns (the email to send)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class UncontactedLead:
    """A row of the email queue (`store.uncontacted_leads`): a company with pages and no `cold_emails` row yet."""
    id: str                             # websites.id
    name: str = ""
    category: str = ""                  # the task's search category, e.g. "software company"
    location: str = ""
    email: str = ""                     # websites.email: possibly several, comma-separated
    content_json: Any = None            # JSON array of the lead's scraped internal pages
    industry: str = ""                  # LinkedIn's industry label
    employee_size: str = ""             # e.g. "11-50 employees"
    summary: str = ""                   # the scrape pool's fit summary of the company
    target_role: str | None = None      # the task's override; None = the candidate profile's roles
    opportunity_type: str | None = None # likewise

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "UncontactedLead":
        return cls(id=row["id"], name=row.get("name") or "", category=row.get("category") or "",
                   location=row.get("location") or "", email=row.get("email") or "",
                   content_json=row.get("content_json"), industry=row.get("industry") or "",
                   employee_size=row.get("employee_size") or "", summary=row.get("summary") or "",
                   target_role=row.get("target_role") or None,
                   opportunity_type=row.get("opportunity_type") or None)

    @property
    def label(self) -> str:
        return self.name or self.id


@dataclass
class Draft:
    """One email written by the AI. `body` has no greeting or signature yet."""
    subject: str
    body: str


@dataclass
class EmailPlan:
    """The approved email for one lead, signature included: ready to send."""
    website_id: str
    to_email: str
    subject: str
    body: str
    attachment_name: str | None = None  # the resume file sent with it (None = text only)
