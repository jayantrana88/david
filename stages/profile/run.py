"""Profile orchestrator: resume bytes + the user's notes -> ProfileResult.

    extract the resume's text (PDF / DOCX) -> the AI reads it and the notes into a DerivedProfile

Like the other services it never touches the DB, and a bad file or an unusable AI reply is returned as data
(`ProfileResult.error`, shown on the dashboard), not raised. The one exception surfaced is `LLMUnavailable`
(a rejected key, or every profile model out of quota): the row stays `pending` and the pool holds.
"""

from __future__ import annotations

import asyncio
import logging

from core.clients import get_llm
from core.llm import LLMUnavailable
from core.log import slog
from prompts import CANDIDATE_PROFILE, parse_profile, profile_prompt

from .extract import UnreadableResume, resume_text
from .models import DerivedProfile, ProfileResult


async def derive_profile(resume: bytes | None, filename: str, mime: str, career_notes: str) -> ProfileResult:
    """The candidate's profile from their resume file (None = no resume uploaded) and their own notes."""
    text = ""
    if resume is not None:
        try:
            text = await asyncio.to_thread(resume_text, resume, filename, mime)
        except UnreadableResume as exc:
            return ProfileResult(error=str(exc))
        slog(f"[profile] resume '{filename}': {len(text)} characters of text")
    if not text and not career_notes.strip():
        return ProfileResult(error="upload a resume or write a few lines about your career first")

    try:
        reply = await get_llm("profile").chat(profile_prompt(text, career_notes), response_format=CANDIDATE_PROFILE)
    except LLMUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 — recorded on the row; the user can ask again from the dashboard
        slog(f"[profile] AI call failed: {type(exc).__name__}: {str(exc)[:200]}", level=logging.WARNING)
        return ProfileResult(resume_text=text or None, error=f"the AI call failed ({type(exc).__name__}); try again")

    fields = parse_profile(reply)
    if fields is None:
        slog(f"[profile] reply held no usable profile: {reply[:200]!r}", level=logging.WARNING)
        return ProfileResult(resume_text=text or None,
                             error="the AI could not read a profile out of this; add a few lines of notes and try again")
    return ProfileResult(derived=DerivedProfile(**fields), resume_text=text or None)
