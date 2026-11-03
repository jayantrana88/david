"""Async LLM client — the one door to the AI providers, whichever they are (through LiteLLM).

There is one client per AI role (config.py -> AI): `qualify` (the site_scrape service: is this lead a
fit?), `email` (the cold_email service: write the email) and `profile` (read the resume). Each role has its
own provider and key; all of them share the `llm` rate limit. Switching provider = edit that role's `models`
and key, no code change.

    llm = get_llm("qualify")                     # core.clients
    text = await llm.chat(qualification_prompt(summary), response_format=QUALIFICATION)   # prompts

`response_format` is an OpenAI `json_schema` response format (prompts/schemas.py); LiteLLM translates it
for the provider. The role's `structured_output` decides how much of it is actually sent (see LLMProfile).

Model fallback: a role lists its models in order of preference. `chat()` asks the first one whose quota
isn't used up. A rate-limit answer that means "quota used up" (a per-day limit, or a wait longer than
`quota_switch_after`) marks that model as resting until its reset, and the next model is asked at once.
Every call starts from the top again, so the first model takes over again as soon as its quota resets. A
model the provider no longer has (withdrawn / decommissioned) rests for WITHDRAWN_RECHECK_SECS. When every
model is resting, `LLMQuotaExhausted` is raised with the time until the earliest reset, and the worker
holds its pool that long. The resting times live in memory only; after a restart a used-up model costs
one 429 before the next takes over.

`chat()` retries transient failures (timeout / connection / a short 429 / 5xx) on the same model with
backoff and throttles to the `llm` limiter. A provider rejecting our credentials is raised as
`LLMAuthError` (not retried, no fallback: every model of a role shares its key). Both are `LLMUnavailable`:
the worker then pauses its pool instead of burning through every lead. Anything else is raised as it came,
and the caller skips the lead.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Awaitable, Callable, TypeVar

from core.config_models import LLMProfile
from core.limits import limit
from core.log import slog
from core.retry import RETRYABLE_STATUS, is_transient_http, with_retry

AUTH_HOLD_SECS = 900.0              # how long a pool waits after the AI provider rejected our key
WITHDRAWN_RECHECK_SECS = 900.0      # how long a model the provider no longer has is skipped before re-asking
UNKNOWN_RESET_SECS = 3600.0         # a per-day limit that doesn't say when it resets: rest the model this long
MAX_QUOTA_WAIT = 24 * 3600.0        # cap on any reset time read from the provider

_PER_DAY_RE = re.compile(r"\b(?:TPD|RPD)\b|per[ -]day|free-models-per-day|daily free allocation|\b3036\b", re.I)
_TRY_AGAIN_RE = re.compile(r"try again in\s+([\d.hms]+)", re.I)
_DURATION_PART_RE = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)")
T = TypeVar("T")
R = TypeVar("R")

_WITHDRAWN_RE = re.compile(r"decommissioned|model_not_found|model .{0,80} does not exist|no endpoints found", re.I)


class LLMUnavailable(RuntimeError):
    """The AI can't be used for a while: the worker holds its whole pool for `hold_secs` (the lead itself
    isn't counted as failed)."""
    hold_secs: float = AUTH_HOLD_SECS

    def __init__(self, message: str, *, hold_secs: float | None = None) -> None:
        super().__init__(message)
        if hold_secs is not None:
            self.hold_secs = hold_secs


class LLMAuthError(LLMUnavailable):
    """The AI provider rejected our credentials (bad or missing API key, no access to the model)."""


class LLMQuotaExhausted(LLMUnavailable):
    """Every model of the role has used up its quota (or is gone); `hold_secs` is until the earliest reset."""


def _status_of(exc: BaseException) -> int | None:
    code = getattr(exc, "status_code", None)
    return code if isinstance(code, int) else None


def _header(exc: BaseException, name: str) -> str | None:
    """A response header of the provider's error (LiteLLM keeps them in one of two places), or None."""
    for headers in (getattr(exc, "litellm_response_headers", None),
                    getattr(getattr(exc, "response", None), "headers", None)):
        if not headers:
            continue
        try:
            for key, value in headers.items():
                if key.lower() == name:
                    return str(value)
        except (AttributeError, TypeError):
            continue
    return None


def _duration(text: str) -> float | None:
    """Seconds in a Groq-style duration such as "7m12.5s", "1h2m", "2.36s" or "343ms"."""
    parts = _DURATION_PART_RE.findall(text)
    if not parts:
        return None
    unit = {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 0.001}
    return sum(float(n) * unit[u] for n, u in parts)


def _reset_wait(exc: BaseException) -> float | None:
    """How long the provider says to wait before asking again, in seconds, or None if it doesn't say.
    Reads `Retry-After`, then the message's "try again in 7m12.5s" (Groq), then `X-RateLimit-Reset`
    (OpenRouter: an epoch time in milliseconds)."""
    retry_after = _header(exc, "retry-after")
    if retry_after:
        try:
            return float(retry_after)
        except ValueError:
            pass
    if match := _TRY_AGAIN_RE.search(str(exc)):
        if (wait := _duration(match.group(1))) is not None:
            return wait
    reset = _header(exc, "x-ratelimit-reset")
    if reset:
        try:
            value = float(reset)
        except ValueError:
            return _duration(reset)
        return value / 1000 - time.time() if value > 1e12 else value
    return None


def _fmt(secs: float) -> str:
    secs = max(0, int(secs))
    if secs >= 3600:
        return f"{secs // 3600}h{secs % 3600 // 60:02d}m"
    return f"{secs // 60}m{secs % 60:02d}s" if secs >= 60 else f"{secs}s"


class LLMClient:
    """One AI role: its models (in order of preference), any LiteLLM provider, via `litellm.acompletion`."""

    def __init__(self, profile: LLMProfile, *, attempts: int = 3) -> None:
        import litellm                      # slow to import, so only when the client is built
        litellm.suppress_debug_info = True
        self._litellm = litellm
        self.profile = profile
        self.attempts = attempts
        self._resting: dict[str, float] = {}    # model -> time.monotonic() when it may be asked again
        self.api_key: str | None = profile.api_key     # None: the provider's own environment variable, if it has one

    @property
    def models(self) -> list[str]:
        return self.profile.models

    async def chat(self, prompt: str, *, response_format: dict | None = None, attempts: int | None = None) -> str:
        """One single-turn prompt -> the reply text, from the first model whose quota isn't used up.
        Raises LLMAuthError, LLMQuotaExhausted, or the provider's error.

        `response_format` is the reply's schema (prompts/schemas.py), sent as `structured_output` allows.
        `attempts` overrides how many times a transient failure is tried on a model (default: the client's).
        """
        profile = self.profile
        params = dict(profile.extra_params)
        for name, value in (("api_key", self.api_key), ("api_base", profile.api_base),
                            ("temperature", profile.temperature), ("max_tokens", profile.max_tokens),
                            ("response_format", self._response_format(response_format))):
            if value is not None:
                params[name] = value

        for model in profile.models:
            if self._resting.get(model, 0.0) > time.monotonic():
                continue
            try:
                return await self._chat_one(model, prompt, params, attempts)
            except Exception as exc:
                if self._is_auth_error(exc):
                    raise LLMAuthError(f"{model}: the provider rejected our credentials ({str(exc)[:200]}) — "
                                       "check the AI key on the dashboard's Settings page") from exc
                if (wait := self._quota_wait(exc)) is not None:
                    self._rest(model, wait, f"out of quota ({str(exc)[:160]})", logging.WARNING)
                elif self._is_withdrawn(exc):
                    self._rest(model, WITHDRAWN_RECHECK_SECS, f"not available from the provider "
                                                              f"({str(exc)[:160]})", logging.ERROR)
                else:
                    raise

        now = time.monotonic()
        earliest = min(self._resting.get(m, now) for m in profile.models) - now
        raise LLMQuotaExhausted(f"every model is out of quota or unavailable ({', '.join(profile.models)}); "
                                f"the earliest is back in ~{_fmt(earliest)}", hold_secs=max(60.0, earliest))

    async def _chat_one(self, model: str, prompt: str, params: dict, attempts: int | None) -> str:
        async def _do() -> str:
            async with limit("llm"):
                response = await self._litellm.acompletion(
                    model=model, messages=[{"role": "user", "content": prompt}], timeout=self.profile.timeout,
                    **params)
            usage = getattr(response, "usage", None)
            slog(f"[llm] usage ({model}): {getattr(usage, 'prompt_tokens', '?')} prompt + "
                 f"{getattr(usage, 'completion_tokens', '?')} completion tokens", level=logging.DEBUG)
            text = (response.choices[0].message.content or "").strip()
            if not text:
                raise RuntimeError(f"{model} returned an empty reply "
                                   f"(finish_reason: {response.choices[0].finish_reason})")
            return text

        slog(f"[llm] chat ({model}, {len(prompt)} chars)", level=logging.DEBUG)
        return await with_retry(_do, retry_on=self._is_transient, attempts=attempts or self.attempts,
                                base_delay=5, max_delay=60, label=f"{model} call")

    def _rest(self, model: str, secs: float, why: str, level: int) -> None:
        """Skip `model` for `secs`, and say which model answers meanwhile (once, not per concurrent call)."""
        now = time.monotonic()
        already = self._resting.get(model, 0.0) > now
        self._resting[model] = now + secs
        if already:
            return
        following = self.profile.models[self.profile.models.index(model) + 1:]
        nxt = next((m for m in following if self._resting.get(m, 0.0) <= now), None)
        slog(f"[llm] {model} {why}; " + (f"switching to {nxt} for ~{_fmt(secs)}" if nxt
                                         else f"no other model left to switch to for ~{_fmt(secs)}"),
             level=level)

    def _response_format(self, schema: dict | None) -> dict | None:
        """What to send for `schema`: all of it ("json_schema"), only "reply in JSON" ("json_object"), or
        nothing ("off") — the prompts describe the shape in words either way."""
        mode = self.profile.structured_output
        if schema is None or mode == "off":
            return None
        return schema if mode == "json_schema" else {"type": "json_object"}

    # ── error classification ──────────────────────────────────────────────────

    def _is_auth_error(self, exc: BaseException) -> bool:
        litellm = self._litellm
        return (isinstance(exc, (litellm.AuthenticationError, litellm.PermissionDeniedError))
                or _status_of(exc) in (401, 403))

    def _is_rate_limit(self, exc: BaseException) -> bool:
        return isinstance(exc, self._litellm.RateLimitError) or _status_of(exc) == 429

    def _quota_wait(self, exc: BaseException) -> float | None:
        """Seconds until the model's quota resets if `exc` says it is used up (a per-day limit, or a wait
        longer than `quota_switch_after`), else None (a per-minute limit is retried on the same model)."""
        if not self._is_rate_limit(exc):
            return None
        wait = _reset_wait(exc)
        if _PER_DAY_RE.search(str(exc)):
            return min(MAX_QUOTA_WAIT, max(1.0, wait if wait is not None else UNKNOWN_RESET_SECS))
        if wait is not None and wait > self.profile.quota_switch_after:
            return min(MAX_QUOTA_WAIT, wait)
        return None

    def _is_withdrawn(self, exc: BaseException) -> bool:
        """The provider doesn't have this model (any more): e.g. a decommissioned preview model."""
        return (isinstance(exc, self._litellm.NotFoundError) or _status_of(exc) == 404
                or (isinstance(exc, self._litellm.BadRequestError) and bool(_WITHDRAWN_RE.search(str(exc)))))

    def _is_transient(self, exc: BaseException) -> bool:
        litellm = self._litellm
        if self._is_auth_error(exc) or self._quota_wait(exc) is not None:
            return False
        return (isinstance(exc, (litellm.Timeout, litellm.APIConnectionError, litellm.RateLimitError,
                                 litellm.ServiceUnavailableError, litellm.InternalServerError,
                                 litellm.BadGatewayError))
                or _status_of(exc) in RETRYABLE_STATUS or is_transient_http(exc))


# ── several questions in one call ─────────────────────────────────────────────

async def _gather(aws) -> list:
    results = await asyncio.gather(*aws, return_exceptions=True)
    for r in results:
        if isinstance(r, BaseException) and not isinstance(r, Exception):
            raise r     # cancellation: not an answer
    return results


async def ask_in_batches(items: list[T], *, size: int,
                         ask_batch: Callable[[list[T]], Awaitable[dict[int, R]]],
                         ask_one: Callable[[T, int | None], Awaitable[R]], what: str) -> list[R | Exception]:
    """One answer (or the exception to report) per item, in order. Never raises except on cancellation.

    Items go out `size` at a time, one AI call per chunk: `ask_batch(chunk)` returns {1-based position:
    answer} for the items its reply answers clearly. Every item a chunk leaves out is asked alone with
    `ask_one(item, attempts)`, never guessed; after a chunk call that failed outright, with `attempts=1` (the
    AI is probably down, so not the whole retry ladder again). An `LLMUnavailable` from a chunk call is every
    one of its items' answer. `size` <= 1, or a chunk of one, asks alone directly.
    """
    if size <= 1:
        return await _gather([ask_one(item, None) for item in items])
    chunks = [items[i:i + size] for i in range(0, len(items), size)]
    answered = await _gather([_ask_chunk(chunk, ask_batch, ask_one, what) for chunk in chunks])
    return [answer for chunk in answered for answer in chunk]


async def _ask_chunk(chunk: list[T], ask_batch, ask_one, what: str) -> list:
    if len(chunk) == 1:
        return await _gather([ask_one(chunk[0], None)])
    attempts = None
    try:
        answers = await ask_batch(chunk)
    except LLMUnavailable as exc:
        return [exc] * len(chunk)
    except Exception as exc:  # noqa: BLE001 — every item in it is asked again on its own
        answers, attempts = {}, 1
        slog(f"{what}: batch of {len(chunk)} failed ({type(exc).__name__}: {str(exc)[:200]}); "
             "asking each on its own", level=logging.WARNING)
    else:
        if len(answers) < len(chunk):
            slog(f"{what}: batch of {len(chunk)}: {len(answers)} usable answer(s); asking the other "
                 f"{len(chunk) - len(answers)} on their own", level=logging.WARNING)
        else:
            slog(f"{what}: batch of {len(chunk)} answered in one call")
    missing = [i for i in range(len(chunk)) if i + 1 not in answers]
    alone = dict(zip(missing, await _gather([ask_one(chunk[i], attempts) for i in missing])))
    return [answers[i + 1] if i + 1 in answers else alone[i] for i in range(len(chunk))]
