"""
Pick a site's main internal pages from the links found on its homepage. Pure logic, no network.

Used by the site_scrape service, whose result is saved as `website_scrapes.main_links`; the
internal_pages service then scrapes those pages. The selection is deterministic:

  1. keep only http(s) links on the lead's own site, once each, and never the homepage itself;
  2. drop noise (legal, login, cart, ... and files such as pdf / images);
  3. classify each link by the words in its URL path (about, services, pricing, contact, blog, ...);
  4. choose up to `limit` of them, one page of each type before a second of any type, in the order of
     `PRIORITY_ORDER`, so the pages read are about / services / pricing rather than four blog posts.

    select_main_links(data["links"], content_links, base_urls=[website_url, data["url"]], limit=5)
    # -> {"About us": "https://acme.com/about", "Pricing": "https://acme.com/pricing", ...}
"""
import re
from urllib.parse import urljoin, urlparse

from core.http import normalize_url

# A path segment that starts with one of these words is noise (`/privacy`, `/legal/imprint`,
# `/account/orders`; not `/accountants`). File extensions are dropped wherever they appear.
NOISE_SEGMENTS = [
    "privacy", "terms", "tos", "legal", "cookie", "cookies", "login", "signup", "register", "signin",
    "sign-in", "sign-up", "logout", "cart", "checkout", "account", "dashboard", "thank-you", "thankyou",
    "404",
]
NOISE_FILE_EXTENSIONS = ("pdf", "zip", "jpg", "jpeg", "png", "gif", "svg", "ico", "css", "js", "xml", "json")

# Words (whole words, hyphen / underscore separated) that make a path segment a page type. The first
# type in this order that matches a segment wins.
PAGE_TYPE_KEYWORDS = {
    "about": ["about", "team", "story", "company", "who-we-are", "our-story"],
    "services": ["services", "service", "what-we-do", "solutions", "products", "product", "features"],
    "pricing": ["pricing", "plans", "buy", "subscribe"],
    "contact": ["contact", "get-in-touch", "reach-us"],
    "blog_index": ["blog", "articles", "insights", "resources", "news"],
    "case_studies": ["case-studies", "case-study", "portfolio", "work", "clients"],
    "faq": ["faq", "help", "support", "questions"],
}

# The types, most useful first. `blog_post` (an article under a blog index) and `other` come last.
PRIORITY_ORDER = ["about", "services", "pricing", "case_studies", "blog_index", "faq", "contact",
                  "blog_post", "other"]

_NOISE_RE = re.compile(
    r"(?:^|/)(?:" + "|".join(re.escape(w) for w in NOISE_SEGMENTS) + r")(?![a-z0-9])"
    r"|\.(?:" + "|".join(NOISE_FILE_EXTENSIONS) + r")$",
    re.IGNORECASE,
)
_TYPE_RES = {
    page_type: re.compile(r"(?<![a-z0-9])(?:" + "|".join(re.escape(k) for k in keywords) + r")(?![a-z0-9])")
    for page_type, keywords in PAGE_TYPE_KEYWORDS.items()
}

MAX_NAME_CHARS = 100


def _with_scheme(url: str) -> str:
    return url if "://" in url else f"https://{url}"


def _host(url: str) -> str:
    """Host of a URL, lowercased and without "www." (so acme.com and www.acme.com are one site)."""
    return urlparse(_with_scheme(url.strip())).netloc.lower().removeprefix("www.")


def _pairs(links) -> list[tuple[str, str]]:
    """(text, url) pairs from a Jina link summary: an {anchor text: url} dict, or a list of [text, url]."""
    if isinstance(links, dict):
        return [(str(text or ""), str(url or "")) for text, url in links.items()]
    if isinstance(links, list):
        return [(str(item[0] or ""), str(item[1] or ""))
                for item in links if isinstance(item, (list, tuple)) and len(item) >= 2]
    return []


def classify_path(path: str) -> str:
    """The page type of a URL path (a key of PAGE_TYPE_KEYWORDS, `blog_post` or `other`)."""
    segments = [s for s in path.lower().split("/") if s]
    for i, segment in enumerate(segments):
        for page_type, pattern in _TYPE_RES.items():
            if pattern.search(segment):
                # a deeper slug under a blog index is one article, not the index
                if page_type == "blog_index" and len(segments) > i + 1:
                    return "blog_post"
                return page_type
    return "other"


def _priority(page_type: str) -> int:
    try:
        return PRIORITY_ORDER.index(page_type)
    except ValueError:
        return len(PRIORITY_ORDER)


def _name_for(text: str, url: str, taken: dict) -> str:
    """The key for a page in the result: its link text, or the URL if the text is empty or already used."""
    name = " ".join(text.split())[:MAX_NAME_CHARS]
    return name if name and name not in taken else url


def select_main_links(*link_sources, base_urls: list[str], limit: int = 5) -> dict[str, str]:
    """
    Choose up to `limit` main internal pages from the homepage's links.

    link_sources: any number of link collections, each an {anchor text: url} dict or a list of
                  [text, url] pairs (Jina's `data.links`, the links found in the page content ...).
                  Earlier sources win when a URL appears in several.
    base_urls:    the site's own URLs (the lead's website_url, the URL Jina finally landed on). Relative
                  links are resolved against the first; a link is internal if its host is any of theirs.

    Returns {link text: url}, best page first; empty when nothing qualifies.
    """
    base_urls = [u for u in base_urls if u and u.strip()]
    if not base_urls or limit < 1:
        return {}
    hosts = {_host(u) for u in base_urls}
    resolve_against = _with_scheme(base_urls[0].strip())

    # normalized url -> (text, clean url, page type), deduped, internal, not noise, not the homepage
    candidates: dict[str, tuple[str, str, str]] = {}
    for source in link_sources:
        for text, href in _pairs(source):
            href = href.strip()
            if not href:
                continue
            parsed = urlparse(urljoin(resolve_against, href))
            if parsed.scheme not in ("http", "https") or _host(parsed.netloc) not in hosts:
                continue
            if not parsed.path.strip("/") or _NOISE_RE.search(parsed.path):
                continue        # the homepage itself, or noise
            clean = f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")
            key = normalize_url(clean)
            if key not in candidates:
                candidates[key] = (text, clean, classify_path(parsed.path))

    # group by type; within a type the shorter URL (the more canonical, landing-like page) comes first
    by_type: dict[str, list[tuple[str, str]]] = {}
    for text, clean, page_type in candidates.values():
        by_type.setdefault(page_type, []).append((text, clean))
    for pages in by_type.values():
        pages.sort(key=lambda page: len(page[1]))

    ordered_types = sorted(by_type, key=_priority)
    picks: dict[str, str] = {}
    for round_index in range(max((len(pages) for pages in by_type.values()), default=0)):
        for page_type in ordered_types:
            pages = by_type[page_type]
            if round_index < len(pages):
                text, url = pages[round_index]
                picks[_name_for(text, url, picks)] = url
                if len(picks) >= limit:
                    return picks
    return picks
