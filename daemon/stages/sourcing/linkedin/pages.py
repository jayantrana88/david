"""Step 2: fetch and read one public LinkedIn company page."""
import asyncio
import json
import logging
import random
import re

import httpx
from bs4 import BeautifulSoup

from apis.browser import BrowserError
from core.clients import get_browser, get_http
from core.limits import limit
from core.log import slog

from .constants import ABOUT_LOC_RE, HIRING_RE
from .settings import Settings


class PageMixin:
    settings: Settings

    @staticmethod
    def clean_place_phrase(m: str) -> str:
        """'Dublin, Ireland. The' -> 'Dublin, Ireland': cut at the end of the sentence ('St.' etc. don't end one)."""
        m = re.split(r"(?<!\bSt)(?<!\bMt)(?<!\bFt)\.\s", m + " ")[0]
        return re.sub(r"[’']s\b", "", m).strip(" ,.")

    @staticmethod
    def jsonld_size(value) -> str | None:
        """JSON-LD `numberOfEmployees` as size-band text: a QuantitativeValue {minValue, maxValue} or {value},
        or a plain number -> '11-50 employees' / '12 employees'. None when it says nothing usable."""
        if isinstance(value, dict):
            low, high = value.get("minValue"), value.get("maxValue")
            if low is not None and high is not None:
                return f"{low}-{high} employees"
            value = value.get("value", high if high is not None else low)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return f"{int(value)} employees"
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None

    @classmethod
    def parse_company_page(cls, html: str) -> dict:
        """
        Read a public company page: JSON-LD Organization (name, website = sameAs, address, ISO
        country) plus the About list (Website, Industry, Company size, Headquarters).
        """
        info = {"name": None, "website": None, "industry": None, "size": None, "headquarters": None,
                "country": None, "locality": None, "region": None,
                "about_places": [],      # 'based in X' phrases from the description
                "hiring_places": []}     # places from the company's own job posts
        soup = BeautifulSoup(html, "lxml")
        info["hiring_places"] = sorted({m.strip() for m in HIRING_RE.findall(soup.get_text(" "))})
        for tag in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(tag.string or "")
            except (json.JSONDecodeError, TypeError):
                continue
            items = data.get("@graph", [data]) if isinstance(data, dict) else data
            for it in items:
                if not isinstance(it, dict) or it.get("@type") not in ("Organization", "Corporation", "LocalBusiness"):
                    continue
                if it.get("sameAs"):
                    info["website"] = it["sameAs"]      # sameAs = company site; `url` is the LinkedIn page
                info["name"] = it.get("name") or info["name"]
                desc = it.get("description")
                if desc:
                    info["about_places"] = [cls.clean_place_phrase(m) for m in ABOUT_LOC_RE.findall(desc)]
                addr = it.get("address")
                if isinstance(addr, dict):
                    info["country"], info["locality"], info["region"] = (
                        addr.get("addressCountry"), addr.get("addressLocality"), addr.get("addressRegion"))
                if not info["size"]:
                    info["size"] = cls.jsonld_size(it.get("numberOfEmployees"))
        for dt in soup.select("dt"):
            dd = dt.find_next("dd")
            if not dd:
                continue
            label, value = dt.get_text(strip=True).lower(), dd.get_text(" ", strip=True)
            if label == "website" and not info["website"]:
                info["website"] = value.split(" External link")[0].strip()
            elif label == "industry":
                info["industry"] = value
            elif label == "company size":
                info["size"] = value                    # the About list wins over JSON-LD
            elif label == "headquarters":
                info["headquarters"] = value
        return info

    async def _load(self, url: str) -> tuple[str, str, str, str]:
        """
        One request for a company page, through the configured transport. Returns (status, final_url,
        html, retry_after); status is the HTTP code or 'error:<Type>'. BrowserUnavailable propagates.
        """
        try:
            if self.settings.transport == "browser":
                async with limit("linkedin"):
                    # the Google referer is true: every company page comes from a Google search
                    page = await get_browser().fetch(url, referer="https://www.google.com/", timeout=20)
                return str(page.status), page.url, page.html, page.retry_after or ""
            async with limit("linkedin"):
                r = await get_http().get(url, headers=self.settings.headers, timeout=15)
            return str(r.status_code), str(r.url), r.text, r.headers.get("Retry-After", "")
        except (httpx.HTTPError, BrowserError) as exc:
            name = str(exc) if isinstance(exc, BrowserError) else type(exc).__name__
            return f"error:{name}", url, "", ""

    async def fetch_company(self, url: str, retry_wait: tuple[float, float] | None = None) -> tuple[dict | None, str]:
        """
        Fetch one public company page. Returns (info, status). info is None when the page couldn't
        be read: status '404' (page gone, not a block) or the last block/error status after the
        retries (999, 429, authwall, timeouts, an empty page ...). Raises BrowserUnavailable when
        the browser can't start.
        """
        s = self.settings
        retry_wait = retry_wait or s.retry_wait
        for attempt in range(s.max_block_retries + 1):
            status, final_url, html, retry_after = await self._load(url)
            if any(w in final_url for w in ("authwall", "/login", "/uas/")):
                status = "authwall"
            if status == "200":
                info = await asyncio.to_thread(self.parse_company_page, html)
                if info["name"] or info["size"] or info["headquarters"]:
                    return info, "200"
                status = "empty-page"            # HTTP 200 but no company data: a soft block
            elif status == "404":
                return None, "404"
            if attempt < s.max_block_retries:
                wait = random.uniform(*retry_wait)
                if retry_after.isdigit():
                    wait = max(wait, min(int(retry_after), 300))
                slog(f"[linkedin] blocked ({status}); waiting {wait:.0f}s, then one retry", level=logging.WARNING)
                await asyncio.sleep(wait)
        return None, status
