/**
 * The LinkedIn lead source's steps (stages/sourcing/linkedin/): a Google search through Serper for
 * `site:linkedin.com/company`, reading one public company page, and the rules a company must pass. The
 * sourcing stage (stages/sourcing.ts) drives them a few companies per tick.
 *
 * Company pages are read through Browser Rendering (a real browser, like the daemon's Chrome) or a plain fetch
 * (Settings → Sourcing). Without a login LinkedIn often answers 999 / an auth wall to datacenter IPs: that is
 * a "block", and the stage backs off.
 */
import { browserHeaders, decodeEntities, htmlToText, norm, sleep } from "../util";
import { type CityLookup, hasInfo, matches, matchesEx, mentions, resolvePlace, type Target } from "./geo";

export const COMPANY_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^/?#]+)/i;
const HIRING_RE = /hiring (?:an? )?(?:new )?[^.]{3,80}? in ([^.]{2,60}?)\.\s*Apply/gi;
const ABOUT_LOC_RE = /\b(?:based|located|headquartered|situated) in ((?:[A-Z][\p{L}\p{N}_'’.\-]*,? ?){1,4})/gu;
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const NON_SITE_DOMAINS = [
  "linkedin.com", "facebook.com", "fb.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "youtu.be", "pinterest.com", "tiktok.com", "wa.me", "whatsapp.com",
  "linktr.ee", "linktree.com", "bit.ly", "tinyurl.com", "goo.gl", "forms.gle",
  "justdial.com", "practo.com", "indiamart.com", "sulekha.com", "yelp.com",
  "google.com", "maps.app.goo.gl", "wikipedia.org", "crunchbase.com",
  "behance.net", "dribbble.com", "medium.com", "wixsite.com", "business.site",
];

export interface Company {
  slug: string;
  linkedin_url: string;
  name: string;
}

export interface CompanyInfo {
  name: string | null;
  website: string | null;
  industry: string | null;
  size: string | null;
  headquarters: string | null;
  country: string | null;
  locality: string | null;
  region: string | null;
  about_places: string[];
  hiring_places: string[];
}

// ── search ────────────────────────────────────────────────────────────────────

export class SearchAuthError extends Error {}

export function cleanName(title: string): string {
  return title.replace(/\s*[|\-–]\s*LinkedIn\s*$/i, "").replace(/\s*\|\s*$/, "").replace(/^[\s|\-–]+|[\s|\-–]+$/g, "");
}

/** One page of Google results for `query` (empty = no more). SearchAuthError when the key is refused. */
export async function serperSearch(apiKey: string, query: string, page: number): Promise<{ title: string; link: string }[]> {
  if (!apiKey) throw new SearchAuthError("the Serper key is not set (Settings → API keys; get one at https://serper.dev)");
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let resp: Response;
    try {
      resp = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, page, num: 10 }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      await sleep(3000 * attempt);
      continue;
    }
    const body = await resp.text();
    if (resp.ok) {
      const data = JSON.parse(body) as { organic?: { title?: string; link?: string }[] };
      return (data.organic ?? []).filter((r) => r && typeof r === "object").map((r) => ({ title: r.title ?? "", link: r.link ?? "" }));
    }
    if ([400, 401, 402, 403].includes(resp.status) && /credit|key|unauthorized/i.test(body)) {
      throw new SearchAuthError(`Serper refused the request (HTTP ${resp.status}): ${body.slice(0, 200)}`);
    }
    lastError = `HTTP ${resp.status}: ${body.slice(0, 200)}`;
    if (!(resp.status === 429 || resp.status >= 500)) break;
    await sleep(5000 * attempt);
  }
  throw new Error(`web search failed (${lastError})`);
}

/** The new company pages in one page of search results (deduped against `seen`, which is extended). */
export function companiesFrom(results: { title: string; link: string }[], seen: Set<string>): Company[] {
  const out: Company[] = [];
  for (const r of results) {
    const m = COMPANY_RE.exec(r.link);
    if (!m) continue;
    const slug = m[1].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, linkedin_url: `https://www.linkedin.com/company/${slug}`, name: cleanName(r.title) || slug });
  }
  return out;
}

// ── one company page ──────────────────────────────────────────────────────────

/** 'Dublin, Ireland. The' -> 'Dublin, Ireland': cut at the end of the sentence ('St.' etc. don't end one). */
export function cleanPlacePhrase(m: string): string {
  const first = (m + " ").split(/(?<!\bSt)(?<!\bMt)(?<!\bFt)\.\s/)[0];
  return first.replace(/[’']s\b/g, "").replace(/^[\s,.]+|[\s,.]+$/g, "");
}

/** JSON-LD `numberOfEmployees` as size-band text ('11-50 employees' / '12 employees'), or null. */
export function jsonldSize(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.minValue !== undefined && v.minValue !== null && v.maxValue !== undefined && v.maxValue !== null) return `${v.minValue}-${v.maxValue} employees`;
    value = v.value ?? v.maxValue ?? v.minValue;
  }
  if (typeof value === "number" && Number.isFinite(value)) return `${Math.trunc(value)} employees`;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/** Read a public company page: JSON-LD Organization plus the About list (Website, Industry, Company size, HQ). */
export function parseCompanyPage(html: string): CompanyInfo {
  const info: CompanyInfo = {
    name: null, website: null, industry: null, size: null, headquarters: null, country: null, locality: null, region: null,
    about_places: [], hiring_places: [],
  };
  const text = htmlToText(html);
  info.hiring_places = [...new Set([...text.matchAll(HIRING_RE)].map((m) => m[1].trim()))].sort();
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const items: unknown[] = Array.isArray(data) ? data : data && typeof data === "object" ? ((data as Record<string, unknown>)["@graph"] as unknown[]) ?? [data] : [];
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      if (!["Organization", "Corporation", "LocalBusiness"].includes(String(o["@type"]))) continue;
      if (o.sameAs) info.website = Array.isArray(o.sameAs) ? String(o.sameAs[0] ?? "") || null : String(o.sameAs);
      info.name = (o.name as string) || info.name;
      if (typeof o.description === "string" && o.description) {
        info.about_places = [...o.description.matchAll(ABOUT_LOC_RE)].map((x) => cleanPlacePhrase(x[1]));
      }
      const addr = o.address;
      if (addr && typeof addr === "object" && !Array.isArray(addr)) {
        const a = addr as Record<string, unknown>;
        info.country = (a.addressCountry as string) ?? null;
        info.locality = (a.addressLocality as string) ?? null;
        info.region = (a.addressRegion as string) ?? null;
      }
      if (!info.size) info.size = jsonldSize(o.numberOfEmployees);
    }
  }
  for (const m of html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>[\s\S]*?<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const label = htmlToText(m[1]).toLowerCase();
    const value = htmlToText(m[2]);
    if (label === "website" && !info.website) info.website = value.split(" External link")[0].trim();
    else if (label === "industry") info.industry = value;
    else if (label === "company size") info.size = value;          // the About list wins over JSON-LD
    else if (label === "headquarters") info.headquarters = value;
  }
  if (info.name) info.name = decodeEntities(info.name);
  return info;
}

export type FetchOutcome = { info: CompanyInfo | null; status: string };

/** Browser Rendering's own limit was hit (the free 10 minutes a day): not LinkedIn's doing. */
export class BrowserQuotaExhausted extends Error {}

/**
 * One company page. status: "200", "404" (the page is gone), or a block / error ("999", "429", "authwall",
 * "empty-page", "error:..."). Throws BrowserQuotaExhausted when Browser Rendering is out of time for today.
 */
export async function fetchCompany(env: Env, transport: "browser" | "fetch", url: string): Promise<FetchOutcome> {
  let status: string, finalUrl: string, html: string;
  try {
    [status, finalUrl, html] = transport === "browser" ? await viaBrowser(env, url) : await viaFetch(url);
  } catch (e) {
    if (e instanceof BrowserQuotaExhausted) throw e;
    return { info: null, status: `error:${e instanceof Error ? e.message.slice(0, 80) : e}` };
  }
  if (/authwall|\/login|\/uas\//.test(finalUrl)) status = "authwall";
  if (status === "200") {
    const info = parseCompanyPage(html);
    if (info.name || info.size || info.headquarters) return { info, status: "200" };
    return { info: null, status: "empty-page" };      // HTTP 200 but no company data: a soft block
  }
  return { info: null, status };
}

async function viaFetch(url: string): Promise<[string, string, string]> {
  const resp = await fetch(url, { headers: { ...browserHeaders(), Referer: "https://www.google.com/" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  return [String(resp.status), resp.url, resp.status === 200 ? await resp.text() : ""];
}

async function viaBrowser(env: Env, url: string): Promise<[string, string, string]> {
  const resp = await env.BROWSER.quickAction("content", {
    url,
    userAgent: browserHeaders()["User-Agent"],
    setExtraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    gotoOptions: { referer: "https://www.google.com/", waitUntil: "domcontentloaded", timeout: 20_000 },
    rejectResourceTypes: ["image", "media", "font", "stylesheet"],
  });
  const body = (await resp.json()) as
    | { success: true; result: string; meta?: { status?: number; finalUrl?: string } }
    | { success: false; errors?: { message: string }[] };
  if (!body.success) {
    const message = body.errors?.map((e) => e.message).join("; ") || `HTTP ${resp.status}`;
    if (resp.status === 429) throw new BrowserQuotaExhausted(`Browser Rendering: ${message}`);
    throw new Error(`browser: ${message}`);
  }
  return [String(body.meta?.status ?? 200), body.meta?.finalUrl ?? url, body.result];
}

// ── the rules ─────────────────────────────────────────────────────────────────

/** '11-50 employees' -> 50, '1 employee' -> 1, '10,001+ employees' -> huge, unknown -> null. */
export function employeeUpperBound(sizeText: string | null | undefined): number | null {
  if (!sizeText) return null;
  const m = /([\d,]+)\s*(?:[-–]\s*([\d,]+)|(\+))?/.exec(sizeText);
  if (!m) return null;
  if (m[2]) return Number(m[2].replace(/,/g, ""));
  if (m[3]) return 1e9;
  return Number(m[1].replace(/,/g, ""));
}

/** A clean `scheme://host[/path]` for whatever LinkedIn lists as a website, or [null, reason]. */
export function normalizeWebsite(raw: string | null | undefined): [string | null, string] {
  let s = (raw ?? "").trim();
  if (!s) return [null, "empty"];
  s = s.split(/\s+/)[0];
  if (s.toLowerCase().includes("linkedin.com/redir/redirect")) {
    let q: string | null = null;
    try {
      q = new URL(s.includes("://") ? s : `https://${s}`).searchParams.get("url");
    } catch { /* bad wrapper */ }
    if (!q) return [null, "bad redirect wrapper"];
    s = q;
  }
  if (/^[a-z][a-z0-9+.\-]*:(?!\/\/)(?!\d)/i.test(s)) return [null, "not a web URL"];
  if (!/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  let p: URL;
  try {
    p = new URL(s);
  } catch {
    return [null, "invalid URL"];
  }
  const scheme = p.protocol.replace(/:$/, "").toLowerCase();
  if (!["http", "https"].includes(scheme)) return [null, `scheme ${scheme}`];
  if (p.username || p.password) return [null, "contains userinfo"];
  const host = p.hostname.toLowerCase().replace(/\.$/, "");
  if (!HOST_RE.test(host)) return [null, `invalid host '${host}'`];
  const root = host.replace(/^www\./, "");
  if (NON_SITE_DOMAINS.some((d) => root === d || root.endsWith("." + d))) return [null, `not a company site (${root})`];
  let path = (p.pathname || "").replace(/\/+/g, "/");
  path = path.replace(/\/(index|home)\.(html?|php|aspx?)$/i, "").replace(/\/+$/, "");
  return [`${scheme}://${host}${path}`, "ok"];
}

/**
 * The compulsory location check: [ok, source, detail]. Evidence, strongest first: LinkedIn's structured
 * address + Headquarters (decides alone); then the About text ('based in X'), accepted when a place matches
 * and none is abroad; then the job posts ('hiring ... in X'), only when every post is in the target; then the
 * company name mentioning the place (city / region targets).
 */
export async function checkLocation(lookup: CityLookup, target: Target, li: CompanyInfo, name: string, radiusKm: number): Promise<[boolean, string, string]> {
  const place = await resolvePlace(lookup, li.headquarters ?? "", li.country, [li.locality ?? "", li.region ?? ""]);
  const [verdict, why] = matchesEx(place, target, radiusKm);
  const detail = `${li.locality ?? ""}|${li.region ?? ""}|${li.country ?? ""} / HQ ${li.headquarters}`;
  if (verdict === true) return [true, "address/HQ", detail + (why.startsWith("metro") ? ` [${why}]` : "")];
  if (verdict === false) return [false, "address/HQ", `${detail} -> country=${place.country}`];

  for (const [source, phrases] of [["about-text", li.about_places], ["job-posts", li.hiring_places]] as const) {
    const places = (await Promise.all(phrases.map((p) => resolvePlace(lookup, p)))).filter(hasInfo);
    if (!places.length) continue;
    const verdicts = places.map((p) => matches(p, target, radiusKm));
    const foreign = places.some((p) => p.country && p.country !== target.country);
    const accepted = source === "job-posts" ? verdicts.every((v) => v === true) : verdicts.some((v) => v === true) && !foreign;
    if (accepted) return [true, source, phrases.slice(0, 3).join("; ")];
    if (foreign && !verdicts.some((v) => v === true)) return [false, source, phrases.slice(0, 3).join("; ")];
  }
  if (target.scope !== "country" && target.names.some((n) => n.length > 2 && mentions(norm(name), n))) return [true, "name", name];
  return [false, "none", "no location info on page"];
}

// ── is the website up? (apis/site_check.py) ───────────────────────────────────

const BLOCKED_STATUSES = new Set([401, 403, 429, 999]);
const PARKED_HOSTS = ["hugedomains.com", "sedo.com", "sedoparking.com", "dan.com", "afternic.com", "godaddy.com", "parkingcrew.net",
  "bodis.com", "above.com", "undeveloped.com", "domainmarket.com", "buydomains.com", "namebright.com", "domainsponsor.com",
  "uniregistry.com", "squadhelp.com", "brandbucket.com", "atom.com", "porkbun.com"];

export interface SiteCheck {
  status: string;
  reachable: boolean;
  code: number | null;
  finalUrl: string | null;
}

const bareHost = (url: string) => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export function classifyStatus(code: number): [string, boolean] {
  if (code < 400) return ["ok", true];
  if (BLOCKED_STATUSES.has(code)) return ["blocked", true];
  if (code === 404 || code === 410) return ["not_found", false];
  if (code >= 500) return ["server_error", false];
  return ["client_error", false];
}

export const isParked = (finalUrl: string | null) => {
  const host = finalUrl ? bareHost(finalUrl) : "";
  return PARKED_HOSTS.some((p) => host === p || host.endsWith("." + p));
};

/**
 * Does the site answer? Only the status line matters (the body is dropped unread). An https site that
 * doesn't answer is tried over http too. Reachable = 2xx / 3xx, or 401 / 403 / 429 / 999 (bot protection:
 * the server is up). A Worker can't tell a DNS failure from a refused connection or a bad certificate: all
 * are "connection_error".
 */
export async function checkSite(url: string, timeoutMs = 10_000, maxMs = 20_000): Promise<SiteCheck> {
  const candidates = url.startsWith("http://") ? [url] : [url, url.replace(/^https:\/\//, "http://")];
  const started = Date.now();
  let result: SiteCheck = { status: "connection_error", reachable: false, code: null, finalUrl: null };
  for (const candidate of candidates) {
    try {
      const resp = await fetch(candidate, { method: "GET", headers: browserHeaders(), redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      await resp.body?.cancel();
      const [status, reachable] = classifyStatus(resp.status);
      result = { status, reachable, code: resp.status, finalUrl: resp.url || candidate };
      if (reachable && isParked(result.finalUrl)) result = { ...result, status: "parked", reachable: false };
      break;
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      result = { status: name === "TimeoutError" || name === "AbortError" ? "timeout" : "connection_error", reachable: false, code: null, finalUrl: null };
    }
  }
  if (result.reachable && Date.now() - started > maxMs) result = { ...result, status: "slow", reachable: false };
  return result;
}

