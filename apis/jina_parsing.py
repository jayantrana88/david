"""
Pure parsing of a Jina AI Reader response — no network calls. Used by the site_scrape service.
"""
import re

from apis.link_selection import select_main_links


def extract_markdown_links(content: str) -> dict:
    """
    Extract all markdown-style links [text](url) from the content string.
    Returns a dict of { text: url }.
    """
    if not content:
        return {}
    pattern = re.compile(r"\[([^\]]+)\]\((https?://[^\)]+)\)")
    return {m.group(1).strip(): m.group(2).strip() for m in pattern.finditer(content)}


_MD_LINK_RE = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")


def page_text(data: dict, limit: int) -> str:
    """A Jina `data` block as compact plain text for the AI: title, description and content, markdown links
    reduced to their text and whitespace collapsed, cut to `limit` characters."""
    parts = [data.get("title"), data.get("description"), _MD_LINK_RE.sub(r"\1", data.get("content") or "")]
    return " ".join(" ".join(str(p).split()) for p in parts if p)[:limit]


_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}")
# "logo@2x.png"-style matches: file extensions that pass the TLD check
_FILE_EXTS = {"png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "css", "js", "woff", "woff2"}


def _iter_strings(obj):
    """Yield every string inside a nested dict / list / tuple (keys and values)."""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from _iter_strings(k)
            yield from _iter_strings(v)
    elif isinstance(obj, (list, tuple)):
        for item in obj:
            yield from _iter_strings(item)


def extract_emails(*sources) -> list[str]:
    """
    Extract unique, lower-cased email addresses, in first-seen order, from any mix of strings and
    JSON-like structures (dicts / lists are walked, so `mailto:` links in Jina's link summary count).
    """
    seen: dict[str, None] = {}
    for source in sources:
        for text in _iter_strings(source):
            text = text.replace("%40", "@").replace("%20", " ")   # mailto:info%40acme.com
            for match in _EMAIL_RE.findall(text):
                email = match.lower().strip(".")
                if email.rsplit(".", 1)[-1] not in _FILE_EXTS:
                    seen.setdefault(email)
    return list(seen)


def parse_jina_response(jina_json: dict, base_url: str | None = None, max_main_links: int = 5) -> dict:
    """
    Extract the fields we want to store from the Jina API response.

    base_url:       the lead's own URL, used to tell its internal links from external ones (the URL Jina
                    ended up on, `data.url`, counts too, so a redirect to www. is fine).
    max_main_links: how many main pages to keep in `main_links`.

    Returns a dict with keys:
      raw_json, links, main_links, emails

    The business summary is not taken from here: the AI writes it (stages/scrape/qualify.py) from
    `page_text(raw_json, ...)`.

    `emails` is written by the scrape pool to `websites.email` — the column the email
    pool's queue (`stages/email/store.py::uncontacted_leads`) depends on. Don't drop it.
    """
    data = jina_json.get("data", {})

    # raw_json — the full `data` block
    raw_json = data

    # links — the link summary Jina adds when asked with `X-With-Links-Summary: all` (data.links).
    # Stored as Jina returns it (an {anchor text: url} object, or a list of pairs); external
    # resources (preload, icons) remain available inside raw_json.
    links = data.get("links") or None

    # main_links — the site's main internal pages ({link text: url}, at most `max_main_links`), chosen from
    # every link Jina found (the link summary, which also has the navigation bar) and the hyperlinks in the
    # page content: same site only, no legal / login / file links, one page of each kind first
    # (apis/link_selection.py). The internal_pages service scrapes these pages.
    content = data.get("content", "")
    main_links = select_main_links(
        links, extract_markdown_links(content),
        base_urls=[base_url or "", data.get("url") or ""], limit=max_main_links,
    ) or None

    description = (data.get("description") or "").strip()

    # Extract emails — the link summary first (`mailto:` links are the most deliberate), then the
    # page text, description and title
    emails = extract_emails(links, content, description, data.get("title"))

    return {
        "raw_json":   raw_json  or None,
        "links":      links,
        "main_links": main_links,
        "emails":     emails,
    }
