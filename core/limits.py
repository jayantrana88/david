"""Rate limiting for the external APIs: one limiter per API, shared by every pool that calls it.

The ceilings are `config.RATE_LIMITS`. A client wraps each outbound request like::

    async with limit("jina"):
        await self._http.get(...)

Each limiter is built at its first use. Its semaphore is first come, first served, so two pools calling the
same API (scrape and internal both read pages through Jina) each get through in turn.
"""

from __future__ import annotations

import asyncio
from typing import Literal

from config import RATE_LIMITS

Api = Literal["llm", "jina", "serper", "linkedin", "telegram", "gmail", "outlook"]


class RateLimiter:
    """Async gate enforcing both a concurrency cap and a request rate (rpm).

    - `concurrency` bounds how many requests may be in flight at once (an `asyncio.Semaphore`).
    - `rpm` bounds the average request rate. Grants are paced at least `60 / rpm` seconds apart, so a burst of
      waiters drains smoothly instead of firing all at once.

    Use as an async context manager around a single outbound API call::

        async with limiter:
            await do_request()
    """

    def __init__(self, *, concurrency: int, rpm: int) -> None:
        if concurrency < 1 or rpm < 1:
            raise ValueError("RateLimiter: concurrency and rpm must be >= 1")
        self._sem = asyncio.Semaphore(concurrency)
        self._interval = 60.0 / rpm
        self._pace_lock = asyncio.Lock()
        self._next_at = 0.0

    async def __aenter__(self) -> "RateLimiter":
        # 1. concurrency cap
        await self._sem.acquire()
        # 2. rate pacing: reserve the next slot, then sleep until it arrives. The reservation happens under a
        #    lock (fast, no awaiting inside); the wait happens outside it so waiters sleep concurrently.
        try:
            loop = asyncio.get_running_loop()
            async with self._pace_lock:
                now = loop.time()
                slot = max(now, self._next_at)
                self._next_at = slot + self._interval
            delay = slot - now
            if delay > 0:
                await asyncio.sleep(delay)
        except BaseException:
            self._sem.release()
            raise
        return self

    async def __aexit__(self, *_exc: object) -> None:
        self._sem.release()


_limiters: dict[str, RateLimiter] = {}


def limit(api: Api) -> RateLimiter:
    """The limiter for `api` (config.RATE_LIMITS), built at its first use."""
    limiter = _limiters.get(api)
    if limiter is None:
        ceiling = RATE_LIMITS[api]
        limiter = _limiters[api] = RateLimiter(concurrency=ceiling.concurrency, rpm=ceiling.rpm)
    return limiter
