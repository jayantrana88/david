"""The local SQLite database: where it is, how a connection is opened, how values go in and out.

One file, `data/job_applier.db` by default (`DB_PATH` in the environment, relative to the project root),
shared by the daemon and the dashboard. Resume files live next to it in `data/resumes/`. Every connection
applies `db/schema.sql` (idempotent) when it opens, so a fresh checkout needs no setup step.

Postgres types that SQLite lacks are stored as (see db/schema.sql):
    booleans    INTEGER 0/1   -> `bool` on read, for the columns in BOOL_COLUMNS
    JSON        TEXT          -> decoded on read for the columns in JSON_COLUMNS; a dict / list parameter is
                                 encoded on write
    timestamps  TEXT          -> `utc_now()`, the same format as the schema's defaults

Synchronous on purpose: config.py reads the dashboard settings through it at import, before any event loop
exists. The daemon's async access (core/db.py) runs these same calls on its own thread.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_FILE = PROJECT_ROOT / "db" / "schema.sql"
DEFAULT_DB_PATH = "data/job_applier.db"
BUSY_TIMEOUT_MS = 10_000

JSON_COLUMNS = frozenset({"raw_json", "links", "main_links", "content_json", "skills", "target_roles"})
BOOL_COLUMNS = frozenset({"is_qualified", "email_enabled"})

Params = Mapping[str, Any] | Iterable[Any]


def db_path() -> Path:
    """The database file: `DB_PATH` (absolute, or relative to the project root), else data/job_applier.db.
    Read from the environment at each call, so it works whether or not config.py has been imported."""
    path = Path(os.getenv("DB_PATH") or DEFAULT_DB_PATH)
    return path if path.is_absolute() else PROJECT_ROOT / path


def resumes_dir() -> Path:
    """Where the uploaded resume files are kept: a `resumes` folder next to the database file."""
    return db_path().parent / "resumes"


def utc_now() -> str:
    """Now, as stored in every timestamp column: ISO-8601 UTC with milliseconds, e.g. 2026-10-23T09:15:02.123Z."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def connect(path: Path | None = None) -> sqlite3.Connection:
    """Open the database (creating the file and its folder if needed), set the connection up and apply the
    schema. Autocommit: each statement commits on its own unless wrapped in an explicit BEGIN.

    `check_same_thread=False` because the daemon opens it on the thread that then uses it exclusively, which
    isn't always the thread that called this."""
    path = path or db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA journal_mode = WAL")      # the dashboard reads while the daemon writes
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA_FILE.read_text(encoding="utf-8"))
    upgrade(conn)
    return conn


# Columns added or removed after a database file may already have been created (db/schema.sql's
# CREATE TABLE IF NOT EXISTS leaves an existing table as it is). `upgrade` checks each one, so it is safe on
# every open and on a brand-new file, whose tables already have the current shape.
ADDED_COLUMNS = {
    ("website_scrapes", "homepage_text"): "TEXT",
    ("app_settings", "email_delivery"):
        "TEXT CHECK (email_delivery IS NULL OR email_delivery IN ('telegram', 'gmail', 'outlook'))",
    ("cold_emails", "delivery"): "TEXT",
    ("app_settings", "ai_model"): "TEXT",
    ("app_settings", "cloudflare_account_id"): "TEXT",
    ("app_secrets", "telegram_bot_token"): "TEXT",
    ("app_secrets", "telegram_chat_id"): "TEXT",
    ("app_secrets", "gmail_client_id"): "TEXT",
    ("app_secrets", "gmail_client_secret"): "TEXT",
    ("app_secrets", "outlook_client_id"): "TEXT",
    ("app_secrets", "outlook_client_secret"): "TEXT",
    ("tasks", "repeat_daily"): "INTEGER NOT NULL DEFAULT 0 CHECK (repeat_daily IN (0, 1))",
    ("app_settings", "email_instructions"): "TEXT",
}
DROPPED_COLUMNS = {
    "app_settings": ("company_name", "sender_address", "ai_batch_wait", "ai_api_base", "ai_temperature",
                     "ai_max_tokens", "ai_timeout", "ai_extra_params", "ai_qualification_enabled"),
}


def upgrade(conn: sqlite3.Connection) -> None:
    """Bring an older database file to the current shape (ADDED_COLUMNS / DROPPED_COLUMNS)."""
    def columns(table: str) -> set[str]:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}

    for (table, column), declaration in ADDED_COLUMNS.items():
        if column not in columns(table):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
    for table, dropped in DROPPED_COLUMNS.items():
        for column in sorted(set(dropped) & columns(table)):
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")


def encode(value: Any) -> Any:
    """One parameter as SQLite stores it: dicts and lists as JSON text, everything else as is (a bool is
    already an int to sqlite3)."""
    return json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value


def encode_params(params: Params) -> Params:
    if isinstance(params, Mapping):
        return {k: encode(v) for k, v in params.items()}
    return [encode(v) for v in params]


def decode_row(row: sqlite3.Row) -> dict[str, Any]:
    """A row as a dict, with its JSON columns parsed and its boolean columns as bool."""
    out = dict(row)
    for key, value in out.items():
        if value is None:
            continue
        if key in JSON_COLUMNS and isinstance(value, str):
            try:
                out[key] = json.loads(value)
            except ValueError:
                pass            # not JSON after all: hand back the text
        elif key in BOOL_COLUMNS:
            out[key] = bool(value)
    return out


def is_locked(exc: BaseException) -> bool:
    """The other process (the dashboard) held the write lock past the busy timeout: worth a retry."""
    return isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc).lower()


def is_unique_violation(exc: BaseException) -> bool:
    """An insert was refused because the row already exists (a UNIQUE / PRIMARY KEY constraint)."""
    return isinstance(exc, sqlite3.IntegrityError) and "UNIQUE" in str(exc).upper()


def insert_sql(table: str, row: Mapping[str, Any], returning: str | None = None) -> tuple[str, dict[str, Any]]:
    """`INSERT INTO table (cols) VALUES (:cols)` for one row dict (column names come from code, never input)."""
    cols = list(row)
    sql = f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)})"
    return (sql + f" RETURNING {returning}" if returning else sql), dict(row)


def set_clause(fields: Mapping[str, Any], prefix: str = "set_") -> tuple[str, dict[str, Any]]:
    """`col = :set_col, ...` for an UPDATE, with its named parameters (prefixed so they can't clash with the
    WHERE clause's)."""
    return (", ".join(f"{c} = :{prefix}{c}" for c in fields),
            {f"{prefix}{c}": v for c, v in fields.items()})
