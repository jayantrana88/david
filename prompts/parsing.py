"""Read the AI's JSON replies (shaped by prompts/schemas.py) back into one answer per lead (pure, no network).

Lenient on purpose: with a role's `structured_output` stepped down (or a provider that half-honours the schema) the
JSON can arrive wrapped in ``` fences, <think> blocks or chatter, and is still read. Anything that isn't a
clear answer is left out, never guessed: the caller asks for that lead again.
"""

from __future__ import annotations

import json
import re

_THINK_RE = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.I | re.S)


def parse_json_object(text: str) -> dict | None:
    """Pull the first `{...}` JSON object out of `text` (tolerates <think> blocks, ``` fences and chatter)."""
    text = _THINK_RE.sub("", text).strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).strip()
        text = re.sub(r"```$", "", text).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _items(reply: str, key: str) -> list[dict]:
    """The objects in the reply's `key` array (the batch schemas' root), or [] if there is none."""
    items = (parse_json_object(reply) or {}).get(key)
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def _number(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _draft(data: dict) -> tuple[str, str] | None:
    subject = str(data.get("subject") or "").strip()
    body = str(data.get("body") or "").strip()
    return (subject, body) if subject and body else None


def _summary(data: dict) -> str | None:
    return str(data.get("summary") or "").strip() or None


def parse_verdict(reply: str) -> tuple[bool, str | None] | None:
    """(qualified, summary) of a QUALIFICATION reply, or None if it doesn't hold a true/false verdict. A
    missing summary doesn't void the verdict: it comes back as None."""
    data = parse_json_object(reply) or {}
    verdict = data.get("qualified")
    return (verdict, _summary(data)) if isinstance(verdict, bool) else None


def parse_verdicts(reply: str, count: int) -> dict[int, tuple[bool, str | None]]:
    """{number: (qualified, summary)} for the numbers 1..count a QUALIFICATION_BATCH reply answers.

    A number the reply leaves out, repeats with conflicting verdicts, or answers with anything but true /
    false is left out, never guessed: the caller asks for those leads again on their own.
    """
    seen: dict[int, set[bool]] = {}
    summaries: dict[int, str | None] = {}
    for item in _items(reply, "results"):
        n, verdict = _number(item.get("number")), item.get("qualified")
        if n is not None and 1 <= n <= count and isinstance(verdict, bool):
            seen.setdefault(n, set()).add(verdict)
            summaries[n] = summaries.get(n) or _summary(item)
    return {n: (next(iter(answers)), summaries[n]) for n, answers in seen.items() if len(answers) == 1}


_PROFILE_TEXT = ("full_name", "headline", "summary", "education", "phone", "linkedin_url", "portfolio_url")
_OPPORTUNITY_TYPES = ("job", "internship", "either")


def parse_profile(reply: str) -> dict | None:
    """The fields of a CANDIDATE_PROFILE reply, cleaned: strings stripped ("" = unknown), lists of non-empty
    strings, `experience_years` a number >= 0 or None, `opportunity_type` one of job/internship/either or "".
    None when the reply holds no JSON object, or neither a headline nor a target role (nothing usable)."""
    data = parse_json_object(reply)
    if not data:
        return None
    out: dict = {k: str(data.get(k) or "").strip() for k in _PROFILE_TEXT}
    for key, cap in (("skills", 15), ("target_roles", 3)):
        items = data.get(key)
        out[key] = [str(i).strip() for i in items if str(i or "").strip()][:cap] if isinstance(items, list) else []
    years = data.get("experience_years")
    if isinstance(years, str):
        try:
            years = float(years.strip())
        except ValueError:
            years = None
    out["experience_years"] = float(years) if isinstance(years, (int, float)) and not isinstance(years, bool) \
        and years >= 0 else None
    kind = str(data.get("opportunity_type") or "").strip().lower()
    out["opportunity_type"] = kind if kind in _OPPORTUNITY_TYPES else ""
    return out if out["headline"] or out["target_roles"] else None


def parse_email_draft(reply: str) -> tuple[str, str] | None:
    """(subject, body) of a COLD_EMAIL reply, or None unless both are there and non-empty."""
    data = parse_json_object(reply)
    return _draft(data) if data else None


def parse_email_drafts(reply: str, count: int) -> dict[int, tuple[str, str]]:
    """{number: (subject, body)} for the numbers 1..count a COLD_EMAIL_BATCH reply gives a usable draft for.

    A number the reply leaves out, repeats with conflicting drafts, or whose subject or body is empty is
    left out, never guessed: the caller writes that lead's draft again alone.
    """
    seen: dict[int, set[tuple[str, str]]] = {}
    for item in _items(reply, "emails"):
        n, draft = _number(item.get("number")), _draft(item)
        if n is not None and 1 <= n <= count and draft:
            seen.setdefault(n, set()).add(draft)
    return {n: next(iter(drafts)) for n, drafts in seen.items() if len(drafts) == 1}
