"""How the generic Worker ends each item: done, retried later, retired, or the whole pool held."""

import asyncio
import time
from dataclasses import dataclass

from core.errors import LeadFailed, LeadSkipped
from core.llm import LLMAuthError
from core.worker import Worker


@dataclass
class Item:
    id: str

    @property
    def label(self) -> str:
        return self.id


def make_worker(outcomes: dict[str, BaseException | None], **kwargs) -> tuple[Worker, asyncio.Event]:
    """A worker whose queue is `outcomes`' keys; running an item raises its outcome (None = success). The
    shutdown event is set by the first batch, so `run()` returns after one round."""
    shutdown = asyncio.Event()

    async def load(_db):
        return [Item(i) for i in outcomes]

    async def run(_db, item):
        shutdown.set()
        if outcomes[item.id] is not None:
            raise outcomes[item.id]

    worker = Worker(name="scrape", db=None, load=load, run=run, batch_size=10, **kwargs)
    return worker, shutdown


def run_round(worker: Worker, shutdown: asyncio.Event) -> None:
    asyncio.run(asyncio.wait_for(worker.run(shutdown), 5))


def test_outcomes_of_one_round():
    worker, shutdown = make_worker({
        "ok": None,
        "skip": LeadSkipped("no address"),
        "fail": LeadFailed("page down"),
        "gone": LeadFailed("no draft passed", permanent=True),
        "boom": ValueError("bug"),
    })
    run_round(worker, shutdown)
    assert worker.stats == {"ok": 1, "failed": 3, "skipped": 1}
    assert worker._done == {"ok", "skip", "gone"}
    assert set(worker._retry_at) == {"fail", "boom"}
    assert all(t > time.monotonic() for t in worker._retry_at.values())


def test_llm_unavailable_holds_the_pool_without_failing_the_item():
    worker, shutdown = make_worker({"a": LLMAuthError("bad key", hold_secs=900)})
    run_round(worker, shutdown)
    assert worker.stats["failed"] == 0 and "a" not in worker._done and "a" not in worker._retry_at
    assert worker._hold_until - time.monotonic() > 800


def test_failure_streak_holds_the_pool():
    worker, shutdown = make_worker({str(i): LeadFailed("down") for i in range(3)},
                                   max_consecutive_failures=3, cooldown=600)
    run_round(worker, shutdown)
    assert worker._hold_until - time.monotonic() > 500
