"""Async headless-browser client (Playwright Chromium) -- fetches a page the way a real browser does.

Used by the LinkedIn lead source for its company pages: a plain HTTP request is Python's TLS/HTTP stack
behind a borrowed Chrome User-Agent, which LinkedIn spots and answers with 999. Here the TLS, HTTP/2,
headers, JS and cookies all belong to a real Chromium.

    page = await get_browser().fetch("https://www.linkedin.com/company/acme", referer="https://www.google.com/")
    page.status, page.url, page.html      # final URL after redirects, the rendered HTML

One browser and ONE context serve every fetch, so cookies a site sets on the first page are sent with the
next, like one visitor clicking around. It starts on the first `fetch` and `aclose()` shuts it; a later
`fetch` starts a fresh one (fresh cookies). Rate limiting is the caller's (`async with limit(...)`).

Nothing else may import `playwright`. Setup: `pip install playwright` and `playwright install chromium`.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from core.log import slog

try:
    from playwright.async_api import Error as PlaywrightError
    from playwright.async_api import async_playwright
except ImportError:     # reported when the client is built, so a harness that never fetches can still import this
    async_playwright = None
    PlaywrightError = Exception

BLOCKED_RESOURCES = {"image", "font", "media"}

# page.content() and the close() calls take no timeout of their own in Playwright's API, so a wedged
# CDP pipe (the browser stops answering, but the OS process is still alive) would otherwise hang forever.
CONTENT_TIMEOUT = 10.0
CLOSE_TIMEOUT = 5.0


def _first_line(exc: BaseException) -> str:
    """The first line of str(exc), or the exception's type name if that's empty (e.g. a plain TimeoutError)."""
    return (str(exc) or type(exc).__name__).splitlines()[0][:200]


class BrowserError(RuntimeError):
    """One fetch failed (timeout, connection error, crashed page ...). The message is the error's type name."""


class BrowserUnavailable(RuntimeError):
    """The browser could not be started (e.g. Chromium not installed): every further fetch would fail too."""


@dataclass
class BrowserPage:
    status: int                 # HTTP status of the main document (0 = no response)
    url: str                    # final URL, after redirects
    html: str
    retry_after: str | None     # the Retry-After header, if any


class BrowserClient:
    """One lazily started Chromium + context, shared by every fetch."""

    def __init__(self, *, headless: bool = True, channel: str | None = None, block_resources: bool = True,
                 locale: str = "en-US") -> None:
        """
        headless:        False shows the window (useful to watch a run)
        channel:         None = Playwright's bundled Chromium; "chrome" = the installed Google Chrome
        block_resources: skip images, fonts and media (the pages this is used for are server-rendered HTML)
        locale:          navigator.language and Accept-Language
        """
        if async_playwright is None:
            raise RuntimeError("BrowserClient: playwright is not installed "
                               "(pip install playwright && playwright install chromium)")
        self.headless = headless
        self.channel = channel
        self.block_resources = block_resources
        self.locale = locale
        self._pw = None
        self._browser = None
        self._context = None
        self._lock = asyncio.Lock()

    def configure(self, *, headless: bool | None = None, channel: str | None = None) -> None:
        """Change how the browser is launched. Takes effect the next time it starts (after `aclose()`)."""
        if headless is not None:
            self.headless = headless
        self.channel = channel

    # ── lifecycle ─────────────────────────────────────────────────────────────

    async def _ensure_started(self):
        """The shared context, starting the browser first if needed. Raises BrowserUnavailable."""
        if self._context is not None and self._browser is not None and self._browser.is_connected():
            return self._context
        async with self._lock:
            if self._context is not None and self._browser is not None and self._browser.is_connected():
                return self._context
            await self._close_quietly()
            try:
                self._pw = await async_playwright().start()
                self._browser = await self._pw.chromium.launch(
                    headless=self.headless, channel=self.channel,
                    args=["--disable-blink-features=AutomationControlled"])
                # The UA from the engine itself (so it always matches the real version), minus "Headless".
                version = self._browser.version
                user_agent = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              f"(KHTML, like Gecko) Chrome/{version} Safari/537.36")
                self._context = await self._browser.new_context(
                    user_agent=user_agent, locale=self.locale, viewport={"width": 1366, "height": 768},
                    extra_http_headers={"Accept-Language": f"{self.locale},{self.locale.split('-')[0]};q=0.9"})
                if self.block_resources:
                    await self._context.route("**/*", self._route)
            except Exception as exc:
                await self._close_quietly()
                raise BrowserUnavailable(f"{type(exc).__name__}: {_first_line(exc)}") from exc
            slog(f"[browser] started Chromium {version} ({'headless' if self.headless else 'headed'}"
                 f"{f', channel {self.channel}' if self.channel else ''})")
            return self._context

    @staticmethod
    async def _route(route) -> None:
        if route.request.resource_type in BLOCKED_RESOURCES:
            await route.abort()
        else:
            await route.continue_()

    async def _close_quietly(self) -> None:
        for obj, method in ((self._context, "close"), (self._browser, "close"), (self._pw, "stop")):
            if obj is not None:
                try:
                    await asyncio.wait_for(getattr(obj, method)(), timeout=CLOSE_TIMEOUT)
                except Exception:  # noqa: BLE001 -- already dead, or too wedged to answer: either way, move on
                    pass
        self._pw = self._browser = self._context = None

    async def aclose(self) -> None:
        """Shut the browser. A later fetch starts a fresh one."""
        if self._pw is not None:
            async with self._lock:
                await self._close_quietly()
            slog("[browser] closed")

    # ── core ──────────────────────────────────────────────────────────────────

    async def fetch(self, url: str, *, referer: str | None = None, timeout: float = 20.0) -> BrowserPage:
        """Load `url` in a new tab of the shared context and return its HTML once the document has loaded.

        Raises BrowserUnavailable when the browser can't start, BrowserError when this one page failed.
        If the browser died, or `page.content()` never returns (a wedged CDP pipe: the process is still
        alive but stops answering -- it has no timeout of its own), the browser is force-restarted once
        before giving up.
        """
        for attempt in (1, 2):
            context = await self._ensure_started()
            page = None
            try:
                page = await context.new_page()
                resp = await page.goto(url, referer=referer, wait_until="domcontentloaded",
                                       timeout=timeout * 1000)
                html = await asyncio.wait_for(page.content(), timeout=CONTENT_TIMEOUT)
                return BrowserPage(status=resp.status if resp else 0, url=page.url, html=html,
                                   retry_after=(await resp.header_value("retry-after")) if resp else None)
            except (PlaywrightError, asyncio.TimeoutError) as exc:
                wedged = isinstance(exc, asyncio.TimeoutError)
                dead = self._browser is None or not self._browser.is_connected()
                if attempt == 1 and (wedged or dead):
                    slog(f"[browser] {url}: {'page.content() timed out -- browser wedged' if wedged else 'browser died'}"
                         f" ({type(exc).__name__}); restarting", level=logging.WARNING)
                    if wedged:
                        async with self._lock:
                            await self._close_quietly()   # don't reuse a pipe that stopped answering
                    continue
                slog(f"[browser] {url}: {type(exc).__name__}: {_first_line(exc)}", level=logging.WARNING)
                raise BrowserError("Timeout" if wedged else type(exc).__name__) from exc
            finally:
                if page is not None:
                    try:
                        await asyncio.wait_for(page.close(), timeout=CLOSE_TIMEOUT)
                    except Exception:  # noqa: BLE001
                        pass
        raise BrowserError("browser died twice")
