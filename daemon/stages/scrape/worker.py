"""Scrape pool: every new lead's homepage (jina + llm), plus leads the AI couldn't answer for last time.
"Qualified" = the AI thinks the company plausibly has work for the candidate in the role asked about
(their candidate profile, see stages/profile/), so the pool waits until that profile is ready.

Queue: `store.pending_websites`, leads with no `website_scrapes` row yet, plus leads whose row still waits on
a verdict (`is_qualified IS NULL`: Jina isn't re-fetched, only the AI is asked again). A round's fit checks
go to the AI together (stages/scrape/qualify.py).

How a lead's row ends up (see run.py):

    Jina couldn't read the homepage      -> is_qualified=False, terminal (never retried)
    Jina succeeded, the AI answered      -> is_qualified=True/False
    Jina succeeded, the AI call failed   -> is_qualified=None, offered again by the queue
"""

from __future__ import annotations

from config import AI
from core.clients import get_jina, get_llm
from core.db import Db
from core.errors import LeadFailed
from core.log import slog
from core.worker import Outcome, Worker, gather_outcomes
from stages.profile.store import ProfileCache
from stages.scrape import store
from stages.scrape.models import ScrapeJob, ScrapeResult
from stages.scrape.run import run_site_scrape

# The fit check judges each company for the candidate, so nothing is loaded until their profile is ready
_profile = ProfileCache("scrape")


async def pending_scrape_work(db: Db) -> list[ScrapeJob]:
    """The queue: empty until the candidate profile is ready."""
    if await _profile.refresh(db) is None:
        return []
    return await store.pending_websites(db)


async def run_scrape_batch(db: Db, jobs: list[ScrapeJob]) -> list[Outcome]:
    saved_reads, outcomes = {}, {}
    for i, job in enumerate(jobs):
        if job.scrape_id:
            try:
                saved_reads[job.id] = await store.saved_read(db, job.scrape_id)
            except Exception as exc:  # noqa: BLE001 — this lead fails; the rest of the round goes on
                outcomes[i] = exc
    todo = [i for i in range(len(jobs)) if i not in outcomes]
    results = await run_site_scrape([jobs[i] for i in todo], _profile.current, saved_reads)
    saved = await gather_outcomes(*(_save(db, jobs[i], r) for i, r in zip(todo, results)))
    outcomes.update(zip(todo, saved))
    return [outcomes[i] for i in range(len(jobs))]


async def _save(db: Db, job: ScrapeJob, result: ScrapeResult) -> None:
    """Save one lead's result. Raises what the Worker should record: the AI's `llm_error` (after saving, so
    the pool holds), or LeadFailed for a lead still without a verdict."""
    if result.scrape_id:        # the AI was asked again about a saved read
        if result.is_qualified is None:
            raise result.llm_error or LeadFailed("still no verdict from the AI; left NULL for the next pass")
        await store.update_qualification(db, result.scrape_id, result.is_qualified, result.summary)
        slog(f"[site_scrape] {job.label}: {'✅ qualified' if result.is_qualified else '❌ unqualified'} (asked again)")
        return

    await store.persist_scrape(db, result)
    if result.is_qualified is None:
        slog(f"[site_scrape] {job.label}: saved, no verdict yet (is_qualified left NULL)")
    else:
        slog(f"[site_scrape] {job.label}: {'✅ qualified' if result.is_qualified else '❌ unqualified'}, saved"
             f"{f', {len(result.emails)} email(s)' if result.emails else ''} (Jina tokens: {result.tokens})")
    if result.llm_error:
        raise result.llm_error   # saved above; now let the pool hold


def make_worker(db: Db) -> Worker:
    get_jina()   # fail now, with one clear message, if a key is missing
    get_llm("qualify")
    return Worker(
        name="scrape",
        db=db,
        load=pending_scrape_work,
        run_batch=run_scrape_batch,
        batch_size=max(6, AI.qualify_batch),    # leads in flight together: enough to fill one AI batch
        idle_sleep=30.0,    # new leads arrive in bursts from the sourcing pool
    )
