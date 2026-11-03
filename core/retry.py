"""Retry transient external-API failures with exponential backoff + jitter.

Outbound calls to Jina / Serper / the AI provider intermittently fail with
timeouts, 429s or 5xx — none of which mean the request was wrong, just unlucky. This wraps a single call
so it retries a few times before giving up.

The wrapped callable should include its own `async with limit(api):` block, so each retry
**re-acquires the rate limiter** and never blows the pool's budget. Only failures `retry_on` accepts are
retried; anything else propagates immediately. `asyncio.CancelledError` is a BaseException, so
`except Exception` never swallows worker shutdown.

    async def _do():
        async with limit("serper"):
            r = await http.post(...)
        r.raise_for_status()   # inside, so 429/5xx become retryable
        return r
    r = await with_retry(_do, label="serper search")

The wait before a retry is never shorter than the `Retry-After` header of a 429/503 answer.
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Awaitable, Callable, TypeVar

import httpx

from core.log import slog

T = TypeVar("T")

# Status codes worth another shot: rate-limit + the transient 5xx family.
RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
# httpx transport-level transients (timeouts, dropped connections, protocol resets, …).
RETRYABLE_EXC = (httpx.TimeoutException, httpx.TransportError)


def status_of(exc: BaseException) -> int | None:
    code = getattr(getattr(exc, "response", None), "status_code", None)
    return code if isinstance(code, int) else None


def is_transient_http(exc: BaseException) -> bool:
    """A timeout, a dropped connection, a 429 or a 5xx: the kind of failure a retry can fix."""
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in RETRYABLE_STATUS
    return isinstance(exc, RETRYABLE_EXC)


def is_connect_failure(exc: BaseException) -> bool:
    """True only when the request can't have reached the server (safe to repeat a non-idempotent call)."""
    return isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout))


def retry_after_seconds(exc: BaseException, cap: float = 120.0) -> float | None:
    """The `Retry-After` header of the exception's response, in seconds (numeric form only), or None."""
    headers = getattr(getattr(exc, "response", None), "headers", None)
    value = headers.get("Retry-After") if headers is not None else None
    if value and str(value).strip().isdigit():
        return min(float(value), cap)
    return None


async def with_retry(
    call: Callable[[], Awaitable[T]],
    *,
    retry_on: Callable[[BaseException], bool] = is_transient_http,
    attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    label: str = "",
) -> T:
    """Run `call`, retrying the failures `retry_on` accepts, up to `attempts` calls in all.

    Backoff is `base_delay * 2**i` (capped at `max_delay`) with ±25% jitter, so concurrent retriers don't
    resynchronise into a thundering herd, and never shorter than a `Retry-After` header.
    """
    for i in range(attempts):
        try:
            return await call()
        except Exception as exc:  # noqa: BLE001 — re-raised below unless transient
            if i == attempts - 1 or not retry_on(exc):
                raise
            delay = min(max_delay, base_delay * (2**i)) * random.uniform(0.75, 1.25)
            delay = max(delay, retry_after_seconds(exc) or 0)
            slog(
                f"[retry] {label or 'call'}: attempt {i + 1}/{attempts} failed "
                f"({type(exc).__name__}: {str(exc)[:120]}); retrying in {delay:.1f}s",
                level=logging.WARNING,
            )
            await asyncio.sleep(delay)
    raise AssertionError("with_retry: unreachable")  # pragma: no cover
