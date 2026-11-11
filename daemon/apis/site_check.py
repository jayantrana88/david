"""Is a lead's website up and reachable? Works on the URL any lead source finds.

    checker = get_site_checker()                 # core.clients
    r = await checker.check("brand.com")         # scheme optional; https is tried first, then http
    if r.reachable:
        ...
    slog(f"{r.url} -> {r.summary}")              # e.g. "ok (HTTP 200, 0.4s)" / "dns_error (domain does not resolve)"

`reachable` means "a headless browser (the Jina Reader, which scrapes the lead next) can load the site":
a 2xx/3xx answer, or a 401/403/429/999 (bot protection, rate limit: the server is up and just doesn't like
us, status "blocked"). These are not reachable, and each one is a page Jina answers with HTTP 422 ("Failed
to goto ..."), so it is better to drop the lead here than to spend a Jina request on it:
  - 404/410, other 4xx, 5xx, DNS failures, refused connections and timeouts;
  - "ssl_invalid": the certificate is expired / self-signed / for another name (a browser aborts the load);
  - "parked": the domain redirects to a for-sale / parking page (HugeDomains, Sedo ...), not a real site;
  - "slow": the site answered, but only after more than `max_seconds` (its page load would time out).
Only the status line is read, never the body, so a check is cheap. It never raises: every failure comes
back as a SiteCheck with a `status`. It isn't rate limited: every check goes to a different site.
"""

from __future__ import annotations

import asyncio
import re
import ssl
import time
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

from core.http import HttpClient
from core.http import browser_headers

DEFAULT_TIMEOUT = 10.0          # seconds, for connecting and again for the first byte of the answer
DEFAULT_MAX_SECONDS = 20.0      # a site that needs longer than this (all redirects and retries together) is "slow"
_HEADERS = browser_headers("en-US,en;q=0.9")
_BLOCKED_STATUSES = frozenset({401, 403, 429, 999})     # the server answered, it just refuses automated clients
_HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^\d{1,3}(\.\d{1,3}){3}$|^localhost$", re.I)
# Domain-for-sale / parking marketplaces: a lead whose site redirects here has no real site any more.
_PARKED_HOSTS = frozenset({
    "hugedomains.com", "sedo.com", "sedoparking.com", "dan.com", "afternic.com", "godaddy.com", "parkingcrew.net",
    "bodis.com", "above.com", "undeveloped.com", "domainmarket.com", "buydomains.com", "namebright.com",
    "domainsponsor.com", "uniregistry.com", "squadhelp.com", "brandbucket.com", "atom.com", "porkbun.com",
})
_NON_WEB_SCHEME_RE = re.compile(r"^(mailto|tel|javascript|data|ftp|file):", re.I)
_DNS_MARKERS = ("getaddrinfo failed", "name or service not known", "nodename nor servname",
                "temporary failure in name resolution", "no address associated", "errno 11001", "errno -2")
_SSL_MARKERS = ("certificate_verify_failed", "certificate verify failed", "ssl:", "sslerror", "wrong_version_number",
                "hostname mismatch", "tlsv1 alert")


@dataclass(frozen=True)
class SiteCheck:
    url: str                        # the URL as given
    status: str                     # ok | blocked | ssl_invalid | parked | slow | not_found | client_error |
                                    # server_error | dns_error | timeout | connection_error | too_many_redirects |
                                    # invalid_url | error
    reachable: bool                 # see the module docstring
    status_code: int | None = None  # the final HTTP status, when the server answered at all
    final_url: str | None = None    # where redirects ended up (https:// added, www. added, moved domain ...)
    elapsed: float = 0.0            # seconds, all attempts together
    detail: str = ""                # a short human explanation of a failure

    @property
    def summary(self) -> str:
        """One log-ready line: 'ok (HTTP 200, 0.4s)' or 'dns_error (domain does not resolve)'."""
        if self.status_code:
            return f"{self.status} (HTTP {self.status_code}, {self.elapsed:.1f}s)"
        return f"{self.status} ({self.detail})" if self.detail else self.status


def _bare_host(url: str) -> str:
    if "://" not in url:
        url = "https://" + url
    return (urlparse(url).hostname or "").removeprefix("www.")


def _candidates(url: str) -> list[str] | None:
    """The URLs to try, in order, or None if `url` is not something we can request."""
    url = (url or "").strip()
    if not url or _NON_WEB_SCHEME_RE.match(url):
        return None
    if re.match(r"^[a-z][a-z0-9+.\-]*://", url, re.I):
        parsed = urlparse(url)
        if parsed.scheme.lower() not in ("http", "https"):
            return None
        return [url] if parsed.scheme.lower() == "http" else [url, "http://" + url[len(parsed.scheme) + 3:]]
    return ["https://" + url, "http://" + url]      # no scheme saved (Maps sometimes gives bare domains)


def _is_parked(final_url: str | None) -> bool:
    host = _bare_host(final_url) if final_url else ""
    return any(host == parked or host.endswith("." + parked) for parked in _PARKED_HOSTS)


def _classify_status(code: int) -> tuple[str, bool]:
    if code < 400:
        return "ok", True
    if code in _BLOCKED_STATUSES:
        return "blocked", True
    if code in (404, 410):
        return "not_found", False
    if code >= 500:
        return "server_error", False
    return "client_error", False


def _chain_text(exc: BaseException) -> str:
    """The exception's message plus its causes' (httpx wraps the ssl / socket error)."""
    parts, seen = [], set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        parts.append(f"{type(exc).__name__}: {exc}")
        exc = exc.__cause__ or exc.__context__
    return " | ".join(parts).lower()


def _is_ssl_failure(exc: BaseException) -> bool:
    cause: BaseException | None = exc
    while cause is not None:
        if isinstance(cause, ssl.SSLError):
            return True
        cause = cause.__cause__ or cause.__context__
    return isinstance(exc, httpx.ConnectError) and any(m in _chain_text(exc) for m in _SSL_MARKERS)


def _is_dns_failure(exc: BaseException) -> bool:
    return any(m in _chain_text(exc) for m in _DNS_MARKERS)


def _is_worth_retrying(exc: BaseException) -> bool:
    # A DNS failure or a bad certificate will fail the same way again; a timeout or a reset may not.
    if _is_ssl_failure(exc) or _is_dns_failure(exc):
        return False
    return isinstance(exc, (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError))


class SiteChecker:
    """Holds the two pools a check needs: the shared, certificate-checking one, and a lenient one used only
    to see what a site with a bad certificate answers."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http
        self._lenient = HttpClient(verify=False)

    async def aclose(self) -> None:
        await self._lenient.aclose()

    async def _request(self, url: str, timeout: float, verify: bool) -> tuple[int, str]:
        """One GET with the body left unread; (status, final url). Timeouts / resets get one retry."""
        http = self._http if verify else self._lenient
        for attempt in range(2):
            try:
                async with http.stream("GET", url, headers=_HEADERS, timeout=httpx.Timeout(timeout)) as resp:
                    return resp.status_code, str(resp.url)
            except Exception as exc:  # noqa: BLE001 — classified by the caller
                if attempt == 1 or not _is_worth_retrying(exc):
                    raise
                await asyncio.sleep(1.0)
        raise AssertionError("unreachable")  # pragma: no cover

    async def _try_one(self, url: str, timeout: float) -> SiteCheck:
        """Check exactly this URL (no scheme fallback). `SiteCheck.url` is set by the caller."""
        started = time.monotonic()
        ssl_invalid = False
        try:
            try:
                code, final_url = await self._request(url, timeout, verify=True)
            except httpx.ConnectError as exc:
                if not _is_ssl_failure(exc):
                    raise
                # Expired / self-signed / wrong-name certificate: the site is there, so see what it answers.
                ssl_invalid = True
                code, final_url = await self._request(url, timeout, verify=False)
            elapsed = time.monotonic() - started
            status, reachable = _classify_status(code)
            detail = "certificate is not valid" if ssl_invalid else ""
            if reachable:       # the server answered: now the cases where a browser still couldn't use the page
                if _is_parked(final_url):
                    status, reachable, detail = "parked", False, f"redirects to a parked-domain page ({_bare_host(final_url)})"
                elif ssl_invalid:
                    status, reachable = "ssl_invalid", False
            return SiteCheck(url="", status=status, reachable=reachable, status_code=code, final_url=final_url,
                             elapsed=elapsed, detail=detail)
        except httpx.TooManyRedirects:
            status, detail = "too_many_redirects", "redirect loop"
        except httpx.TimeoutException:
            status, detail = "timeout", f"no answer within {timeout:.0f}s"
        except (httpx.InvalidURL, httpx.UnsupportedProtocol, UnicodeError) as exc:
            status, detail = "invalid_url", str(exc)[:100]
        except httpx.TransportError as exc:
            if _is_dns_failure(exc):
                status, detail = "dns_error", "domain does not resolve"
            elif _is_ssl_failure(exc):
                status, detail = "connection_error", f"TLS handshake failed: {str(exc)[:100]}"
            else:
                status, detail = "connection_error", "connection refused or dropped"
        except Exception as exc:  # noqa: BLE001 — a check must never take a lead source down
            status, detail = "error", f"{type(exc).__name__}: {str(exc)[:100]}"
        return SiteCheck(url="", status=status, reachable=False, elapsed=time.monotonic() - started, detail=detail)

    async def check(self, url: str, timeout: float = DEFAULT_TIMEOUT,
                    max_seconds: float = DEFAULT_MAX_SECONDS) -> SiteCheck:
        """Request `url` and report whether the site answers. Never raises.

        With no scheme, https is tried first and http only if https did not get an answer. With an explicit
        https:// URL that does not answer, http:// is tried too (some small business sites never set up TLS).
        `timeout` limits each wait (connect, first byte); `max_seconds` limits one whole answer, redirects and
        retries included: slower than that is "slow", not reachable.
        """
        candidates = _candidates(url)
        if candidates is None or not _HOST_RE.match(_bare_host(candidates[0])):
            return SiteCheck(url=url, status="invalid_url", reachable=False,
                             detail="empty" if not (url or "").strip() else "not a web address")

        started = time.monotonic()
        result: SiteCheck | None = None
        for candidate in candidates:
            result = await self._try_one(candidate, timeout)
            # Any HTTP answer settles it. Only "couldn't connect" is worth trying the other scheme for,
            # and not a DNS failure: the domain is missing whichever scheme is used.
            if result.status_code is not None or result.status in ("dns_error", "too_many_redirects"):
                break
        assert result is not None
        elapsed = time.monotonic() - started
        status, reachable, detail = result.status, result.reachable, result.detail
        if reachable and elapsed > max_seconds:
            status, reachable, detail = "slow", False, f"took {elapsed:.0f}s to answer (limit {max_seconds:.0f}s)"
        return SiteCheck(url=url, status=status, reachable=reachable, status_code=result.status_code,
                         final_url=result.final_url, elapsed=elapsed, detail=detail)
