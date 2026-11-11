"""Tunable numbers for the LinkedIn lead source. Pass a customised `Settings` to `LinkedIn(...)`.

The ceiling on LinkedIn page fetches and Serper searches is RATE_LIMITS["linkedin"] / ["serper"] in config.py;
the jitter below comes on top of it, so the fetches don't arrive on a perfectly regular beat.
"""
from dataclasses import dataclass, field

from .constants import HEADERS


@dataclass
class Settings:
    # ── filters ──
    max_employees: int = 50         # size filter: LinkedIn size band's upper bound must be <= this (a task can override)
    metro_radius_km: float = 30     # city searches also accept companies this close (0 = exact city only)
    dns_check: bool = True          # drop websites whose domain doesn't resolve
    site_check: bool = True         # drop websites that don't answer an HTTP request (apis/site_check.py)
    site_check_timeout: float = 10  # seconds to wait for the site to answer

    # ── volume ──
    candidates: int = 20            # leads to save per business type x location (checks companies until reached)
    max_search_pages: int = 10      # Google result pages (~10 results each) read per business type x location
    max_empty_search_pages: int = 2 # this many result pages in a row without a new company end a search
    max_fetches_per_run: int = 300 # hard cap on LinkedIn page fetches in one run

    # ── page fetching ──
    transport: str = "browser"          # "browser" = a real Chromium (apis/browser.py); "http" = plain httpx
                                        # (LinkedIn answers the latter with 999 after a page or two)
    browser_headless: bool = True       # False shows the browser window
    browser_channel: str | None = "chrome"  # the installed Google Chrome (the most genuine fingerprint);
                                            # None = Playwright's bundled Chromium (`playwright install chromium`)

    # ── pacing ── There is no login, so the only risk is LinkedIn throttling this machine's IP.
    li_delay_range: tuple[float, float] = (3.0, 7.0)          # extra random pause between LinkedIn page fetches
    retry_wait: tuple[float, float] = (15, 30)                # wait before retrying a blocked page
    retry_wait_repeated: tuple[float, float] = (60, 120)      # ...when the previous company was blocked too
    max_block_retries: int = 1                                # a blocked page is retried this many times, then skipped
    max_consecutive_failures: int = 3                         # this many blocked companies in a row => stop the run

    headers: dict = field(default_factory=lambda: dict(HEADERS))   # the "http" transport only

    def __post_init__(self):
        if self.transport not in ("browser", "http"):
            raise ValueError(f"transport must be 'browser' or 'http', not {self.transport!r}")
