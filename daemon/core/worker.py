"""The generic worker loop, shared by every pool.

A `Worker` works one pool's queue. The pools differ only in which queue they load and what they run for its
items — see each stage's worker.py (stages/<pool>/worker.py) — so the loop itself lives here once.

Flow: load the pending items (the stage's store.py) → drop the ones already handled or backing off → take a
batch → run it → record each item's outcome → reload when the list is used up, sleep when there is nothing
to do. Each worker binds its pool once, so `slog` writes to logs/<pool>/<pool>.log.

A pool gives either `run(db, item)`, run for each item of a batch side by side, or `run_batch(db, items)`,
which takes the whole batch and returns one outcome per item (None = success, else the exception). The
scrape and email pools use `run_batch` so a round's AI questions go out together (core/llm.py: ask_in_batches).

Claims are in memory (the sourcing pool also marks its task `running` in `tasks`): one worker per pool, and
it finishes a batch before it takes the next, so an item can't be picked up twice. How an item ends:

  success          → never picked up again by this process (its row now exists anyway)
  LeadSkipped      → left alone until the daemon restarts; no attempt counted
  LeadFailed / any other exception
                   → retried after `failure_backoff` (kept in memory only); `permanent=True` retires it for good
  LLMUnavailable   → the AI provider rejected our key (LLMAuthError), or every model of the role is out of
                     quota (LLMQuotaExhausted): the whole pool holds for the exception's `hold_secs`
  `max_consecutive_failures` failures in a row → the pool holds for `cooldown` (Jina / the AI is down)
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Any, Awaitable, Callable

from core.db import Db
from core.errors import LeadFailed, LeadSkipped
from core.llm import LLMAuthError, LLMUnavailable
from core.log import bind_pool, pool_logger

log = logging.getLogger(__name__)

Outcome = BaseException | None      # what became of one item: None = success
Loader = Callable[[Db], Awaitable[list[Any]]]
Runner = Callable[[Db, Any], Awaitable[None]]
BatchRunner = Callable[[Db, list[Any]], Awaitable[list[Outcome]]]
Gate = Callable[[], str | None]


async def sleep_or_stop(stop: asyncio.Event, secs: float) -> None:
    """Sleep up to `secs`, returning early the moment `stop` is set (so an idle wait answers a shutdown at once)."""
    try:
        await asyncio.wait_for(stop.wait(), timeout=secs)
    except asyncio.TimeoutError:
        pass


async def gather_outcomes(*aws: Awaitable[Any]) -> list[Outcome]:
    """Await side by side; one outcome per awaitable (None = it succeeded, else what it raised)."""
    results = await asyncio.gather(*aws, return_exceptions=True)
    return [r if isinstance(r, BaseException) else None for r in results]


class Worker:
    """Works one pool's queue. Items need an `id` and a `label`."""

    def __init__(
        self,
        *,
        name: str,
        db: Db,
        load: Loader,
        run: Runner | None = None,
        run_batch: BatchRunner | None = None,
        gate: Gate | None = None,
        batch_size: int = 5,
        idle_sleep: float = 30.0,
        failure_backoff: float = 3600.0,
        max_consecutive_failures: int | None = 15,
        cooldown: float = 600.0,
    ) -> None:
        if (run is None) == (run_batch is None):
            raise ValueError("Worker: give exactly one of run / run_batch")
        self.name = name
        # Per-item lines go to this pool's file; worker lifecycle stays on the module logger (-> main).
        self._itemlog = pool_logger(name)
        self._db = db
        self._load = load
        self._run_batch = run_batch or (lambda db, items: gather_outcomes(*(run(db, i) for i in items)))
        self._gate = gate
        self._batch_size = batch_size
        self._idle_sleep = idle_sleep
        self._failure_backoff = failure_backoff
        self._max_consecutive_failures = max_consecutive_failures
        self._cooldown = cooldown

        self._buffer: deque[Any] = deque()      # loaded, not yet processed
        self._done: set[str] = set()            # handled for good by this process
        self._retry_at: dict[str, float] = {}   # failed items -> when they may be tried again
        self._hold_until = 0.0                  # the whole pool waits until then (auth error, failure streak)
        self._consecutive_failures = 0
        self._held_for: str | None = None       # the gate's reason, logged once when it changes
        self.stats = {"ok": 0, "failed": 0, "skipped": 0}

    # ── the loop ──────────────────────────────────────────────────────────────

    async def run(self, shutdown: asyncio.Event) -> None:
        """Load, process in batches, repeat — until `shutdown`.

        Shutdown is cooperative: a set event stops the loop from taking new work, but a batch already
        started is allowed to finish (the daemon's grace period bounds how long that can take).
        """
        bind_pool(self.name)          # routes this pool's service/client logs to its own file
        log.info("worker[%s] online", self.name)
        while not shutdown.is_set():
            wait = self._hold_until - time.monotonic()
            if wait > 0:
                await sleep_or_stop(shutdown, min(wait, 60.0))
                continue
            if self._is_gated():
                await sleep_or_stop(shutdown, 60.0)
                continue

            try:
                batch = await self._next_batch()
            except Exception:  # noqa: BLE001 — a transient DB error must not kill the loop
                log.exception("worker[%s] could not load its queue; backing off", self.name)
                await sleep_or_stop(shutdown, self._idle_sleep)
                continue

            if not batch:
                await sleep_or_stop(shutdown, self._idle_sleep)
                continue

            for item, outcome in zip(batch, await self._run(batch)):
                self._record(item, outcome)
            if not self._buffer and self._hold_until <= time.monotonic():
                log.info("worker[%s] worked through its queue (ok %d, failed %d, skipped %d so far)",
                         self.name, self.stats["ok"], self.stats["failed"], self.stats["skipped"])
        log.info("worker[%s] stopped", self.name)

    def _is_gated(self) -> bool:
        reason = self._gate() if self._gate else None
        if reason != self._held_for:
            if reason:
                log.warning("worker[%s] holding: %s", self.name, reason)
            elif self._held_for:
                log.info("worker[%s] resuming", self.name)
            self._held_for = reason
        return reason is not None

    async def _next_batch(self) -> list[Any]:
        """Up to `batch_size` items, reloading the queue when the last load has been used up."""
        if not self._buffer:
            now = time.monotonic()
            rows = await self._load(self._db)
            fresh = [r for r in rows if r.id not in self._done and self._retry_at.get(r.id, 0.0) <= now]
            self._buffer.extend(fresh)
            if fresh:
                log.info("worker[%s] %d item(s) to work on", self.name, len(fresh))
        batch = []
        while self._buffer and len(batch) < self._batch_size:
            batch.append(self._buffer.popleft())
        return batch

    async def _run(self, batch: list[Any]) -> list[Outcome]:
        """One outcome per item. A batch runner that raises fails every item of the batch with that error."""
        try:
            outcomes = await self._run_batch(self._db, batch)
        except Exception as exc:  # noqa: BLE001 — one bad batch must not stop the pool
            return [exc] * len(batch)
        if len(outcomes) != len(batch):
            return [RuntimeError(f"batch of {len(batch)} got {len(outcomes)} outcome(s)")] * len(batch)
        return outcomes

    # ── one item ──────────────────────────────────────────────────────────────

    def _record(self, item: Any, outcome: Outcome) -> None:
        if outcome is None:
            self._done.add(item.id)
            self._retry_at.pop(item.id, None)
            self._consecutive_failures = 0
            self.stats["ok"] += 1
        elif not isinstance(outcome, Exception):
            raise outcome           # cancellation / interpreter exit: not this item's outcome
        elif isinstance(outcome, LLMUnavailable):
            why = "the AI provider rejected our credentials" if isinstance(outcome, LLMAuthError) else "AI unavailable"
            self._hold(outcome.hold_secs, f"{why}: {outcome}")
            # the item isn't counted as failed: it is picked up again after the hold
        elif isinstance(outcome, LeadSkipped):
            self._done.add(item.id)
            self.stats["skipped"] += 1
            self._itemlog.info("worker[%s] skipped %s: %s", self.name, item.label, outcome)
        else:
            self._failed(item, outcome)

    def _failed(self, item: Any, exc: Exception) -> None:
        permanent = isinstance(exc, LeadFailed) and exc.permanent
        if isinstance(exc, LeadFailed):
            self._itemlog.warning("worker[%s] %s failed%s: %s", self.name, item.label,
                                  " (permanently)" if permanent else "", exc)
        else:
            self._itemlog.error("worker[%s] %s failed unexpectedly", self.name, item.label, exc_info=exc)
        self.stats["failed"] += 1

        if permanent:
            self._done.add(item.id)
        else:
            self._retry_at[item.id] = time.monotonic() + self._failure_backoff

        self._consecutive_failures += 1
        if self._max_consecutive_failures and self._consecutive_failures >= self._max_consecutive_failures:
            self._hold(self._cooldown, f"{self._consecutive_failures} items in a row failed — an API it depends "
                                       f"on (or its key / credit) is probably down")

    def _hold(self, secs: float, why: str) -> None:
        """Pause the whole pool for `secs`; what was loaded is dropped and reloaded afterwards."""
        if self._hold_until > time.monotonic():
            return  # already holding (several items of one batch hit the same problem)
        log.error("worker[%s] 🛑 %s. Holding for %.0f min.", self.name, why, secs / 60)
        self._hold_until = time.monotonic() + secs
        self._consecutive_failures = 0
        self._buffer.clear()
