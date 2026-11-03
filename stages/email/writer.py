"""The email writer: has the AI write a job / internship application to a company, checks it against cheap
rules and has it rewritten with the problems found if it fails.

    drafts = await write_many(leads, profile, attached=True)  # one Draft (the middle of the email) per lead,
                                                              # None (no draft passed the rules) or the error
    text = compose(lead.name, draft.body, profile)            # "Hi <company> team," + the middle + the signature

A round's FIRST drafts are written together: up to `AI.email_batch` leads in one prompt, split back per
lead (core/llm.py: ask_in_batches; prompts.parse_email_drafts). A rewrite (after a draft failed the rule
check) always goes out on its own, since its feedback is specific to that lead.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass

import config
from config import credentials
from core.clients import get_llm
from core.errors import LeadFailed
from core.llm import LLMUnavailable, ask_in_batches
from core.log import slog
from prompts import COLD_EMAIL, COLD_EMAIL_BATCH, cold_email_batch_prompt, cold_email_prompt, parse_email_draft, \
    parse_email_drafts
from stages.profile.models import CandidateProfile

from .models import Draft, UncontactedLead
from .recipients import greeting

MAX_CONTEXT_CHARS = 2000   # characters of content_json passed to the AI as context
GENERATION_ATTEMPTS = 3     # write -> check rounds per lead before giving up on it
MIN_BODY_WORDS = 60         # the prompt asks for 70-140 words; the rule check allows some slack
MAX_BODY_WORDS = 155
MAX_PARAGRAPHS = 3          # the prompt asks for 2 or 3 short ones
MAX_PARAGRAPH_WORDS = 70    # "no longer than 3 lines", with some slack

GREETING_RE = re.compile(r"\s*(hi|hello|hey|dear)\b", re.I)
SIGN_OFF_RE = re.compile(r"^\s*(best|best regards|regards|kind regards|sincerely|cheers|thanks|thank you)[,!.]?\s*$",
                         re.I | re.M)
LIST_LINE_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s", re.M)
DASH_RE = re.compile(r"[—–]|\s-{1,2}\s|--")     # em / en dash, or a hyphen used as one
URL_RE = re.compile(r"(?:https?://|www\.)[^\s<>()\"']+", re.I)
RESUME_RE = re.compile(r"r[eé]sum[eé]|\bcv\b", re.I)


@dataclass
class _Job:
    """One lead's application, as the writer carries it."""
    lead: UncontactedLead
    profile: CandidateProfile
    attached: bool


def _research_text(lead: UncontactedLead) -> str:
    return json.dumps(lead.content_json, ensure_ascii=False)[:MAX_CONTEXT_CHARS]


def _lead_facts(lead: UncontactedLead, profile: CandidateProfile) -> dict:
    return {"name": lead.name, "category": lead.category, "industry": lead.industry, "size": lead.employee_size,
            "location": lead.location, "fit_summary": lead.summary,
            "seeking": profile.seeking(lead.target_role, lead.opportunity_type)}


def _candidate(profile: CandidateProfile, attached: bool) -> str:
    brief = profile.brief()
    return brief if attached else brief + "\n- Note: no resume is attached to this email; don't mention one."


async def write_many(leads: list[UncontactedLead], profile: CandidateProfile, *,
                     attached: bool) -> list[Draft | None | Exception]:
    """One answer per lead, in order: an approved Draft, None (no draft passed the rules), or the error —
    LLMUnavailable (the provider rejected our credentials or every model is out of quota) or LeadFailed (an
    AI call failed otherwise; nothing is recorded and the lead is retried later). `attached` = the resume
    goes with the email (the draft must mention it). Never raises (except on cancellation)."""
    jobs = [_Job(lead, profile, attached) for lead in leads]

    async def ask_batch(chunk: list[_Job]) -> dict[int, Draft]:
        prompt = cold_email_batch_prompt(_candidate(profile, attached),
                                         [_lead_facts(j.lead, profile) for j in chunk],
                                         [_research_text(j.lead) for j in chunk], profile.links(),
                                         config.EMAIL.instructions)
        reply = await get_llm("email").chat(prompt, response_format=COLD_EMAIL_BATCH)
        return {n: Draft(*draft) for n, draft in parse_email_drafts(reply, len(chunk)).items()}

    first = await ask_in_batches(jobs, size=config.AI.email_batch, ask_batch=ask_batch,
                                 ask_one=lambda job, attempts: _generate(job, attempts=attempts),
                                 what="[cold_email] first drafts")
    results = await asyncio.gather(*(_check_and_rewrite(job, draft) for job, draft in zip(jobs, first)),
                                   return_exceptions=True)
    for r in results:
        if isinstance(r, BaseException) and not isinstance(r, Exception):
            raise r
    return list(results)


async def _check_and_rewrite(job: _Job, first: Draft | None | Exception) -> Draft | None:
    """Rule-check the first draft; rewrite with the problems found until one passes. None = none passed."""
    if isinstance(first, Exception):
        raise first
    draft, feedback = first, None
    for attempt in range(1, GENERATION_ATTEMPTS + 1):
        if attempt > 1:
            draft = await _generate(job, feedback)
        if not draft:
            feedback = ["reply with valid JSON containing a non-empty subject and body"]
            continue
        issues = check_rules(draft, job.profile.links(), attached=job.attached)
        if not issues:
            return draft
        slog(f"[cold_email] {job.lead.label}: attempt {attempt} rejected: {'; '.join(issues)}")
        feedback = issues
    return None


async def _generate(job: _Job, feedback: list[str] | None = None, *, attempts: int | None = None) -> Draft | None:
    """Ask the AI for one draft (no greeting or signature yet), or None if its reply isn't usable
    subject/body JSON. Raises LLMUnavailable, or LeadFailed for any other AI error."""
    lead, profile = job.lead, job.profile
    prompt = cold_email_prompt(_candidate(profile, job.attached), _lead_facts(lead, profile), _research_text(lead),
                               profile.links(), feedback, config.EMAIL.instructions)
    try:
        text = await get_llm("email").chat(prompt, response_format=COLD_EMAIL, attempts=attempts)
    except LLMUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 — surfaced as a retryable failure of this lead
        raise LeadFailed(f"AI error while writing: {type(exc).__name__}: {str(exc)[:200]}") from exc
    if draft := parse_email_draft(text):
        return Draft(*draft)
    slog(f"[cold_email] {lead.label}: the AI reply was not valid subject/body JSON", level=logging.WARNING)
    return None


def check_rules(draft: Draft, allowed_links: list[str], *, attached: bool) -> list[str]:
    """Cheap, token-free checks on a draft. Returns a list of problems (empty = OK).

    `allowed_links` are the candidate's own (LinkedIn, portfolio): optional, and the only links allowed.
    The Oxford comma rule is left to the prompt: "a, b, and c" can't be told apart from an ordinary
    ", and" between clauses without false alarms, and each false alarm costs a rewrite."""
    subject, body = draft.subject, draft.body
    issues = []
    if not 2 <= len(subject.split()) <= 10:
        issues.append("the subject must be 3 to 8 words")
    if GREETING_RE.match(body):
        issues.append("remove the greeting; it is added automatically, start with the first paragraph")
    words = len(body.split())
    if not MIN_BODY_WORDS <= words <= MAX_BODY_WORDS:
        issues.append(f"the body is {words} words; it must be 70 to 140 words")
    paragraphs = [p for p in re.split(r"\n\s*\n", body.strip()) if p.strip()]
    if len(paragraphs) > MAX_PARAGRAPHS:
        issues.append(f"the body has {len(paragraphs)} paragraphs; use 2 or 3 short ones")
    elif len(paragraphs) == 1 and words > MAX_PARAGRAPH_WORDS:
        issues.append("split the body into 2 or 3 short paragraphs separated by a blank line")
    if any(len(p.split()) > MAX_PARAGRAPH_WORDS for p in paragraphs):
        issues.append("a paragraph is too long; keep each one to 3 lines")
    if LIST_LINE_RE.search(body):
        issues.append("write in short paragraphs, with no bullet points or numbered lists")
    if DASH_RE.search(subject + "\n" + body):
        issues.append("remove every dash (—, – or a hyphen between words); use a comma or a full stop instead")
    allowed = {u.rstrip("/").lower() for u in allowed_links}
    urls = [u.rstrip(".,;:!?").rstrip("/").lower() for u in URL_RE.findall(subject + "\n" + body)]
    if any(u not in allowed for u in urls):
        issues.append(f"remove every link except {', '.join(allowed_links)}" if allowed_links
                      else "remove every link; the email must not contain any")
    if attached and not RESUME_RE.search(body):
        issues.append("say in the last paragraph that your resume is attached")
    if re.search(r"\[[^\]]*\]|\{\{|\}\}", subject + body):
        issues.append("remove placeholders like [Name]")
    if SIGN_OFF_RE.search(body):
        issues.append("remove the sign off; a signature is added automatically")
    return issues


def signature(profile: CandidateProfile) -> str:
    """The sign off: the candidate's name, then whichever of their phone and links they gave."""
    name = profile.full_name
    lines = ["Best regards,", name, profile.phone, profile.linkedin_url, profile.portfolio_url]
    return "\n".join(line for line in lines if line)


def compose(name: str | None, body: str, profile: CandidateProfile) -> str:
    """The whole email: the greeting for the company's team, the AI's middle, then the signature."""
    return f"{greeting(name)}\n\n{body.strip()}\n\n{signature(profile)}"
