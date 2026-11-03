"""Who the email goes to: picking a usable address and greeting the business."""
import re

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
# Scraped pages often contain things like "logo@2x.png" that look like emails
ASSET_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".css", ".js")
# Addresses scraped from pages that nobody reads (or that aren't the business's at all)
JUNK_LOCAL_PARTS = {
    "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon",
    "postmaster", "abuse", "privacy", "unsubscribe",
}
JUNK_DOMAINS = (
    "sentry.io", "wixpress.com", "example.com", "example.org", "domain.com",
    "yourdomain.com", "yoursite.com",
)


def pick_email(raw: str | None) -> str | None:
    """
    `websites.email` can hold several comma-separated addresses (see the site_scrape service).
    Return the first syntactically valid one, or None.
    """
    if not raw:
        return None
    for candidate in re.split(r"[,;\s]+", raw):
        candidate = candidate.strip().lower()
        if not EMAIL_RE.match(candidate) or candidate.endswith(ASSET_SUFFIXES):
            continue
        local, domain = candidate.rsplit("@", 1)
        if local in JUNK_LOCAL_PARTS:
            continue
        if any(domain == d or domain.endswith("." + d) for d in JUNK_DOMAINS):
            continue
        return candidate
    return None


def greeting(name: str | None) -> str:
    """
    Address the company's team, not a person (we don't know who reads the inbox).
    Names often carry suffixes ("Acme Labs | Product Studio"), so keep only the part before
    the first separator.
    """
    short = re.split(r"\s*[|–—]\s*|\s+-\s+|:\s", (name or "").strip())[0].strip()
    return f"Hi {short} team," if short else "Hi there,"
