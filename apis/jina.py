"""Async Jina AI Reader client — fetches a readable rendering of a URL.

Docs: https://r.jina.ai/

    jina = get_jina()                            # core.clients
    resp = await jina.read("acme.com")           # Jina's JSON ({"code": 200, "data": {...}}), or None

Used by the site_scrape service (homepages) and the internal_pages service (subpages). Parsing the
homepage response lives in apis/jina_parsing.py. 429 / 5xx / timeouts are retried with backoff before a
page is given up on; each attempt waits for the running pool's `jina` limiter.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from config import credentials
from core.http import HttpClient
from core.limits import limit
from core.log import slog
from core.retry import with_retry

READER_URL = "https://r.jina.ai/https://"


class JinaClient:
    """Thin wrapper around the Jina AI Reader endpoint, on the shared HTTP pool."""

    def __init__(self, http: HttpClient, api_key: str = credentials.jina_api_key, *,
                 timeout_secs: float = 30.0, attempts: int = 3) -> None:
        if not api_key:
            raise RuntimeError("JinaClient: the Jina key is not set on the dashboard's Settings page")
        self.api_key = api_key
        self._http = http
        self.timeout_secs = timeout_secs
        self.attempts = attempts

    async def read(self, website_url: str) -> dict[str, Any] | None:
        """GET the Jina Reader response for `website_url`. Returns the parsed JSON, or None on failure (logged)."""
        # Strip the protocol prefix if present — READER_URL already includes https://
        clean_url = re.sub(r"^https?://", "", website_url.strip().rstrip("/"))
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "X-Remove-Selector": "header, .class, #id",
            "X-Retain-Images": "none",
            "X-With-Links-Summary": "all",
        }

        async def _do() -> dict[str, Any]:
            async with limit("jina"):
                r = await self._http.get(f"{READER_URL}{clean_url}", headers=headers, timeout=self.timeout_secs)
            r.raise_for_status()  # inside the retry so 429/5xx are retried
            return r.json()

        try:
            return await with_retry(_do, attempts=self.attempts, base_delay=3, max_delay=45,
                                    label=f"jina {website_url}")
        except httpx.TimeoutException:
            slog(f"[jina] timeout: {website_url}", level=logging.WARNING)
        except httpx.HTTPStatusError as exc:
            slog(f"[jina] HTTP {exc.response.status_code}: {website_url}", level=logging.WARNING)
        except Exception as exc:  # noqa: BLE001 — a bad page must not end the lead's other work
            slog(f"[jina] error: {website_url} — {type(exc).__name__}: {exc}", level=logging.WARNING)
        return None
