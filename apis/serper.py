"""Async Serper (serper.dev) client — Google web search results through a paid SERP API.

Used by the LinkedIn lead source to find company pages with `site:linkedin.com/company ...`. One request
returns one page of Google results (about 10); ask for the next page with `page=2`, and so on.

    results = await get_serper().search("site:linkedin.com/company dental clinic Chicago", page=1)
    # [{"title": ..., "link": ..., "snippet": ...}, ...]   (empty list = no more results)

Timeouts / dropped connections / 429 / 5xx are retried with backoff before `search` gives up.
"""

from __future__ import annotations

import httpx

from config import credentials
from core.http import HttpClient
from core.limits import limit
from core.retry import with_retry

SERPER_URL = "https://google.serper.dev/search"


class SearchAuthError(RuntimeError):
    """The key was refused or the account is out of credits: every further search would fail too."""


class SerperClient:
    """Thin wrapper around the Serper Google search endpoint, on the shared HTTP pool."""

    def __init__(self, http: HttpClient, api_key: str = credentials.serper_api_key, *,
                 attempts: int = 4, timeout_secs: float = 30.0) -> None:
        if not api_key:
            raise RuntimeError("SerperClient: SERPER_API_KEY is not set in credentials.env "
                               "(get one at https://serper.dev)")
        self.api_key = api_key
        self._http = http
        self.attempts = attempts
        self.timeout_secs = timeout_secs

    async def search(self, query: str, page: int = 1, num: int = 10) -> list[dict[str, str]]:
        """One page of Google results for `query` (`title`, `link`, `snippet`). Empty = no more results.

        Raises SearchAuthError when the key is refused / out of credits, RuntimeError when the search keeps
        failing.
        """
        async def _do() -> dict:
            async with limit("serper"):
                r = await self._http.post(SERPER_URL, timeout=self.timeout_secs,
                                          headers={"X-API-KEY": self.api_key, "Content-Type": "application/json"},
                                          json={"q": query, "page": page, "num": num})
            r.raise_for_status()
            return r.json()

        try:
            data = await with_retry(_do, attempts=self.attempts, base_delay=5, max_delay=60,
                                    label=f"serper page {page}")
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            body = (exc.response.text or "")[:200]
            if status in (400, 401, 402, 403) and any(w in body.lower() for w in ("credit", "key", "unauthorized")):
                raise SearchAuthError(f"Serper refused the request (HTTP {status}): {body}") from exc
            raise RuntimeError(f"web search failed (HTTP {status}: {body})") from exc
        except httpx.HTTPError as exc:
            raise RuntimeError(f"web search failed ({type(exc).__name__})") from exc

        return [{"title": r.get("title", ""), "link": r.get("link", ""), "snippet": r.get("snippet", "")}
                for r in data.get("organic", []) if isinstance(r, dict)]
