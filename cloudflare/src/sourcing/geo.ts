/**
 * Place matching for worldwide targeting: a port of stages/sourcing/linkedin/geo.py.
 *
 *   resolveTarget(text)  -> Target   what the user asked for (city / region / country)
 *   resolvePlace(text)   -> Place    what a company's location text says
 *   matchesEx(place, target, radiusKm) -> [true / false / null, reason]   (null = no usable information)
 *
 * Countries and subdivisions come from pycountry (geo-data.ts, generated). Cities are not bundled (the
 * daemon's geonamescache is too big for a Worker): they come from Open-Meteo's free geocoding API, which is
 * built on the same GeoNames data, through a `CityLookup` (cached in D1 by the sourcing stage).
 */
import { escapeRegex, norm } from "../util";
import { COUNTRIES, ISO_CODES as ISO_TEXT, SUBDIVISIONS } from "./geo-data";

const NORTH_AMERICA = ["US", "CA"];
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "US", us: "US", "u s": "US", "u s a": "US", america: "US", "united states of america": "US",
  uk: "GB", "u k": "GB", "great britain": "GB", britain: "GB", england: "GB", scotland: "GB",
  wales: "GB", "northern ireland": "GB",
  holland: "NL", "the netherlands": "NL", czechia: "CZ", "czech republic": "CZ",
  deutschland: "DE", espana: "ES", italia: "IT", schweiz: "CH", suisse: "CH",
  osterreich: "AT", belgique: "BE", belgie: "BE", sverige: "SE", danmark: "DK",
};
const REGION_ALIASES: Record<string, string> = {
  bavaria: "bayern", "north rhine westphalia": "nordrhein westfalen", "lower saxony": "niedersachsen",
  saxony: "sachsen", hesse: "hessen", thuringia: "thuringen", "north holland": "noord holland",
  "south holland": "zuid holland", catalonia: "catalunya", andalusia: "andalucia",
  lombardy: "lombardia", tuscany: "toscana", piedmont: "piemonte", sicily: "sicilia",
  brittany: "bretagne", normandy: "normandie", flanders: "vlaanderen",
};
export const BIG_CITY_POPULATION = 100_000;

// ── gazetteer (built on first use) ────────────────────────────────────────────

let tables: {
  iso: Set<string>;
  countryByName: Map<string, string>;
  subdivByName: Map<string, [string, string]>;
  abbr: Record<string, Map<string, string>>;
} | null = null;

function gazetteer() {
  if (tables) return tables;
  const countryByName = new Map(Object.entries(COUNTRY_ALIASES));
  for (const line of COUNTRIES.split("\n")) {
    const [name, cc] = line.split("|");
    if (!countryByName.has(name)) countryByName.set(name, cc);
  }
  const subdivByName = new Map<string, [string, string]>();
  const abbr: Record<string, Map<string, string>> = { US: new Map(), CA: new Map() };
  for (const line of SUBDIVISIONS.split("\n")) {
    const [name, cc, code] = line.split("|");
    if (!subdivByName.has(name)) subdivByName.set(name, [cc, code]);
    if (NORTH_AMERICA.includes(cc) && code.length === 2) abbr[cc].set(code.toLowerCase(), name);
  }
  tables = { iso: new Set(ISO_TEXT.split(" ")), countryByName, subdivByName, abbr };
  return tables;
}

// ── cities ────────────────────────────────────────────────────────────────────

export interface City {
  id: number;
  name: string;
  country: string;       // ISO alpha-2
  admin1: string;        // first-level region name ("Texas")
  lat: number;
  lon: number;
  population: number;
}

/** Every city called `name` the lookup knows (optionally only in `country`), any order. */
export type CityLookup = (name: string, country?: string) => Promise<City[]>;

/** The most populous city called `name`; optionally limited to a country and (US) state codes. */
export async function bestCity(lookup: CityLookup, name: string, country?: string | null, admin1?: Set<string>): Promise<City | null> {
  let cands = await lookup(name, country ?? undefined);
  if (country) cands = cands.filter((c) => c.country === country);
  if (admin1?.size) {
    const inState = cands.filter((c) => admin1.has(admin1Code(c)));
    if (inState.length) cands = inState;
  }
  return cands.reduce<City | null>((best, c) => (!best || c.population > best.population ? c : best), null);
}

/** A city's first-level region as a lower-case code ("tx"), where the gazetteer has one. */
function admin1Code(city: City): string {
  const sub = gazetteer().subdivByName.get(norm(city.admin1));
  return sub && sub[0] === city.country ? sub[1].toLowerCase() : "";
}

// ── data classes ──────────────────────────────────────────────────────────────

export interface Place {
  country: string | null;
  text: string;          // normalized haystack of every place token seen
  tokens: string[];
  city: City | null;     // the locality (first token), if known
}
export const hasInfo = (p: Place) => Boolean(p.country || p.text);

export interface Target {
  scope: "country" | "region" | "city";
  country: string;
  names: string[];
  label: string;
  city: City | null;
}

// ── resolution ────────────────────────────────────────────────────────────────

/** The country the tokens name themselves (not guessed from a city): a country, a region or a US/CA code. */
async function explicitCountry(lookup: CityLookup, toks: string[]): Promise<string | null> {
  const g = gazetteer();
  for (const t of [...toks].reverse()) {
    if (g.countryByName.has(t) && (t.length > 2 || t === "us" || t === "uk")) return g.countryByName.get(t)!;
  }
  let regionTokens: string[];
  if (toks.length > 1) regionTokens = toks.slice(1);
  else regionTokens = toks.length && (await bestCity(lookup, toks[0])) ? [] : toks;
  for (const t of [...regionTokens].reverse()) {
    if (g.subdivByName.has(t)) return g.subdivByName.get(t)![0];
  }
  const firstCity = toks.length ? await bestCity(lookup, toks[0]) : null;
  for (const t of [...(toks.length > 1 ? toks.slice(1) : toks)].reverse()) {
    if (t.length !== 2) continue;
    if (firstCity && firstCity.country === "US" && admin1Code(firstCity) === t) return "US";
    if (g.abbr.US.has(t) && !(firstCity && firstCity.country.toLowerCase() === t)) return "US";
    if (g.abbr.CA.has(t)) return "CA";
    if (toks.length === 1 && g.iso.has(t.toUpperCase())) return t.toUpperCase();
  }
  return null;
}

/** Comma-separated location text ('Seattle, WA'); `isoCountry` (LinkedIn's structured address) wins when given. */
export async function resolvePlace(lookup: CityLookup, text = "", isoCountry?: string | null, extraTokens: string[] = []): Promise<Place> {
  const g = gazetteer();
  const parts = [...(text || "").split(/[,;/|]/).map((p) => p.trim()).filter(Boolean), ...extraTokens];
  const toks = parts.map(norm).filter(Boolean);
  let country: string | null = (isoCountry ?? "").toUpperCase() || null;
  if (country && !g.iso.has(country)) country = null;
  if (!country) country = await explicitCountry(lookup, toks);
  if (!country && toks.length) {
    const city = await bestCity(lookup, toks[0]);
    if (city) country = city.country;
  }
  let hay = toks.join(" | ");
  for (const t of toks) {
    for (const cc of NORTH_AMERICA) if (t.length === 2 && g.abbr[cc].has(t)) hay += " | " + g.abbr[cc].get(t);
  }
  const locality = toks.length ? await bestCity(lookup, toks[0], country) : null;
  return { country, text: hay, tokens: toks, city: locality };
}

/** 'Chicago', 'Toronto, Ontario', 'Paris, TX', 'Bavaria', 'Germany' -> Target, or null when not understood. */
export async function resolveTarget(lookup: CityLookup, text: string): Promise<Target | null> {
  const g = gazetteer();
  const label = (text || "").trim();
  const toks = (text || "").split(/[,;]/).map((p) => norm(p.trim())).filter(Boolean);
  if (!toks.length) return null;
  let t = toks[0];
  const rest = toks.slice(1);

  let hint: string | null = null;
  if (rest.length) {
    hint = await explicitCountry(lookup, toks);
    if (hint === null) return null;
  } else if (g.countryByName.has(t) && (t.length > 2 || t === "us" || t === "uk")) {
    return { scope: "country", country: g.countryByName.get(t)!, names: [t], label, city: null };
  }

  t = REGION_ALIASES[t] ?? t;
  const usStates = new Set<string>([
    ...rest.filter((r) => g.subdivByName.get(r)?.[0] === "US").map((r) => g.subdivByName.get(r)![1].toLowerCase()),
    ...rest.filter((r) => r.length === 2 && g.abbr.US.has(r)),
  ]);
  const city = await bestCity(lookup, t, hint, usStates);
  const bigCity = city && city.population >= BIG_CITY_POPULATION ? city : null;
  const sub = g.subdivByName.get(t);
  if (sub && (hint === null || sub[0] === hint)) {
    const [cc, code] = sub;
    // 'Berlin', 'New York', 'Hamburg' are both a state and a big city: a city. 'Ontario' is a province.
    if (!(bigCity && bigCity.country === cc)) {
      return { scope: "region", country: cc, names: cc in g.abbr ? [t, code.toLowerCase()] : [t], label, city: null };
    }
  }
  if (city) return { scope: "city", country: city.country, names: [...new Set([norm(city.name), t])], label, city };
  return null;
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const [la1, lo1, la2, lo2] = [rad(a.lat), rad(a.lon), rad(b.lat), rad(b.lon)];
  const h = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export const mentions = (hay: string, name: string) => new RegExp(`(?<![a-z0-9])${escapeRegex(name)}(?![a-z0-9])`).test(hay);

/** [true/false/null, reason]. With radiusKm, a city target also accepts a locality that close (a metro area). */
export function matchesEx(place: Place, target: Target, radiusKm = 0): [boolean | null, string] {
  if (!hasInfo(place)) return [null, "no info"];
  if (place.country && place.country !== target.country) return [false, `country ${place.country}`];
  if (target.scope === "country") return place.country === target.country ? [true, "country"] : [null, "country unknown"];
  if (target.names.some((n) => mentions(place.text, n))) return [true, "name"];
  if (radiusKm && target.scope === "city" && target.city && place.city && place.city.country === target.country) {
    const d = distanceKm(place.city, target.city);
    if (d <= radiusKm) return [true, `metro ${Math.round(d)}km`];
  }
  return place.text ? [false, "other place"] : [null, "no info"];
}

export const matches = (place: Place, target: Target, radiusKm = 0) => matchesEx(place, target, radiusKm)[0];

// ── Open-Meteo ────────────────────────────────────────────────────────────────

interface OpenMeteoResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  feature_code?: string;
  country_code?: string;
  admin1?: string;
  population?: number;
}

/**
 * The cities in an Open-Meteo answer that are called `name`: the ones whose (English) name is the query, or,
 * when none is, a populated place the API matched through one of its other names ("Bangalore" -> Bengaluru),
 * never a mere prefix match ("Mumba" -> Mumbai).
 */
export function citiesFrom(name: string, results: OpenMeteoResult[]): City[] {
  const q = norm(name);
  const places = results.filter((r) => (r.feature_code ?? "PPL").startsWith("PPL") && r.country_code);
  const toCity = (r: OpenMeteoResult): City => ({
    id: r.id, name: r.name, country: r.country_code!.toUpperCase(), admin1: r.admin1 ?? "",
    lat: r.latitude, lon: r.longitude, population: r.population ?? 0,
  });
  const exact = places.filter((r) => norm(r.name) === q);
  if (exact.length) return exact.map(toCity);
  return places.filter((r) => q.length > 3 && !norm(r.name).startsWith(q) && (r.population ?? 0) >= 15_000).map(toCity);
}

export async function openMeteoSearch(name: string, country?: string): Promise<OpenMeteoResult[]> {
  const params = new URLSearchParams({ name, count: "20", language: "en", format: "json" });
  if (country) params.set("countryCode", country);
  const resp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`geocoding HTTP ${resp.status}`);
  const body = (await resp.json()) as { results?: OpenMeteoResult[] };
  return body.results ?? [];
}
