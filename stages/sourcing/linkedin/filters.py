"""Step 3: the rules a company must pass (location, size, website) to become a lead."""
import asyncio
import re
from urllib.parse import parse_qs, unquote, urlparse

from core.clients import get_site_checker
from core.http import normalize_url

from . import geo
from .constants import HOST_RE, NON_SITE_DOMAINS
from .models import RunState
from .settings import Settings

# getaddrinfo has no timeout of its own and can hang for many seconds on an unresponsive resolver, which
# would stall a long run. A lookup that takes longer than this counts as not resolving.
DNS_TIMEOUT = 5.0


class FilterMixin:
    settings: Settings
    state: RunState

    # ── size ──────────────────────────────────────────────────────────────────

    @staticmethod
    def employee_upper_bound(size_text: str | None) -> int | None:
        """'11-50 employees' -> 50, '1 employee' -> 1, '10,001+ employees' -> huge, unknown -> None."""
        if not size_text:
            return None
        m = re.search(r"([\d,]+)\s*(?:[-–]\s*([\d,]+)|(\+))?", size_text)
        if not m:
            return None
        if m.group(2):
            return int(m.group(2).replace(",", ""))
        if m.group(3):
            return 10**9
        return int(m.group(1).replace(",", ""))

    # ── location ──────────────────────────────────────────────────────────────

    @staticmethod
    def _name_mentions(target: geo.Target, name: str) -> bool:
        hay = geo.norm(name)
        return any(re.search(rf"(?<![a-z0-9]){re.escape(n)}(?![a-z0-9])", hay) for n in target.names if len(n) > 2)

    def check_location(self, target: geo.Target, li: dict, name: str,
                       radius_km: float | None = None) -> tuple[bool, str, str]:
        """
        Compulsory location check. Returns (ok, source, detail). Evidence, strongest first:
          1. LinkedIn's structured address + Headquarters: decides on its own (yes or no).
             City targets also accept a locality within radius_km (Salford for Manchester).
          2. Only when 1 has nothing, recovery from the page's other text:
               a. the About text ('based in X'): accepted when a place matches and none is abroad
               b. the company's job posts ('hiring ... in X'): accepted only when EVERY post is in
                  the target (a company hiring in three cities isn't based in one of them)
          3. The company name mentions the place (city/region targets only)
        Web-search snippets are never used: they mention nearby cities freely.
        """
        if radius_km is None:
            radius_km = self.settings.metro_radius_km
        place = geo.resolve_place(li.get("headquarters") or "", iso_country=li.get("country"),
                                  extra_tokens=[li.get("locality") or "", li.get("region") or ""])
        verdict, why = geo.matches_ex(place, target, radius_km)
        detail = f"{li.get('locality') or ''}|{li.get('region') or ''}|{li.get('country') or ''} / HQ {li.get('headquarters')}"
        if verdict is True:
            return True, "address/HQ", detail + (f" [{why}]" if why.startswith("metro") else "")
        if verdict is False:
            return False, "address/HQ", f"{detail} -> country={place.country}"

        for source, phrases in (("about-text", li.get("about_places") or []), ("job-posts", li.get("hiring_places") or [])):
            places = [p for p in map(geo.resolve_place, phrases) if p.has_info]
            if not places:
                continue
            verdicts = [geo.matches(p, target, radius_km) for p in places]
            foreign = any(p.country and p.country != target.country for p in places)
            if source == "job-posts":
                accepted = all(v is True for v in verdicts)
            else:
                accepted = any(v is True for v in verdicts) and not foreign
            if accepted:
                return True, source, "; ".join(phrases[:3])
            if foreign and not any(v is True for v in verdicts):
                return False, source, "; ".join(phrases[:3])

        if target.scope != "country" and self._name_mentions(target, name):
            return True, "name", name
        return False, "none", "no location info on page"

    # ── website ───────────────────────────────────────────────────────────────

    @staticmethod
    def normalize_website(raw: str) -> tuple[str | None, str]:
        """
        Turn whatever LinkedIn lists as a 'website' into a clean `scheme://host[/path]` string (no
        query, fragment, trailing slash or index page), or (None, reason) if it isn't a usable
        company site. The scheme LinkedIn lists is kept (some sites only work over http); https
        is assumed when none is given.
        """
        s = (raw or "").strip()
        if not s:
            return None, "empty"
        s = s.split()[0]                                   # "example.com External link ..." etc.
        if "linkedin.com/redir/redirect" in s.lower():     # unwrap LinkedIn's outbound redirect
            q = parse_qs(urlparse(s).query).get("url")
            if not q:
                return None, "bad redirect wrapper"
            s = unquote(q[0])
        if re.match(r"^[a-z][a-z0-9+.\-]*:(?!//)(?!\d)", s, re.I):   # mailto:, tel:, javascript: ...
            return None, "not a web URL"
        if not re.match(r"^[a-z][a-z0-9+.\-]*://", s, re.I):
            s = "https://" + s.lstrip("/")
        p = urlparse(s)
        if p.scheme.lower() not in ("http", "https"):
            return None, f"scheme {p.scheme}"
        if p.username or p.password:                                  # user@host tricks / emails
            return None, "contains userinfo"
        host = (p.hostname or "").lower().rstrip(".")
        if not HOST_RE.match(host):
            return None, f"invalid host {host!r}"
        root = host.removeprefix("www.")
        if any(root == d or root.endswith("." + d) for d in NON_SITE_DOMAINS):
            return None, f"not a company site ({root})"
        path = re.sub(r"/+", "/", p.path or "")
        path = re.sub(r"/(index|home)\.(html?|php|aspx?)$", "", path, flags=re.I).rstrip("/")
        return f"{p.scheme.lower()}://{host}{path}", "ok"

    @staticmethod
    async def dns_resolves(url: str) -> bool:
        """True if the site's domain resolves. A lookup that takes longer than DNS_TIMEOUT counts as not resolving."""
        try:
            await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(urlparse(url).hostname, None),
                                   timeout=DNS_TIMEOUT)
            return True
        except (OSError, TimeoutError, UnicodeError):
            return False

    # ── all rules, for one company ────────────────────────────────────────────

    async def evaluate(self, company: dict, li: dict, target: geo.Target,
                       location: str, keyword: str) -> tuple[dict | None, str, str]:
        """Apply the rules to one fetched company. Returns (lead_or_None, reject_reason, location_note)."""
        name = li.get("name") or company["name"]
        ok, source, detail = self.check_location(target, li, name)
        note = f"{source}: {detail[:70]}"
        if not ok:
            return None, "location: " + ("unconfirmed" if source == "none" else f"wrong place ({source})"), note

        upper = self.employee_upper_bound(li["size"])
        if upper is None:
            return None, "size: unknown", note
        if upper > self.settings.max_employees:
            return None, f"size: too big ({li['size']})", note

        if not li["website"]:
            return None, "website: not listed on LinkedIn", note
        site, why = self.normalize_website(li["website"])
        if not site:
            return None, f"website: {why}", note
        if normalize_url(site) in self.state.known:
            return None, "already in DB", note
        if self.settings.dns_check and not await self.dns_resolves(site):
            return None, "website: domain does not resolve", note
        if self.settings.site_check:
            check = await get_site_checker().check(site, timeout=self.settings.site_check_timeout)
            if not check.reachable:
                # Grouped by status in the run summary. Not remembered in `known`: a site that was
                # only down for a moment gets another chance on the next run.
                return None, f"website: not reachable ({check.status})", note

        return {"name": name, "website_url": site, "category": keyword, "location": location,
                "source": "Linkedin", "size": li["size"], "employee_max": upper, "industry": li.get("industry"),
                "linkedin_url": company.get("linkedin_url"), "note": note}, "ok", note

