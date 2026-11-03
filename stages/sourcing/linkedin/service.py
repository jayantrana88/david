"""LinkedIn lead source: a sourcing task -> SourcingRun (no LinkedIn login; Google search via a Serper key).

    for each business type x location:
        site:linkedin.com/company search (Serper, page by page, only as far as needed)
        -> fetch each public company page -> filters -> save_lead, until `candidates` leads are saved

A company is saved only if (1) its location is confirmed inside the searched place (compulsory), (2) its
size band is <= Settings.max_employees, (3) LinkedIn itself lists a website (no fallback search) that
normalizes, resolves in DNS, answers an HTTP request and isn't already known. Each lead is handed to the
injected `save_lead` as soon as it passes; nothing touches the DB here.

Built around one object, `LinkedIn`; the steps are mixins (search.py, pages.py, filters.py). Any step is
callable on its own: `await li.search_companies(...)`, `await li.fetch_company(url)`,
`li.parse_company_page(html)`, `li.check_location(...)`, `await li.evaluate(...)`.
"""

from __future__ import annotations

import asyncio
import logging
import random
from dataclasses import replace

from apis.browser import BrowserUnavailable
from core.clients import get_browser
from core.http import normalize_url
from core.log import slog
from stages.sourcing.models import DUPLICATE, SAVED, LeadRecord, SaveLead, SourcingRun, SourcingTask

from . import geo
from .filters import FilterMixin
from .models import RunAborted, RunState
from .pages import PageMixin
from .search import SearchMixin
from .settings import Settings


class LinkedIn(SearchMixin, PageMixin, FilterMixin):
    def __init__(self, business_types: list[str], locations: list[str], *, save_lead: SaveLead,
                 known: set[str] | None = None, candidates: int | None = None,
                 metro_radius_km: float | None = None, max_employees: int | None = None,
                 target_role: str | None = None, opportunity_type: str | None = None,
                 settings: Settings | None = None):
        """
        business_types:  what to search for, e.g. ["dental clinic"]. Each one is searched in every location.
        locations:       cities / regions / countries, e.g. ["Chicago", "Toronto, Ontario"]. Ones that
                         aren't recognised are reported and dropped; ValueError if none are left.
        save_lead:       saves one lead and says how it went (SAVED / DUPLICATE / ERROR).
        known:           normalized website URLs already in `websites`; extended as leads are saved.
        candidates:      leads to save per business type x location (default: Settings.candidates). Companies
                         are checked until this many pass the filters; fewer are saved only when the search
                         results (Settings.max_search_pages pages) or a run cap run out.
        metro_radius_km: city searches also accept companies this close, 0 = exact city only
                         (default: Settings.metro_radius_km)
        max_employees:   largest size band accepted (default: Settings.max_employees)
        target_role, opportunity_type: copied onto every lead saved (None = the candidate profile's)
        settings:        every other tunable number. candidates, metro_radius_km and max_employees above
                         override it.
        """
        business_types = [b.strip() for b in business_types if isinstance(b, str) and b.strip()]
        if not business_types:
            raise ValueError("LinkedIn needs at least one business type")
        if candidates is not None and candidates < 1:
            raise ValueError("candidates must be at least 1")
        if metro_radius_km is not None and metro_radius_km < 0:
            raise ValueError("metro_radius_km can't be negative")
        if max_employees is not None and max_employees < 1:
            raise ValueError("max_employees must be at least 1")

        overrides = {k: v for k, v in (("candidates", candidates), ("metro_radius_km", metro_radius_km),
                                       ("max_employees", max_employees))
                     if v is not None}
        self.business_types = business_types
        self.locations = locations
        self.target_role = target_role
        self.opportunity_type = opportunity_type
        self.settings = replace(settings or Settings(), **overrides)
        self.save_lead = save_lead
        self.state = RunState(known=known if known is not None else set())
        self.run_info = SourcingRun(source="LinkedIn")

        self.targets = self.resolve_targets(locations)
        if not self.targets:
            raise ValueError("None of the locations could be recognised. Use 'City', "
                             "'City, State/Province/Country' or a region/country")

    @staticmethod
    def resolve_targets(locations: list[str]) -> list[tuple[str, geo.Target]]:
        """Turn location texts into geo Targets. Unrecognised ones are reported and dropped."""
        targets: list[tuple[str, geo.Target]] = []
        for loc in locations:
            t = geo.resolve_target(loc)
            if t is None:
                slog(f"[linkedin] ✗ '{loc}': not recognised. Use 'City', 'City, State/Province/Country' or a "
                     f"region/country.", level=logging.WARNING)
            else:
                slog(f"[linkedin] ✓ '{loc}': {t.scope} in {t.country}")
                targets.append((loc, t))
        return targets

    # ── one company ───────────────────────────────────────────────────────────

    async def get_company_page(self, company: dict) -> dict | None:
        """
        The parsed page for one search hit: from the cache, or fetched (paced, retried). None when the
        page couldn't be read. Raises RunAborted at the fetch cap, or when LinkedIn refuses too many
        pages in a row.
        """
        s, state = self.settings, self.state
        li = state.pages.get(company["slug"])
        if li is not None:
            return li
        if state.fetches >= s.max_fetches_per_run:
            raise RunAborted(f"reached the cap of {s.max_fetches_per_run} LinkedIn page fetches per run")
        if state.fetches:
            await asyncio.sleep(random.uniform(*s.li_delay_range))
        try:
            li, status = await self.fetch_company(company["linkedin_url"],
                                                  s.retry_wait_repeated if state.consecutive_failures else s.retry_wait)
        except BrowserUnavailable as exc:
            raise RunAborted(f"the browser could not start ({exc}); install Google Chrome, or set "
                             f"Settings.browser_channel=None after `playwright install chromium`, "
                             f"or Settings.transport='http'") from exc
        state.fetches += 1
        if li is None:
            self.run_info.rejects[f"fetch failed ({status})"] += 1
            slog(f"[linkedin] could not read the page ({status}), skipping", level=logging.WARNING)
            if status != "404":      # a deleted page isn't a sign we're being blocked
                state.consecutive_failures += 1
            if state.consecutive_failures >= s.max_consecutive_failures:
                raise RunAborted(f"LinkedIn refused {s.max_consecutive_failures} pages in a row ({status}); "
                                 f"likely throttling this IP")
            return None
        state.consecutive_failures = 0
        state.pages[company["slug"]] = li
        return li

    async def save(self, lead: dict) -> bool:
        """Hand one lead to `save_lead` and remember its site. False = not saved."""
        record = LeadRecord(name=lead["name"], website_url=lead["website_url"], category=lead["category"],
                            location=lead["location"], source=lead["source"], employee_size=lead["size"],
                            employee_max=lead["employee_max"], industry=lead["industry"],
                            linkedin_url=lead["linkedin_url"], target_role=self.target_role,
                            opportunity_type=self.opportunity_type)
        outcome = await self.save_lead(record)
        run = self.run_info
        if outcome in (SAVED, DUPLICATE):
            self.state.known.add(normalize_url(lead["website_url"]))
        if outcome == SAVED:
            run.saved += 1
            return True
        if outcome == DUPLICATE:
            run.duplicates += 1
            run.rejects["already in DB"] += 1
        else:
            run.db_errors += 1
        return False

    # ── one search ────────────────────────────────────────────────────────────

    async def process_search(self, keyword: str, location: str, target: geo.Target) -> int:
        """
        Search LinkedIn for one business type x location and save the leads that pass, until
        Settings.candidates leads are saved or the search results run out. Returns how many were saved.
        """
        goal = self.settings.candidates
        slog(f"[linkedin] checking companies until {goal} lead(s) are saved...")
        saved, checked = 0, 0
        # iter_companies asks Google for the next page of results only when this loop has used up the last one
        async for c in self.iter_companies(keyword, location):
            checked += 1
            slog(f"[linkedin] [{checked:02d}] ({saved}/{goal} leads) {c['name']}")
            li = await self.get_company_page(c)
            if li is None:
                continue

            lead, reason, note = await self.evaluate(c, li, target, location, keyword)
            if not lead:
                self.run_info.rejects[reason] += 1
                if reason == "already in DB":
                    self.run_info.duplicates += 1
                slog(f"[linkedin]      skipped: {reason}")
                continue

            slog(f"[linkedin]      {lead['website_url']}  ({lead['size']}; {note})")
            if await self.save(lead):
                saved += 1
                slog("[linkedin]      ✅ saved")
                if saved >= goal:
                    break

        if not checked:
            slog(f"[linkedin] no LinkedIn companies found for '{keyword}' in '{location}'")
        elif saved < goal:
            why = self.search_end or "search ended"
            slog(f"[linkedin] only {saved} of {goal} lead(s) found for '{keyword}' in '{location}': {why}; "
                 f"{checked} companies checked, skipped: "
                 f"{dict(self.run_info.rejects) or 'none'} (run totals)", level=logging.WARNING)
            self.run_info.shortfalls.append(f"'{keyword}' in '{location}': {saved} of {goal} ({why})")
        return saved

    # ── the whole run ─────────────────────────────────────────────────────────

    async def run(self) -> SourcingRun:
        """Every business type x every location it was created with."""
        run = self.run_info
        run.searches = len(self.business_types) * len(self.targets)
        number = 0
        browser = get_browser() if self.settings.transport == "browser" else None
        if browser is not None:
            browser.configure(headless=self.settings.browser_headless, channel=self.settings.browser_channel)
        try:
            for keyword in self.business_types:
                for location, target in self.targets:
                    number += 1
                    slog(f"[linkedin] [{number}/{run.searches}] searching '{keyword}' in '{location}'")
                    try:
                        await self.process_search(keyword, location, target)
                    except RuntimeError as exc:      # Google search failed after its retries
                        slog(f"[linkedin] search failed: {exc}", level=logging.ERROR)
                        run.search_failures += 1
        except RunAborted as exc:
            run.aborted = str(exc)
            slog(f"[linkedin] 🛑 stopping: {exc}", level=logging.WARNING)
        finally:
            if browser is not None:      # no idle Chromium between tasks; the next run starts a fresh session
                await browser.aclose()
        run.fetches = self.state.fetches
        return run


async def run_linkedin(task: SourcingTask, known: set[str], save_lead: SaveLead, *,
                       settings: Settings | None = None) -> SourcingRun:
    """Search the task's category in its location and hand each lead that passes the filters to `save_lead`.

    Raises ValueError for a value the source can't use (e.g. a location it doesn't recognise).
    """
    return await LinkedIn([task.category], [task.location], save_lead=save_lead, known=known,
                          candidates=task.candidates, metro_radius_km=task.metro_radius_km,
                          max_employees=task.max_employees, target_role=task.target_role,
                          opportunity_type=task.opportunity_type, settings=settings).run()
