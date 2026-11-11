"""Cold-email orchestrator: a round of UncontactedLeads + the CandidateProfile -> one EmailPlan each.

    pick a usable address -> the AI writes the application (rule-checked, rewritten with feedback) -> wrap it
    in the greeting and the candidate's signature

Sending is not done here: the worker records the email as "sending", delivers it (the Telegram chat or a
mail provider, EMAIL.delivery) and records the outcome (worker.py), so a crash between send and DB write can
never leave a lead looking uncontacted.
"""

from __future__ import annotations

from core.errors import LeadFailed, LeadSkipped
from core.log import slog
from stages.profile.models import CandidateProfile

from .models import Draft, EmailPlan, UncontactedLead
from .recipients import pick_email
from .writer import compose, write_many


class NoApprovedDraft(LeadFailed):
    """The AI answered, but no draft passed the rules (permanent: in send mode the worker records a
    `generation_failed` row, so the lead stops coming back)."""

    def __init__(self, to_email: str) -> None:
        super().__init__("no draft passed the rules", permanent=True)
        self.to_email = to_email


async def write_emails(leads: list[UncontactedLead], profile: CandidateProfile,
                       attachment_name: str | None = None) -> list[EmailPlan | Exception]:
    """The approved application to each lead from the candidate in `profile`, in order, or what stopped it.
    `attachment_name` is the resume file that will go with them (None = text-only emails, which then mustn't
    mention an attachment). Never raises (except on cancellation); an item is instead:

        LeadSkipped: the lead has no usable email address.
        NoApprovedDraft: no draft passed the rules.
        LeadFailed: an AI call failed (retryable).
        LLMUnavailable: the AI provider rejected our credentials (LLMAuthError), or every email model is
            out of quota (LLMQuotaExhausted).
    """
    out: list[EmailPlan | Exception] = []
    addresses = [pick_email(lead.email) for lead in leads]
    writable = [(lead, to) for lead, to in zip(leads, addresses) if to]
    for lead, to_email in writable:
        slog(f"[cold_email] {lead.label}: writing the application for {to_email}")
    drafts = iter(await write_many([lead for lead, _ in writable], profile, attached=attachment_name is not None))
    for lead, to_email in zip(leads, addresses):
        if not to_email:
            out.append(LeadSkipped("no valid email address"))
            continue
        draft = next(drafts)
        if isinstance(draft, Draft):
            out.append(EmailPlan(website_id=lead.id, to_email=to_email, subject=draft.subject,
                                 body=compose(lead.name, draft.body, profile), attachment_name=attachment_name))
        else:
            out.append(draft if isinstance(draft, Exception) else NoApprovedDraft(to_email))
    return out


async def write_email(lead: UncontactedLead, profile: CandidateProfile,
                      attachment_name: str | None = None) -> EmailPlan:
    """`write_emails` for one lead, raising what it would report."""
    result = (await write_emails([lead], profile, attachment_name))[0]
    if isinstance(result, Exception):
        raise result
    return result
