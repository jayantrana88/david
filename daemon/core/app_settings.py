"""
Settings kept in the local database (app_settings / app_secrets, db/schema.sql), edited from the dashboard
(dashboard/): the API keys, the AI model, the email settings. They are the only source.

config.py calls `load()` once, at import. It is a plain synchronous SQLite read (core/sqlite.py) because
config.py is imported synchronously, before any event loop exists, and the clients read their keys at
import time. Changes on the dashboard apply at the next daemon start: main.py polls `current_version()` and
restarts itself (through its supervisor) when the version moves. `report()` tells the dashboard what the
running daemon loaded (app_settings.applied_*), so it can show "restart required" until then.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TypeVar

from core import sqlite
from core.config_models import ConfigError

SETTINGS_TABLE = "app_settings"
SECRETS_TABLE = "app_secrets"

T = TypeVar("T")

# app_settings / app_secrets column -> config.py field
SECRET_COLUMNS = {
    # app_secrets
    "jina_api_key": "jina_api_key",
    "serper_api_key": "serper_api_key",
    "ai_api_key": "ai_provider_api_key",     # the dashboard's "AI key" slot holds the Workers AI key
    "telegram_bot_token": "telegram_bot_token",
    "telegram_chat_id": "telegram_chat_id",
    "gmail_client_id": "gmail_client_id",
    "gmail_client_secret": "gmail_client_secret",
    "outlook_client_id": "outlook_client_id",
    "outlook_client_secret": "outlook_client_secret",
}
EMAIL_COLUMNS = {
    "email_enabled": "enabled",
    "email_mode": "mode",
    "email_delivery": "delivery",
    "email_max_sends_per_day": "max_sends_per_day",
    "email_instructions": "instructions",
}


@dataclass(frozen=True)
class AppSettings:
    """The two rows as loaded. `value()` / `secret()` return None for "not set here"."""
    settings: dict = field(default_factory=dict)
    secrets: dict = field(default_factory=dict)

    @property
    def version(self) -> int | None:
        return self.settings.get("version")

    def value(self, column: str):
        return self.settings.get(column)

    def secret(self, column: str) -> str | None:
        value = self.secrets.get(column)
        return value if isinstance(value, str) and value.strip() else None

    def credential_overrides(self) -> dict[str, str]:
        """Credentials(...) keyword arguments for every key set in the tables."""
        return {f: v for c, f in SECRET_COLUMNS.items() if (v := self.secret(c))}

    def apply(self, value: T, columns: dict[str, str]) -> T:
        """`value` (a config model) with the non-NULL columns applied, validated again."""
        fields = {f: self.value(c) for c, f in columns.items() if self.value(c) is not None}
        if not fields:
            return value
        try:
            return value.updated(**fields)
        except ConfigError as exc:
            raise ConfigError(f"{SETTINGS_TABLE} (dashboard): {exc}") from None


def _get_row(conn, table: str) -> dict:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = 1").fetchone()
    return sqlite.decode_row(row) if row is not None else {}


def load() -> AppSettings:
    """The settings to apply. Raises ConfigError if they can't be read: starting on the wrong keys or the
    wrong email mode would be worse than not starting."""
    try:
        conn = sqlite.connect()
        try:
            settings = _get_row(conn, SETTINGS_TABLE)
            secrets = _get_row(conn, SECRETS_TABLE)
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 — any failure to read them stops the start, with the reason
        raise ConfigError(f"could not read the settings from {sqlite.db_path()} "
                          f"({type(exc).__name__}: {exc}).") from None
    return AppSettings(settings=settings, secrets=secrets)


def current_version() -> int | None:
    """The settings version now in the database (None if unreadable). Never raises: the daemon polls this
    to restart itself when the dashboard saves a change."""
    try:
        conn = sqlite.connect()
        try:
            row = conn.execute(f"SELECT version FROM {SETTINGS_TABLE} WHERE id = 1").fetchone()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — a locked or missing file just means "no news"
        return None
    return row[0] if row is not None else None


def report(fields: dict) -> str | None:
    """Write the daemon's side of app_settings (applied_*). Never raises; returns the error, if any.

    Finds the database itself (core/sqlite.py), so it also works when config.py failed to import (to
    report *why*)."""
    try:
        conn = sqlite.connect()
        try:
            assignments, params = sqlite.set_clause(fields)
            conn.execute(f"UPDATE {SETTINGS_TABLE} SET {assignments} WHERE id = 1", sqlite.encode_params(params))
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 — best-effort
        return f"{type(exc).__name__}: {exc}"
    return None


def now_iso() -> str:
    return sqlite.utc_now()
