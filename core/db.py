"""Async access to the local SQLite database for the daemon.

The sourcing pool's queue is the `tasks` table; every other pool's queue is a "pending work" query on the
lead tables themselves (each stage's store.py, the schema in db/schema.sql). This exposes what every
read and write needs: `fetch_all` / `fetch_one` / `execute` for one statement, `transaction` for several
that must land together, and `read_resume` for the uploaded resume file.

One connection, worked by one thread of its own: every call is handed to that thread, so statements run
one at a time, in order, without blocking the event loop. The dashboard writes the same file from its own
process; SQLite's WAL mode and busy timeout cover that, and a write still refused as "database is locked"
is retried here.

Claims are in-memory: the daemon is single-process and each pool is worked by exactly one worker
coroutine, which finishes a lead before it reloads its queue, so two workers can never pick up the same
lead.
"""

from __future__ import annotations

import asyncio
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, TypeVar

from core.retry import with_retry
from core.sqlite import Params, connect, db_path, decode_row, encode_params, is_locked, is_unique_violation, \
    resumes_dir

__all__ = ["Db", "Tx", "is_unique_violation"]

T = TypeVar("T")


class Tx:
    """Synchronous statements on the database thread: what a `Db.transaction` callback is given."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def fetch_all(self, sql: str, params: Params = ()) -> list[dict[str, Any]]:
        return [decode_row(r) for r in self._conn.execute(sql, encode_params(params)).fetchall()]

    def fetch_one(self, sql: str, params: Params = ()) -> dict[str, Any] | None:
        # fetchall, not fetchone: an `UPDATE ... RETURNING` left half-read would hold its write open
        rows = self._conn.execute(sql, encode_params(params)).fetchall()
        return decode_row(rows[0]) if rows else None

    def execute(self, sql: str, params: Params = ()) -> int:
        """Run one statement; returns how many rows it changed."""
        return self._conn.execute(sql, encode_params(params)).rowcount

    def execute_many(self, sql: str, rows: list[Params]) -> int:
        return self._conn.executemany(sql, [encode_params(r) for r in rows]).rowcount


class Db:
    """Daemon-facing database client. Build once via `await Db.connect()` (or `core.clients.get_db()`)."""

    def __init__(self, conn: sqlite3.Connection, executor: ThreadPoolExecutor, path: Path) -> None:
        self._conn = conn
        self._executor = executor
        self.path = path

    @classmethod
    async def connect(cls) -> "Db":
        """Open the database file (created with its tables on first use). Raises if it can't be opened."""
        path = db_path()
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sqlite")
        try:
            conn = await asyncio.get_running_loop().run_in_executor(executor, connect, path)
        except Exception:
            executor.shutdown(wait=False)
            raise
        return cls(conn, executor, path)

    async def aclose(self) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self._executor, self._conn.close)
        self._executor.shutdown(wait=True)

    # ── execution ─────────────────────────────────────────────────────────────

    async def _run(self, fn: Callable[[Tx], T], what: str) -> T:
        """`fn(Tx)` on the database thread, retried while the database is locked by the other process."""
        loop = asyncio.get_running_loop()

        async def call() -> T:
            return await loop.run_in_executor(self._executor, fn, Tx(self._conn))

        return await with_retry(call, retry_on=is_locked, attempts=4, base_delay=1, max_delay=10, label=what)

    async def fetch_all(self, sql: str, params: Params = (), *, what: str = "DB read") -> list[dict[str, Any]]:
        """Every row of a query, as dicts (JSON columns parsed). Raises if it can't be read."""
        return await self._run(lambda tx: tx.fetch_all(sql, params), what)

    async def fetch_one(self, sql: str, params: Params = (), *, what: str = "DB read") -> dict[str, Any] | None:
        return await self._run(lambda tx: tx.fetch_one(sql, params), what)

    async def execute(self, sql: str, params: Params = (), *, what: str = "DB write") -> int:
        """One statement (it commits by itself); returns how many rows it changed."""
        return await self._run(lambda tx: tx.execute(sql, params), what)

    async def transaction(self, fn: Callable[[Tx], T], *, what: str = "DB transaction") -> T:
        """Run `fn(tx)` (synchronous statements) as one transaction: all of it lands, or none of it.
        `BEGIN IMMEDIATE` takes the write lock up front, so the dashboard can't interleave a write."""
        def run(tx: Tx) -> T:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                result = fn(tx)
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            self._conn.execute("COMMIT")
            return result

        return await self._run(run, what)

    # ── resume files ──────────────────────────────────────────────────────────

    async def read_resume(self, name: str) -> bytes:
        """One uploaded resume file (data/resumes/<name>). Raises if it is missing or the name isn't a bare
        file name."""
        if not name or Path(name).name != name or name in (".", ".."):
            raise ValueError(f"not a resume file name: {name!r}")
        return await asyncio.to_thread((resumes_dir() / name).read_bytes)
