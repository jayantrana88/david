"""Central async HTTP client (one httpx pool behind verb methods), plus the small URL / header helpers the
page fetches share (`browser_headers`, `normalize_url`).

A thin wrapper over a single `httpx.AsyncClient` so every outbound request in the daemon shares one
connection pool and one place to configure timeouts, redirects and headers. Returns the raw
`httpx.Response` -- callers decide how to validate and parse it:

    http = get_http()
    resp = await http.get("https://example.com/contact", headers=browser_headers("en-US"))
    resp.raise_for_status()

This is shared transport only. Per-API rate limiting belongs in the individual service clients
(Jina / Serper / Telegram), not here, so one pool can carry many APIs while each keeps its
own budget. Per-request `timeout=`, `headers=`, `params=`, `json=` etc. are forwarded straight to httpx.
"""

from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx

from core.log import slog


class HttpClient:
    """Async HTTP client wrapping one shared `httpx.AsyncClient` pool.

    Use as a long-lived singleton (see `core.clients.get_http`). Close it once on shutdown via
    `aclose()`; it also works as an async context manager for short-lived/standalone use.
    """

    def __init__(
        self,
        *,
        timeout_secs: float = 30.0,
        headers: dict[str, str] | None = None,
        follow_redirects: bool = True,
        verify: bool = True,
        max_connections: int = 100,
        max_keepalive_connections: int = 20,
    ) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_secs),
            headers=headers or {"User-Agent": "Intellectiq/1.0"},
            follow_redirects=follow_redirects,
            verify=verify,
            limits=httpx.Limits(
                max_connections=max_connections,
                max_keepalive_connections=max_keepalive_connections,
            ),
        )

    # ── lifecycle ─────────────────────────────────────────────────────────────

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "HttpClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    # ── core ──────────────────────────────────────────────────────────────────

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Send any request. `kwargs` go straight to httpx (params, json, headers, timeout, ...).

        Does not raise on 4xx/5xx -- call `.raise_for_status()`.
        """
        slog(f"[http] {method.upper()} {url}", level=logging.DEBUG)
        return await self._client.request(method, url, **kwargs)

    @asynccontextmanager
    async def stream(self, method: str, url: str, **kwargs: Any) -> AsyncIterator[httpx.Response]:
        """A request whose body is left unread (only the status line and headers are received)."""
        slog(f"[http] {method.upper()} {url} (stream)", level=logging.DEBUG)
        async with self._client.stream(method, url, **kwargs) as resp:
            yield resp

    # ── verbs ─────────────────────────────────────────────────────────────────

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return await self.request("POST", url, **kwargs)


def browser_headers(accept_language: str) -> dict[str, str]:
    """Browser-looking headers for a page we fetch ourselves (no API in front). `accept_language` is required
    rather than defaulted because it changes what some sites return."""
    return {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/124.0.0.0 Safari/537.36"),
        "Accept-Language": accept_language,
    }


def normalize_url(url: str) -> str:
    """
    Canonical form of a website URL, so trivially different spellings of the same site compare equal (the
    lead sources dedupe on it): scheme, "www.", query string, fragment, trailing slash and case are ignored.
    The path is kept, so different pages of one domain (brand.com/delhi vs brand.com/mumbai) stay distinct.
    """
    u = (url or "").strip().lower()
    u = re.sub(r"^[a-z][a-z0-9+.\-]*://", "", u)
    u = re.split(r"[?#]", u, maxsplit=1)[0]
    return u.removeprefix("www.").rstrip("/")
