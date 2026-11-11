"""Step 1: Google search (through Serper) restricted to LinkedIn company pages."""
import logging
import re
from typing import AsyncIterator

from apis.serper import SearchAuthError
from core.clients import get_serper
from core.log import slog

from .constants import COMPANY_RE
from .models import RunAborted
from .settings import Settings


class SearchMixin:
    settings: Settings
    search_end: str = ""        # why the last iter_companies stopped yielding (for the run's shortfall note)

    @staticmethod
    def clean_name(title: str) -> str:
        t = re.sub(r"\s*[|\-–]\s*LinkedIn\s*$", "", title, flags=re.I)
        return re.sub(r"\s*\|\s*$", "", t).strip(" |-–")

    async def iter_companies(self, keyword: str, location: str) -> AsyncIterator[dict]:
        """
        Unique LinkedIn company pages found by a Google search, one results page at a time: the next
        page is only requested when the caller has used up the previous one, so a search that finds its
        leads early costs few requests. Ends when Google has no more results, a page adds no new
        company, or Settings.max_search_pages pages have been read. Search-result titles are only used
        to get the page URL; everything that matters comes from the page itself.
        Raises RuntimeError when the search fails after its retries, RunAborted when the key is refused.
        """
        query = f"site:linkedin.com/company {keyword} {location}"
        seen: set[str] = set()
        empty_pages = 0
        self.search_end = ""
        for page in range(1, self.settings.max_search_pages + 1):
            try:
                results = await get_serper().search(query, page=page)
            except SearchAuthError as exc:
                raise RunAborted(str(exc).splitlines()[0]) from exc
            if not results:
                self.search_end = f"Google returned no results on page {page}"
                return
            new = 0
            for r in results:
                m = COMPANY_RE.match(r["link"])
                if not m or m.group(1).lower() in seen:
                    continue
                slug = m.group(1).lower()
                seen.add(slug)
                new += 1
                yield {"slug": slug,
                       "linkedin_url": f"https://www.linkedin.com/company/{slug}",
                       "name": self.clean_name(r["title"]) or slug}
            slog(f"[linkedin] search page {page}: {new} new compan{'y' if new == 1 else 'ies'}", level=logging.DEBUG)
            # one page of repeats / non-company links doesn't mean the results are over; a few in a row do
            empty_pages = 0 if new else empty_pages + 1
            if empty_pages >= self.settings.max_empty_search_pages:
                self.search_end = f"{empty_pages} result page(s) in a row had no new company (up to page {page})"
                return
        self.search_end = f"reached the cap of {self.settings.max_search_pages} result pages"

    async def search_companies(self, keyword: str, location: str, want: int | None = None) -> list[dict]:
        """`iter_companies` as a list: at most `want` companies (default: every page the search allows)."""
        companies: list[dict] = []
        async for company in self.iter_companies(keyword, location):
            companies.append(company)
            if want is not None and len(companies) >= want:
                break
        return companies
