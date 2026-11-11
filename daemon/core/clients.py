"""Lazy, process-wide singletons for the external-API clients.

Every service shares ONE instance of each client instead of constructing its own. Call `get_llm(role)`,
`get_jina()`, `get_serper()` ... wherever a client is needed; the first call builds the instance, every
later call returns that same one. Rate limiting doesn't live in the instances: each call throttles to its
API's limiter (core/limits.py), so one shared client serves every pool.

Why lazy getters instead of eager module-level globals
------------------------------------------------------
1. Import-time crash. The clients raise if their API key is missing. Building at import would make a
   blank key (or a harness that never touches that API) blow up just from importing this module. Lazily,
   the worker factories build the clients their pool needs at startup, so a missing key disables just that
   pool, with one clear message (main.py).
2. httpx pool bound to the wrong loop. `HttpClient` creates an `httpx.AsyncClient`; building it inside
   the running event loop avoids "Future attached to a different loop" bugs.

`@lru_cache` on a zero-arg function defers construction to the first call and then memoizes it. Use
`aclose_all()` on shutdown to close the pooled connections.
"""

from __future__ import annotations

import asyncio
from functools import lru_cache
from typing import Literal

import config
from apis.browser import BrowserClient
from apis.gmail import GmailClient
from apis.jina import JinaClient
from apis.mail import Mailer
from apis.outlook import OutlookClient
from apis.serper import SerperClient
from apis.site_check import SiteChecker
from apis.telegram import TelegramClient
from core.db import Db
from core.http import HttpClient
from core.llm import LLMClient


@lru_cache
def get_http() -> HttpClient:
    """Shared central HTTP client for all outbound HTTP (every API client below borrows it)."""
    return HttpClient()


@lru_cache
def get_llm(role: Literal["qualify", "email", "profile"]) -> LLMClient:
    """Shared AI client for one role (config.py -> AI.qualify / AI.email / AI.profile, read at the first
    call), throttled to RATE_LIMITS["llm"]. Raises RuntimeError if the AI settings are incomplete."""
    if config.AI_PROBLEM:
        raise RuntimeError(f"AI: {config.AI_PROBLEM}")
    return LLMClient(getattr(config.AI, role))


@lru_cache
def get_jina() -> JinaClient:
    """Shared Jina Reader client. Raises RuntimeError if the Jina key is missing."""
    return JinaClient(get_http())


@lru_cache
def get_serper() -> SerperClient:
    """Shared Serper client. Raises RuntimeError if the Serper key is missing."""
    return SerperClient(get_http())


@lru_cache
def get_telegram() -> TelegramClient:
    """Shared Telegram client (delivers the written emails). Raises RuntimeError if TELEGRAM_BOT_TOKEN or
    TELEGRAM_CHAT_ID is missing."""
    return TelegramClient(get_http())


@lru_cache
def get_gmail() -> GmailClient:
    """Shared Gmail API client. Raises RuntimeError if GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET is missing or
    `mail_setup.py connect gmail` hasn't been run."""
    return GmailClient(get_http())


@lru_cache
def get_outlook() -> OutlookClient:
    """Shared Microsoft Graph mail client. Raises RuntimeError if OUTLOOK_CLIENT_ID is missing or
    `mail_setup.py connect outlook` hasn't been run."""
    return OutlookClient(get_http())


def get_mailer(delivery: Literal["telegram", "gmail", "outlook"]) -> Mailer:
    """The client that delivers the applications for config.py -> EMAIL.delivery. Raises RuntimeError naming
    what is missing for that channel."""
    return {"telegram": get_telegram, "gmail": get_gmail, "outlook": get_outlook}[delivery]()


@lru_cache
def get_site_checker() -> SiteChecker:
    """Shared website checker (the lead sources use it before saving a lead)."""
    return SiteChecker(get_http())


@lru_cache
def get_browser() -> BrowserClient:
    """Shared headless browser (the LinkedIn source's page fetches). Raises RuntimeError if playwright is
    missing. Chromium itself only starts at the first fetch."""
    return BrowserClient()


_db: Db | None = None
_db_lock = asyncio.Lock()


async def get_db() -> Db:
    """Shared database client (the local SQLite file). Built (async) on first use, reused after.

    Async construction can't go through `@lru_cache`, so this guards a module-level singleton with a lock
    and the standard double-check.
    """
    global _db
    if _db is None:
        async with _db_lock:
            if _db is None:
                _db = await Db.connect()
    return _db


async def aclose_all() -> None:
    """Close every pooled HTTP connection. Call once on shutdown.

    `cache_clear()` afterwards so a later call rebuilds rather than handing back a closed client.
    """
    global _db
    if get_browser.cache_info().currsize:
        await get_browser().aclose()
    if get_site_checker.cache_info().currsize:
        await get_site_checker().aclose()
    if get_http.cache_info().currsize:
        await get_http().aclose()
    for getter in (get_llm, get_jina, get_serper, get_telegram, get_gmail, get_outlook,
                   get_site_checker, get_http, get_browser):
        getter.cache_clear()
    if _db is not None:
        await _db.aclose()
    _db = None
