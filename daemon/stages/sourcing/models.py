"""What every lead source produces: `websites` rows, saved one by one as they are found, and a run summary.

A source never touches the DB itself. The worker injects a `SaveLead` callback (store.insert_website) that inserts one lead and says how it went, so a long run keeps what it found even if it
stops half-way, and a source that must save N leads knows when it has.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Awaitable, Callable

# SaveLead outcomes (all strings are truthy, so compare with `== SAVED`, don't test truthiness)
SAVED = "saved"
DUPLICATE = "duplicate"     # the DB's unique index refused it: the site is already a lead
ERROR = "error"


@dataclass
class LeadRecord:
    """One lead: the columns of `websites`. A source leaves out what it doesn't collect."""
    name: str
    website_url: str
    phone_number: str | None = None
    category: str | None = None
    location: str | None = None
    owner: str | None = None
    source: str | None = None           # "Google Maps" / "Linkedin"
    employee_size: str | None = None    # LinkedIn's size band as shown, e.g. "11-50 employees"
    employee_max: int | None = None     # the band's upper bound, e.g. 50
    industry: str | None = None         # LinkedIn's own industry label
    linkedin_url: str | None = None
    target_role: str | None = None      # the task's role override; None = the candidate profile's roles
    opportunity_type: str | None = None # the task's "job"/"internship"/"either" override; None = the profile's


SaveLead = Callable[[LeadRecord], Awaitable[str]]


@dataclass
class SourcingTask:
    """One row of `tasks` (db/schema.sql): what the user asked the daemon to source."""
    task_id: int
    updated_at: str
    source: str                         # "linkedin"
    category: str                       # kind of company, e.g. "software company"
    location: str
    candidates: int                     # leads to save
    metro_radius_km: float | None = None
    leads_saved: int = 0                # progress counter, carried over when a task is re-queued
    max_employees: int | None = None    # largest company size band accepted; None = the source's default
    target_role: str | None = None      # None = the candidate profile's roles
    opportunity_type: str | None = None # None = the candidate profile's

    @classmethod
    def from_row(cls, row: dict) -> "SourcingTask":
        return cls(task_id=row["id"], updated_at=row["updated_at"], source=row["source"],
                   category=row["category"], location=row["location"], candidates=row["candidates"],
                   metro_radius_km=row.get("metro_radius_km"), leads_saved=row.get("leads_saved") or 0,
                   max_employees=row.get("max_employees"), target_role=(row.get("target_role") or "").strip() or None,
                   opportunity_type=row.get("opportunity_type") or None)

    @property
    def id(self) -> str:
        """The Worker's key for this run of the task. `updated_at` changes whenever the row does (a DB
        trigger), so a task the user re-queues is a new item, not one the Worker remembers as done."""
        return f"{self.task_id}@{self.updated_at}"

    @property
    def label(self) -> str:
        return f"task #{self.task_id} '{self.category}' in '{self.location}'"


@dataclass
class SourcingRun:
    """How one run of a lead source went."""
    source: str
    searches: int = 0                   # business types x locations
    search_failures: int = 0            # searches that failed even after their retries
    saved: int = 0
    duplicates: int = 0
    db_errors: int = 0
    fetches: int = 0                    # pages fetched (LinkedIn)
    rejects: Counter = field(default_factory=Counter)   # reason -> leads skipped for it
    aborted: str = ""                   # why the run stopped early ("" = it ran to the end)
    shortfalls: list[str] = field(default_factory=list)   # searches that saved fewer leads than wanted, and why

    def summary(self) -> str:
        parts = [f"saved {self.saved}",
                 f"{self.search_failures}/{self.searches} searches failed"]
        if self.fetches:
            parts.append(f"{self.fetches} pages fetched")
        if self.db_errors:
            parts.append(f"{self.db_errors} DB errors")
        parts += [f"skipped {n}: {reason}" for reason, n in self.rejects.most_common()]
        if self.aborted:
            parts.append(f"stopped early: {self.aborted}")
        return "; ".join(parts)

    @property
    def failed(self) -> bool:
        """Nothing usable came out: every search failed, or the run was stopped before saving anything."""
        return bool(self.searches) and (self.search_failures == self.searches or (bool(self.aborted) and not self.saved))
