"""
Offline place matching for worldwide targeting (pycountry + geonamescache).
Used by the LinkedIn lead source (stages/sourcing/linkedin/); no network access, no API keys.

    resolve_target(text)  -> Target   what the user asked for (city / region / country)
    resolve_place(text)   -> Place    what a company's location text says
    matches_ex(place, target, radius_km) -> (True / False / None, reason)
                                      None = the place carries no usable information
"""
import math
import re
import unicodedata
from dataclasses import dataclass, field

import geonamescache
import pycountry

# Any country can be targeted. These two sets only set the priority when a region name exists in
# several countries (see the subdivision index below). North America = US + Canada; Europe = EU-27 + UK,
# Switzerland, Norway, Iceland, Liechtenstein.
NORTH_AMERICA = {"US", "CA"}
EUROPE = {"AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
          "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",   # EU-27
          "GB", "CH", "NO", "IS", "LI"}                                          # + non-EU

COUNTRY_ALIASES = {
    "usa": "US", "us": "US", "u s": "US", "u s a": "US", "america": "US", "united states of america": "US",
    "uk": "GB", "u k": "GB", "great britain": "GB", "britain": "GB", "england": "GB", "scotland": "GB",
    "wales": "GB", "northern ireland": "GB",
    "holland": "NL", "the netherlands": "NL", "czechia": "CZ", "czech republic": "CZ",
    "deutschland": "DE", "espana": "ES", "italia": "IT", "schweiz": "CH", "suisse": "CH",
    "osterreich": "AT", "belgique": "BE", "belgie": "BE", "sverige": "SE", "danmark": "DK",
}

# English names for regions that pycountry only has in the local language
REGION_ALIASES = {
    "bavaria": "bayern", "north rhine westphalia": "nordrhein westfalen", "lower saxony": "niedersachsen",
    "saxony": "sachsen", "hesse": "hessen", "thuringia": "thuringen", "north holland": "noord holland",
    "south holland": "zuid holland", "catalonia": "catalunya", "andalusia": "andalucia",
    "lombardy": "lombardia", "tuscany": "toscana", "piedmont": "piemonte", "sicily": "sicilia",
    "brittany": "bretagne", "normandy": "normandie", "flanders": "vlaanderen",
}

BIG_CITY_POPULATION = 100_000   # a place this big that is also a region ('Berlin') is treated as a city


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s.lower())).strip()


# ── gazetteer (built once, at import) ─────────────────────────────────────────

ISO_CODES = {c.alpha_2 for c in pycountry.countries}

COUNTRY_BY_NAME: dict[str, str] = dict(COUNTRY_ALIASES)
for _c in pycountry.countries:
    for _attr in ("name", "official_name", "common_name"):
        _v = getattr(_c, _attr, None)
        if _v:
            COUNTRY_BY_NAME.setdefault(norm(_v), _c.alpha_2)

SUBDIV_BY_NAME: dict[str, tuple[str, str]] = {}   # norm(name) -> (country, code)
ABBR_BY_COUNTRY: dict[str, dict[str, str]] = {"US": {}, "CA": {}}   # 'tx' -> 'texas'
# Every country's subdivisions are indexed. NORTH_AMERICA/EUROPE go first so that when a region name
# exists in several countries ('Santa Cruz', 'Cordoba') the same one wins as before.
_PRIORITY = sorted(NORTH_AMERICA) + sorted(EUROPE)
for _cc in _PRIORITY + sorted(ISO_CODES - set(_PRIORITY)):
    for _s in pycountry.subdivisions.get(country_code=_cc) or []:
        _code = _s.code.split("-", 1)[1]
        SUBDIV_BY_NAME.setdefault(norm(_s.name), (_cc, _code))
        if _cc in ABBR_BY_COUNTRY and len(_code) == 2:
            ABBR_BY_COUNTRY[_cc][_code.lower()] = norm(_s.name)

_CITIES: dict[str, list[dict]] = {}
for _c in geonamescache.GeonamesCache().get_cities().values():
    _names = {norm(_c["name"])} | {norm(a) for a in _c.get("alternatenames", []) if a and len(a) > 3}
    for _n in _names:
        if _n:
            _CITIES.setdefault(_n, []).append(_c)


def _best_city(name: str, country: str | None = None, admin1: set[str] | None = None) -> dict | None:
    """Most populous city called `name`; optionally limited to a country and (US) state codes."""
    cands = _CITIES.get(norm(name), [])
    if country:
        cands = [c for c in cands if c["countrycode"] == country]
    if admin1:
        cands = [c for c in cands if c["admin1code"].lower() in admin1] or cands
    return max(cands, key=lambda c: c["population"]) if cands else None


def _city_names(city: dict) -> set[str]:
    names = {norm(city["name"])} | {norm(a) for a in city.get("alternatenames", []) if a and len(a) > 3}
    return {n for n in names if n and _best_city(n) and _best_city(n)["geonameid"] == city["geonameid"]}


# ── data classes ──────────────────────────────────────────────────────────────

@dataclass
class Place:
    country: str | None = None
    text: str = ""                      # normalized haystack of every place token seen
    tokens: list[str] = field(default_factory=list)
    city: dict | None = None            # gazetteer record of the locality (first token), if known

    @property
    def has_info(self) -> bool:
        return bool(self.country or self.text)


@dataclass
class Target:
    scope: str                          # 'country' | 'region' | 'city'
    country: str
    names: set[str]                     # normalized names/codes that count as a match
    label: str
    city: dict | None = None            # gazetteer record when scope == 'city' (for radius matching)


# ── resolution ────────────────────────────────────────────────────────────────

def _explicit_country(toks: list[str]) -> str | None:
    """
    Country named by the tokens themselves (not guessed from the city): a country name, a region
    name ('Texas', 'Bavaria') or a US/CA abbreviation ('TX', 'ON'). toks[0] is the locality.
    """
    # 1. explicit country names / aliases (also 'us', 'uk' when standing alone)
    for t in reversed(toks):
        if t in COUNTRY_BY_NAME and (len(t) > 2 or t in ("us", "uk")):
            return COUNTRY_BY_NAME[t]
    # 2. region names (US states, Canadian provinces, German Länder, UK regions...). With several
    #    tokens the first one is the locality ('Paris' is also a French subdivision, but
    #    'Paris, TX' is Texas), so only later tokens count as regions.
    region_tokens = toks[1:] if len(toks) > 1 else ([] if toks and toks[0] in _CITIES else toks)
    for t in reversed(region_tokens):
        if t in SUBDIV_BY_NAME:
            return SUBDIV_BY_NAME[t][0]
    # 3. 2-letter tokens: US state / Canadian province abbreviation, or a bare ISO code
    first_city = _best_city(toks[0]) if toks else None
    for t in reversed(toks[1:] if len(toks) > 1 else toks):
        if len(t) != 2:
            continue
        if first_city and first_city["countrycode"] == "US" and first_city["admin1code"].lower() == t:
            return "US"
        if t in ABBR_BY_COUNTRY["US"] and not (first_city and first_city["countrycode"].lower() == t):
            return "US"
        if t in ABBR_BY_COUNTRY["CA"]:
            return "CA"
        if len(toks) == 1 and t.upper() in ISO_CODES:
            return t.upper()                    # HQ text that is just a country code, e.g. 'TR'
    return None


def resolve_place(text: str = "", iso_country: str | None = None, extra_tokens: list[str] | None = None) -> Place:
    """
    Interpret comma-separated location text ('Seattle, WA', 'London, Greater London', 'Paris').
    iso_country (from LinkedIn's structured address) is authoritative when given.
    """
    parts = [p.strip() for p in re.split(r"[,;/|]", text or "") if p.strip()] + list(extra_tokens or [])
    toks = [norm(p) for p in parts if norm(p)]
    country = (iso_country or "").upper() or None
    if country and country not in ISO_CODES:
        country = None
    if not country:
        country = _explicit_country(toks)
    if not country and toks:
        # city lookup: most populous match for the first token (the locality)
        city = _best_city(toks[0])
        if city:
            country = city["countrycode"]

    hay = " | ".join(toks)
    # add expanded abbreviations so 'tx' also matches a target named 'texas'
    for t in toks:
        for cc in ("US", "CA"):
            if len(t) == 2 and t in ABBR_BY_COUNTRY[cc]:
                hay += " | " + ABBR_BY_COUNTRY[cc][t]
    locality = _best_city(toks[0], country) if toks else None
    return Place(country=country, text=hay, tokens=toks, city=locality)


def resolve_target(text: str) -> Target | None:
    """
    'Chicago', 'Toronto, Ontario', 'Paris, TX', 'Bavaria', 'Germany' -> Target, or None when the
    text isn't understood. After the first part, extra parts must name a country or region
    ('Springfield, IL', 'London, Canada'); 'Chicago, Toronto' is rejected, not half-read.
    """
    parts = [p.strip() for p in re.split(r"[,;]", text or "") if p.strip()]
    toks = [norm(p) for p in parts if norm(p)]
    if not toks:
        return None
    t, rest = toks[0], toks[1:]

    hint = None
    if rest:
        hint = _explicit_country(toks)
        if hint is None:
            return None
    elif t in COUNTRY_BY_NAME and (len(t) > 2 or t in ("us", "uk")):
        return Target("country", COUNTRY_BY_NAME[t], {t}, text.strip())

    t = REGION_ALIASES.get(t, t)
    us_states = {SUBDIV_BY_NAME[r][1].lower() for r in rest if SUBDIV_BY_NAME.get(r, ("",))[0] == "US"} \
        | {r for r in rest if len(r) == 2 and r in ABBR_BY_COUNTRY["US"]}
    city = _best_city(t, hint, us_states)
    big_city = city if city and city["population"] >= BIG_CITY_POPULATION else None
    if t in SUBDIV_BY_NAME and (hint is None or SUBDIV_BY_NAME[t][0] == hint):
        cc, code = SUBDIV_BY_NAME[t]
        # 'Berlin', 'New York', 'Hamburg' are both a state and a big city in the same country:
        # treat as a city. 'Ontario' is a province; the California city of that name doesn't count.
        if not (big_city and big_city["countrycode"] == cc):
            names = {t, code.lower()} if cc in ABBR_BY_COUNTRY else {t}
            return Target("region", cc, names, text.strip())
    if city:
        return Target("city", city["countrycode"], _city_names(city) | {t}, text.strip(), city)
    return None


def distance_km(a: dict, b: dict) -> float:
    la1, lo1, la2, lo2 = (math.radians(x) for x in (a["latitude"], a["longitude"], b["latitude"], b["longitude"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def matches_ex(place: Place, target: Target, radius_km: float = 0) -> tuple[bool | None, str]:
    """(True/False/None, reason). None = the place has no usable info. With radius_km, a city
    target also accepts a locality within that distance (metro area: Salford for Manchester)."""
    if not place.has_info:
        return None, "no info"
    if place.country and place.country != target.country:
        return False, f"country {place.country}"
    if target.scope == "country":
        return (True, "country") if place.country == target.country else (None, "country unknown")
    if any(re.search(rf"(?<![a-z0-9]){re.escape(n)}(?![a-z0-9])", place.text) for n in target.names):
        return True, "name"
    if radius_km and target.scope == "city" and target.city and place.city \
            and place.city["countrycode"] == target.country:
        d = distance_km(place.city, target.city)
        if d <= radius_km:
            return True, f"metro {d:.0f}km"
    return (False, "other place") if place.text else (None, "no info")


def matches(place: Place, target: Target, radius_km: float = 0) -> bool | None:
    return matches_ex(place, target, radius_km)[0]
