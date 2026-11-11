"""Site-scrape orchestrator: a round of ScrapeJobs -> one ScrapeResult each.

    homepage via Jina -> parse (links, main internal pages, emails) -> the AI summarizes the homepage text
    and decides whether the company fits the candidate (their profile and the role asked about)

A job whose homepage is already saved (`scrape_id`: the AI didn't answer last time) skips Jina; the worker
hands its saved text in. Every website_url is assumed present (the sourcing pool never saves a lead
without one). Nothing here raises for a Jina or AI failure: both become part of the result, so the worker
always has something to save:

    Jina can't read the homepage          -> is_qualified=False (terminal: this lead won't be retried)
    Jina succeeds, the AI answers         -> is_qualified=True/False
    Jina succeeds, the AI call fails      -> is_qualified=None (offered again later by the queue)

`LLMUnavailable` (a rejected key, or every qualify model out of quota) is carried as `llm_error` on a result
with is_qualified=None: the worker saves the row, then reports the error so the pool holds instead of
hammering a dead key or a used-up quota. Nothing is saved here (store.py does).
"""

from __future__ import annotations

import asyncio
import logging

from apis.jina_parsing import page_text, parse_jina_response
from core.clients import get_jina
from core.llm import LLMUnavailable
from core.log import slog
from stages.profile.models import CandidateProfile

from .models import FitRequest, ScrapeJob, ScrapeResult, Verdict
from .qualify import qualify_many

MAX_MAIN_LINKS = 5      # main internal pages picked from the homepage's links for the internal pool
QUALIFY_CONTEXT_CHARS = 3000    # characters of homepage text the AI summarizes and qualifies


async def run_site_scrape(jobs: list[ScrapeJob], profile: CandidateProfile | None,
                          saved_reads: dict[str, dict | None] | None = None) -> list[ScrapeResult]:
    """One result per job, in order. `saved_reads`
    holds, by job id, the saved homepage of each job that has a `scrape_id` (`store.saved_read`)."""
    saved_reads = saved_reads or {}
    results = list(await asyncio.gather(*(
        _saved(job, saved_reads.get(job.id)) if job.scrape_id else read_homepage(job) for job in jobs)))

    undecided = [(job, r) for job, r in zip(jobs, results) if r.is_qualified is None]
    for _, r in undecided:
        if not r.text:
            r.is_qualified = False      # nothing on the page to judge
    asks = [(job, r) for job, r in undecided if r.text]
    answers = await qualify_many([FitRequest(r.text, profile.seeking(job.target_role, job.opportunity_type))
                                  for job, r in asks], profile.brief())
    for (job, r), answer in zip(asks, answers):
        if isinstance(answer, Verdict):
            r.is_qualified, r.summary = answer.qualified, answer.summary
        elif isinstance(answer, LLMUnavailable):
            r.llm_error = answer
        elif isinstance(answer, Exception):
            slog(f"[site_scrape] {job.label}: no verdict ({type(answer).__name__}: {answer})", level=logging.WARNING)
    return results


async def read_homepage(site: ScrapeJob) -> ScrapeResult:
    """Jina's read of `site`'s homepage, parsed: is_qualified=False when it can't be read, else None (to be
    decided)."""
    slog(f"[site_scrape] {site.label}: reading {site.website_url} via Jina")
    resp = await get_jina().read(site.website_url)
    if resp is None or resp.get("code") != 200:
        reason = "Jina could not read the homepage" if resp is None else f"Jina answered code {resp.get('code')}"
        slog(f"[site_scrape] {site.label}: {reason} — saving as unqualified", level=logging.WARNING)
        return ScrapeResult(website_id=site.id, is_qualified=False)
    parsed = parse_jina_response(resp, base_url=site.website_url, max_main_links=MAX_MAIN_LINKS)
    return ScrapeResult(
        website_id=site.id, is_qualified=None, text=page_text(parsed["raw_json"] or {}, QUALIFY_CONTEXT_CHARS),
        main_links=parsed["main_links"], emails=parsed.get("emails") or [],
        tokens=(resp.get("data") or {}).get("usage", {}).get("tokens", "?"),
    )


async def _saved(job: ScrapeJob, saved: dict | None) -> ScrapeResult:
    """An already-saved homepage, ready for the AI to be asked again (a row from before `homepage_text`
    existed has Jina's whole read instead)."""
    saved = saved or {}
    text = saved.get("homepage_text") or page_text(saved.get("raw_json") or {}, QUALIFY_CONTEXT_CHARS)
    return ScrapeResult(website_id=job.id, is_qualified=None, scrape_id=job.scrape_id, text=text)
