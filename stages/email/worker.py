"""Email pool: a job / internship application to every uncontacted company (llm + a mailer), resume attached.

Queue: `store.uncontacted_leads`, loaded only once the candidate profile is ready (and, with
EMAIL.attach_resume, has a resume). Per round: write_emails (the AI writes, rule-checked; the round's first
drafts go to the AI together) → per lead, in "send" mode, record the row as `sending`, deliver it through
EMAIL.delivery (the Telegram chat, with copy buttons, for the candidate to send by hand; or Gmail / Outlook, straight to the company), record `sent` / `send_failed` / `rejected`. An answer that never came back
from a mail provider leaves the row `sending`: it may have been delivered, so the lead is not retried. In
"dry_run" mode (config.py -> EMAIL) nothing is sent: the email is saved as a `draft` row (shown on the
dashboard's Cold emails page) and the lead is not drafted again. Going live deletes the drafts first, so
those leads get their real email.
"""

from __future__ import annotations

import logging
from datetime import date

from apis.mail import REJECTED, SENT, UNCERTAIN, Attachment
from config import AI, EMAIL, credentials
from core.clients import get_llm, get_mailer
from core.db import Db
from core.errors import LeadFailed
from core.log import slog
from core.worker import Outcome, Worker, gather_outcomes
from stages.email import store
from stages.email.models import EmailPlan, UncontactedLead
from stages.email.run import NoApprovedDraft, write_emails
from stages.profile.models import CandidateProfile
from stages.profile.store import ProfileCache

log = logging.getLogger(__name__)


class SendBudget:
    """Counts today's sent emails against EMAIL.max_sends_per_day (the count starts again at midnight)."""

    def __init__(self, max_per_day: int | None) -> None:
        self.max_per_day = max_per_day
        self._day = date.today()
        self.sent = 0

    def _roll(self) -> None:
        if date.today() != self._day:
            self._day, self.sent = date.today(), 0

    def add(self) -> None:
        self._roll()
        self.sent += 1

    def exhausted(self) -> str | None:
        """Why the pool must hold, or None."""
        self._roll()
        if self.max_per_day and self.sent >= self.max_per_day:
            return f"sent today's {self.max_per_day} email(s) (EMAIL.max_sends_per_day); resuming after midnight"
        return None


class ResumeCache:
    """The resume file, read once per upload (keyed by its sha256) and reused for every email."""

    def __init__(self) -> None:
        self._sha = ""
        self.attachment: Attachment | None = None

    async def refresh(self, db: Db, profile: CandidateProfile) -> Attachment | None:
        """The current resume, re-read only when a different file was uploaded. None when there is no
        resume, or it can't be read (logged)."""
        if not profile.resume_path:
            self._sha, self.attachment = "", None
            return None
        if self.attachment is not None and profile.resume_sha256 and profile.resume_sha256 == self._sha:
            return self.attachment
        try:
            data = await db.read_resume(profile.resume_path)
        except Exception as exc:  # noqa: BLE001 — the pool waits and tries again at the next load
            log.error("worker[email] could not read the resume '%s': %s", profile.resume_path, exc)
            self._sha, self.attachment = "", None
            return None
        self._sha = profile.resume_sha256
        self.attachment = Attachment(profile.resume_filename or "resume.pdf", data)
        log.info("worker[email] resume '%s' loaded (%d KB)", self.attachment.filename, len(data) // 1024)
        return self.attachment


def make_worker(db: Db) -> Worker | None:
    """The email pool, or None when config.py -> EMAIL.enabled is False."""
    if not EMAIL.enabled:
        return None
    dry_run = EMAIL.mode == "dry_run"
    get_llm("email")            # fail now, with one clear message, if a key is missing
    delivery = EMAIL.delivery
    mailer = None if dry_run else get_mailer(delivery)   # RuntimeError naming what that channel is missing
    if mailer is not None:
        log.info("worker[email] send mode: delivering through %s", delivery)
    budget = SendBudget(EMAIL.max_sends_per_day)
    profiles = ProfileCache("email")
    resume = ResumeCache()
    no_resume_said = False
    drafts_cleared = dry_run

    async def load_leads(db: Db) -> list[UncontactedLead]:
        nonlocal drafts_cleared, no_resume_said
        profile = await profiles.refresh(db)
        if profile is None:
            return []
        if EMAIL.attach_resume and await resume.refresh(db, profile) is None:
            if not no_resume_said:
                log.warning("worker[email] waiting: no resume to attach (upload one on the Profile page, or set "
                            "EMAIL.attach_resume=False for text-only emails)")
                no_resume_said = True
            return []
        no_resume_said = False
        if not drafts_cleared:      # once, before the first send-mode load
            await store.clear_drafts(db)
            drafts_cleared = True
        return await store.uncontacted_leads(db)

    async def run_round(db: Db, leads: list[UncontactedLead]) -> list[Outcome]:
        attachment = resume.attachment if EMAIL.attach_resume else None
        plans = await write_emails(leads, profiles.current, attachment.filename if attachment else None)
        return await gather_outcomes(*(deliver(db, lead, plan, attachment) for lead, plan in zip(leads, plans)))

    async def deliver(db: Db, lead: UncontactedLead, plan: EmailPlan | Exception,
                      attachment: Attachment | None) -> None:
        if isinstance(plan, NoApprovedDraft) and not dry_run:
            await store.record_generation_failure(db, lead.id, plan.to_email)  # the queue stops returning it
        if isinstance(plan, Exception):
            raise plan

        if dry_run:
            await store.save_draft(db, plan)
            slog(f"[cold_email] {lead.label} → {plan.to_email}: draft saved (DRY RUN, not sent)")
            return

        record_id = await store.create_sending(db, plan, delivery)
        status, detail = await mailer.send(plan.to_email, plan.subject, plan.body,
                                           [attachment] if attachment else None,
                                           from_name=profiles.current.full_name)
        if status == UNCERTAIN:     # it may have gone out: the row stays "sending", which the queue excludes
            budget.add()
            raise LeadFailed(f"no answer from {delivery}, it may have been sent; left as 'sending' (check the "
                             f"Sent folder): {detail}", permanent=True)
        try:
            await store.mark_email(db, record_id, status)
        except Exception as exc:  # noqa: BLE001 — the row stays "sending", which the queue also excludes
            slog(f"[cold_email] failed to update cold_emails row {record_id}: {exc}")
        if status == SENT:
            budget.add()
            slog(f"[cold_email] {lead.label} → {plan.to_email}: ✅ sent via {delivery} ({detail})")
        elif status == REJECTED:    # the address is unusable: the lead is done
            raise LeadFailed(f"{delivery} refused {plan.to_email}: {detail}", permanent=True)
        else:   # send_failed: the queue returns the lead again, and it is retried after the backoff
            raise LeadFailed(f"not sent via {delivery}: {detail}")

    return Worker(
        name="email",
        db=db,
        load=load_leads,
        run_batch=run_round,
        gate=budget.exhausted,
        batch_size=max(2, AI.email_batch),   # leads in flight together: enough to fill one AI batch
        idle_sleep=60.0,
        max_consecutive_failures=5,   # usually bad delivery credentials (Telegram token, mail sign-in), or the AI is down
    )
