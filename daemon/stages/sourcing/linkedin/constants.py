"""Fixed patterns and lists used by the LinkedIn lead finder (the tunable numbers are in settings.py)."""
import re

from core.http import browser_headers

# This source targets US/CA/EU companies, so ask LinkedIn for US English.
HEADERS = browser_headers("en-US,en;q=0.9")

COMPANY_RE   = re.compile(r"https?://(?:[a-z]{2,3}\.)?linkedin\.com/company/([^/?#]+)", re.I)
HIRING_RE    = re.compile(r"hiring (?:an? )?(?:new )?[^.]{3,80}? in ([^.]{2,60}?)\.\s*Apply", re.I)
ABOUT_LOC_RE = re.compile(r"\b(?:based|located|headquartered|situated) in ((?:[A-Z][\w'’.\-]*,? ?){1,4})")
HOST_RE      = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$")

# "Websites" that are really social pages, link hubs or aggregators, not a company's own site
NON_SITE_DOMAINS = {
    "linkedin.com", "facebook.com", "fb.com", "instagram.com", "twitter.com", "x.com",
    "youtube.com", "youtu.be", "pinterest.com", "tiktok.com", "wa.me", "whatsapp.com",
    "linktr.ee", "linktree.com", "bit.ly", "tinyurl.com", "goo.gl", "forms.gle",
    "justdial.com", "practo.com", "indiamart.com", "sulekha.com", "yelp.com",
    "google.com", "maps.app.goo.gl", "wikipedia.org", "crunchbase.com",
    "behance.net", "dribbble.com", "medium.com", "wixsite.com", "business.site",
}
