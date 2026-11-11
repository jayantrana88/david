"""The candidate: the one `candidate_profile` row (db/schema.sql), as the pools use it.

The profile pool fills it from the resume (and the user's own career notes); the scrape pool reads it to
judge whether a company fits, the email pool to write and sign the application and to attach the resume.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

OPPORTUNITY_WORDS = {"job": "job", "internship": "internship", "either": "job or internship"}


def _text(row: dict, key: str) -> str:
    return str(row.get(key) or "").strip()


def _list(row: dict, key: str) -> list[str]:
    value = row.get(key) or []
    return [str(v).strip() for v in value if str(v or "").strip()] if isinstance(value, list) else []


@dataclass
class CandidateProfile:
    """Who is applying. Every derived field may still be empty (a profile made from a few notes)."""
    full_name: str = ""
    headline: str = ""                  # e.g. "Final year CS student, backend and data"
    summary: str = ""                   # 2-4 sentences on their background
    skills: list[str] = field(default_factory=list)
    experience_years: float | None = None
    education: str = ""
    target_roles: list[str] = field(default_factory=list)
    opportunity_type: str = "either"    # "job" | "internship" | "either"
    phone: str = ""
    linkedin_url: str = ""
    portfolio_url: str = ""
    career_notes: str = ""              # what the user wrote about themselves
    resume_path: str = ""               # file name in data/resumes/ ("" = no resume)
    resume_filename: str = ""
    resume_mime: str = ""
    resume_sha256: str = ""
    parse_status: str = ""              # "pending" | "done" | "failed"
    updated_at: str = ""

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "CandidateProfile":
        years = row.get("experience_years")
        return cls(
            full_name=_text(row, "full_name"), headline=_text(row, "headline"), summary=_text(row, "summary"),
            skills=_list(row, "skills"), experience_years=float(years) if years is not None else None,
            education=_text(row, "education"), target_roles=_list(row, "target_roles"),
            opportunity_type=_text(row, "opportunity_type") or "either", phone=_text(row, "phone"),
            linkedin_url=_text(row, "linkedin_url"), portfolio_url=_text(row, "portfolio_url"),
            career_notes=_text(row, "career_notes"), resume_path=_text(row, "resume_path"),
            resume_filename=_text(row, "resume_filename"), resume_mime=_text(row, "resume_mime"),
            resume_sha256=_text(row, "resume_sha256"), parse_status=_text(row, "parse_status"),
            updated_at=_text(row, "updated_at"),
        )

    @property
    def ready(self) -> bool:
        """Derived at least once and usable for writing applications."""
        return self.parse_status == "done" and bool(self.target_roles or self.headline)

    def role_for(self, target_role: str | None = None) -> str:
        """The role to ask a company about: the lead's own (its task's override) or the profile's."""
        if target_role:
            return target_role
        roles = self.target_roles[:3]
        return " or ".join(roles) if roles else (self.headline or "a role that fits my background")

    def opportunity_for(self, opportunity_type: str | None = None) -> str:
        """'job', 'internship' or 'job or internship', for the lead's override or the profile's."""
        return OPPORTUNITY_WORDS.get(opportunity_type or self.opportunity_type, "job or internship")

    def seeking(self, target_role: str | None = None, opportunity_type: str | None = None) -> str:
        """What the candidate asks one company about, e.g. 'Backend Developer (internship)'."""
        return f"{self.role_for(target_role)} ({self.opportunity_for(opportunity_type)})"

    def links(self) -> list[str]:
        """The only links an application may carry."""
        return [u for u in (self.linkedin_url, self.portfolio_url) if u]

    def brief(self) -> str:
        """The candidate in a few lines, for the prompts. Only what's filled in."""
        lines = [
            ("Name", self.full_name), ("Headline", self.headline), ("Background", self.summary),
            ("Skills", ", ".join(self.skills[:15])),
            ("Experience", f"{self.experience_years:g} years" if self.experience_years is not None else ""),
            ("Education", self.education), ("Roles wanted", ", ".join(self.target_roles)),
            ("Looking for", self.opportunity_for()), ("In their own words", self.career_notes[:800]),
        ]
        return "\n".join(f"- {k}: {v}" for k, v in lines if v)


@dataclass
class ProfileJob:
    """The profile pool's one queue item: the `candidate_profile` row while it is `pending`."""
    profile: CandidateProfile

    @property
    def id(self) -> str:
        # `updated_at` changes on every edit (DB trigger), so a re-upload is a new item for the Worker
        return f"profile@{self.profile.updated_at}"

    @property
    def label(self) -> str:
        return "candidate profile"


@dataclass
class DerivedProfile:
    """What the AI read out of the resume and notes. Empty values mean "not found" (the old value is kept)."""
    full_name: str = ""
    headline: str = ""
    summary: str = ""
    skills: list[str] = field(default_factory=list)
    experience_years: float | None = None
    education: str = ""
    target_roles: list[str] = field(default_factory=list)
    opportunity_type: str = ""
    phone: str = ""
    linkedin_url: str = ""
    portfolio_url: str = ""


@dataclass
class ProfileResult:
    """How deriving went: `derived` on success, or `error` (shown on the dashboard's Profile page)."""
    derived: DerivedProfile | None = None
    resume_text: str | None = None      # the text extracted from the resume file, saved for reference
    error: str | None = None
