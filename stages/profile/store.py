"""All SQL of the profile stage: the `candidate_profile` row (the pool's queue while it is `pending`, and what
every other pool reads), and saving a derive.

Also here: `ProfileCache`, how the scrape and email pools read the profile. They reload it with each queue load
(so dashboard edits apply without a restart) and work on nothing until it is ready.
"""

from __future__ import annotations

import logging

from core.db import Db
from core.sqlite import set_clause, utc_now
from stages.profile.models import CandidateProfile, ProfileJob, ProfileResult

log = logging.getLogger(__name__)


async def candidate_profile(db: Db) -> CandidateProfile | None:
    """The one `candidate_profile` row, or None when the user hasn't created it yet. Raises if the DB can't
    be read."""
    row = await db.fetch_one("SELECT * FROM candidate_profile WHERE id = 1", what="load candidate profile")
    return CandidateProfile.from_row(row) if row else None


async def pending_profile(db: Db) -> list[ProfileJob]:
    """The profile row while it waits to be (re)derived (`parse_status = 'pending'`): the profile pool's queue."""
    rows = await db.fetch_all("SELECT * FROM candidate_profile WHERE id = 1 AND parse_status = 'pending'",
                              what="pending candidate profile")
    return [ProfileJob(CandidateProfile.from_row(r)) for r in rows]


async def save_profile(db: Db, job: ProfileJob, result: ProfileResult) -> bool:
    """Record a derive: the fields the AI found + `done`, or `failed` + the error. A derived field that came
    back empty leaves the stored value alone (a re-derive from notes alone doesn't wipe the phone number).

    Only applied while the row is still the one that was loaded (same `updated_at`): if the user uploaded
    a new resume or edited the notes meanwhile, it is left `pending` for the next pass. Returns whether it
    was applied. Raises if the update fails."""
    update: dict = {"parsed_at": utc_now()}
    if result.resume_text is not None:
        update["resume_text"] = result.resume_text
    if result.derived is None:
        update.update(parse_status="failed", parse_error=result.error)
    else:
        update.update(parse_status="done", parse_error=None)
        for key, value in vars(result.derived).items():
            if value not in ("", None, []):
                update[key] = value
    assignments, params = set_clause(update)
    changed = await db.execute(f"UPDATE candidate_profile SET {assignments} WHERE id = 1 AND updated_at = :loaded_at",
                               {**params, "loaded_at": job.profile.updated_at}, what="save candidate profile")
    return changed > 0


class ProfileCache:
    """The candidate profile as one pool last loaded it."""

    def __init__(self, pool: str) -> None:
        self.pool = pool
        self.current: CandidateProfile | None = None
        self._said: str | None = None       # the "not ready" reason last logged, so it's logged once

    async def refresh(self, db: Db) -> CandidateProfile | None:
        """Reload the profile. Returns it when it is ready to use, else None (logged once per reason)."""
        profile = await candidate_profile(db)
        if profile is None:
            why = "no candidate profile yet: upload a resume on the dashboard's Profile page"
        elif not profile.ready:
            why = (f"the candidate profile is '{profile.parse_status or 'empty'}', not ready yet"
                   + (" (it is waiting for the profile pool)" if profile.parse_status == "pending" else ""))
        else:
            why = None
        if why != self._said:
            if why:
                log.warning("worker[%s] waiting: %s", self.pool, why)
            elif self._said:
                log.info("worker[%s] candidate profile ready", self.pool)
            self._said = why
        self.current = profile if why is None else None
        return self.current
