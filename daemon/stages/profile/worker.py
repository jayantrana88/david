"""Profile pool: the candidate's resume (and notes) -> the derived career profile (llm).

Queue: the single `candidate_profile` row while it is `parse_status = 'pending'` — the dashboard sets that
when the user uploads a resume or asks to re-derive. Per pass: read the resume file (data/resumes/) → extract
its text → the AI reads it and the notes → `store.save_profile` writes the fields and `done`, or `failed`
with the reason.
"""

from __future__ import annotations

import logging

from core.clients import get_llm
from core.db import Db
from core.errors import LeadFailed
from core.log import slog
from core.worker import Worker
from stages.profile import store
from stages.profile.models import ProfileJob, ProfileResult
from stages.profile.run import derive_profile

log = logging.getLogger(__name__)


async def run_profile(db: Db, job: ProfileJob) -> None:
    profile = job.profile
    resume = None
    if profile.resume_path:
        try:
            resume = await db.read_resume(profile.resume_path)
        except Exception as exc:  # noqa: BLE001 — recorded on the row: the file is gone or unreadable
            result = ProfileResult(error=f"could not download the resume ({type(exc).__name__}); upload it again")
            await store.save_profile(db, job, result)
            raise LeadFailed(result.error, permanent=True) from exc

    result = await derive_profile(resume, profile.resume_filename, profile.resume_mime, profile.career_notes)
    if not await store.save_profile(db, job, result):
        slog("[profile] the profile changed while it was being read; the newer version is read next")
        return
    if result.error:
        raise LeadFailed(result.error, permanent=True)
    d = result.derived
    slog(f"[profile] ✅ derived: {d.headline or d.full_name}; roles: {', '.join(d.target_roles) or 'none'}; "
         f"looking for: {d.opportunity_type or '(unchanged)'}")


def make_worker(db: Db) -> Worker:
    get_llm("profile")      # fail now, with one clear message, if the key is missing
    return Worker(
        name="profile",
        db=db,
        load=store.pending_profile,
        run=run_profile,
        batch_size=1,
        idle_sleep=15.0,                # the user is usually waiting on the dashboard
        failure_backoff=300.0,
        max_consecutive_failures=None,  # every failure is recorded on the row for the user
    )
