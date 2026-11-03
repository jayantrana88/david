"""The AI call of the site_scrape service: summarize each company, and is it worth the candidate applying to?

A round's companies are judged together: `qualify_many` sends up to `AI.qualify_batch` of them in one
prompt and asks any company the reply doesn't answer clearly again on its own (core/llm.py: ask_in_batches),
so batching never turns into a guessed answer.

Each company's answer is a `Verdict`, None ("no verdict this time": the call failed or the reply held no
clear true/false, not this lead's fault), or an `LLMUnavailable` (the provider rejected our credentials, or
every model's quota is used up) for the caller to act on.
"""

from __future__ import annotations

import logging

import config
from core.clients import get_llm
from core.llm import LLMUnavailable, ask_in_batches
from core.log import slog
from prompts import QUALIFICATION, QUALIFICATION_BATCH, parse_verdict, parse_verdicts, qualification_batch_prompt, \
    qualification_prompt

from .models import FitRequest, Verdict


async def qualify_many(requests: list[FitRequest], candidate: str) -> list[Verdict | None | Exception]:
    """One answer per company, in order, judged for `candidate` (`CandidateProfile.brief()`). Never raises
    (except on cancellation)."""

    async def ask_batch(chunk: list[FitRequest]) -> dict[int, Verdict]:
        prompt = qualification_batch_prompt(candidate, [(r.seeking, r.text) for r in chunk])
        reply = await get_llm("qualify").chat(prompt, response_format=QUALIFICATION_BATCH)
        return {n: Verdict(*answer) for n, answer in parse_verdicts(reply, len(chunk)).items()}

    async def ask_one(request: FitRequest, attempts: int | None) -> Verdict | None:
        try:
            reply = await get_llm("qualify").chat(qualification_prompt(candidate, request.seeking, request.text),
                                                  response_format=QUALIFICATION, attempts=attempts)
        except LLMUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 — no verdict this time; not this lead's fault
            slog(f"[site_scrape] qualification failed: {type(exc).__name__}: {str(exc)[:200]}", level=logging.WARNING)
            return None
        parsed = parse_verdict(reply)
        if parsed is None:
            slog(f"[site_scrape] qualification reply held no clear verdict: {reply[:200]!r}", level=logging.WARNING)
            return None
        return Verdict(*parsed)

    return await ask_in_batches(requests, size=config.AI.qualify_batch, ask_batch=ask_batch, ask_one=ask_one,
                                what="[site_scrape] qualification")
