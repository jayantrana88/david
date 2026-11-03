/**
 * Jina AI Reader: a readable rendering of a URL (apis/jina.py), and the pure parsing of its reply
 * (apis/jina_parsing.py, apis/link_selection.py). The key is optional here: without one Jina allows about 20
 * reads a minute, which a tick stays under.
 */
import { normalizeUrl, sleep } from "./util";

const READER_URL = "https://r.jina.ai/https://";

export interface JinaData {
  title?: string;
  description?: string;
  url?: string;
  content?: string;
  links?: unknown;
  usage?: { tokens?: number };
}
export interface JinaReply {
  code?: number;
  data?: JinaData;
}

/** Jina's JSON for `url`, or null when it couldn't be read (429 / 5xx / timeouts are tried twice). */
export async function jinaRead(url: string, apiKey: string, log?: (m: string) => void): Promise<JinaReply | null> {
  const clean = url.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Remove-Selector": "header, .class, #id",
    "X-Retain-Images": "none",
    "X-With-Links-Summary": "all",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(READER_URL + clean, { headers, signal: AbortSignal.timeout(45_000) });
      if (resp.ok) return (await resp.json()) as JinaReply;
      log?.(`jina HTTP ${resp.status}: ${url}`);
      if (!(resp.status === 429 || resp.status >= 500) || attempt === 2) return null;
      await sleep(resp.status === 429 ? 8000 : 3000);
    } catch (e) {
      log?.(`jina error: ${url}: ${e instanceof Error ? e.message : e}`);
      if (attempt === 2) return null;
      await sleep(3000);
    }
  }
  return null;
}

// ── parsing ───────────────────────────────────────────────────────────────────

/** Every markdown link [text](url) in `content`: {text: url}. */
export function extractMarkdownLinks(content: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of (content ?? "").matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)) out[m[1].trim()] = m[2].trim();
  return out;
}

/** A Jina `data` block as compact plain text for the AI: title, description, content (links reduced to their text). */
export function pageText(data: JinaData, limit: number): string {
  const parts = [data.title, data.description, (data.content ?? "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")];
  return parts.filter(Boolean).map((p) => String(p).split(/\s+/).filter(Boolean).join(" ")).join(" ").slice(0, limit);
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}/g;
const FILE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "css", "js", "woff", "woff2"]);

function* strings(obj: unknown): Generator<string> {
  if (typeof obj === "string") yield obj;
  else if (Array.isArray(obj)) for (const item of obj) yield* strings(item);
  else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      yield k;
      yield* strings(v);
    }
  }
}

/** Unique, lower-cased addresses, first-seen order, from any mix of strings and JSON-like structures. */
export function extractEmails(...sources: unknown[]): string[] {
  const seen = new Set<string>();
  for (const source of sources) {
    for (let text of strings(source)) {
      text = text.replaceAll("%40", "@").replaceAll("%20", " ");
      for (const m of text.matchAll(EMAIL_RE)) {
        const email = m[0].toLowerCase().replace(/^\.+|\.+$/g, "");
        if (!FILE_EXTS.has(email.slice(email.lastIndexOf(".") + 1))) seen.add(email);
      }
    }
  }
  return [...seen];
}

/** What the scrape stage keeps of a homepage read. */
export function parseJinaResponse(reply: JinaReply, baseUrl: string, maxMainLinks = 5) {
  const data = reply.data ?? {};
  const links = data.links ?? null;
  const content = data.content ?? "";
  const mainLinks = selectMainLinks([links, extractMarkdownLinks(content)], [baseUrl, data.url ?? ""], maxMainLinks);
  const emails = extractEmails(links, content, (data.description ?? "").trim(), data.title);
  return { data, mainLinks: Object.keys(mainLinks).length ? mainLinks : null, emails };
}

// ── main internal pages (apis/link_selection.py) ──────────────────────────────

const NOISE_SEGMENTS = ["privacy", "terms", "tos", "legal", "cookie", "cookies", "login", "signup", "register", "signin",
  "sign-in", "sign-up", "logout", "cart", "checkout", "account", "dashboard", "thank-you", "thankyou", "404"];
const NOISE_FILE_EXTENSIONS = ["pdf", "zip", "jpg", "jpeg", "png", "gif", "svg", "ico", "css", "js", "xml", "json"];
const PAGE_TYPE_KEYWORDS: Record<string, string[]> = {
  about: ["about", "team", "story", "company", "who-we-are", "our-story"],
  services: ["services", "service", "what-we-do", "solutions", "products", "product", "features"],
  pricing: ["pricing", "plans", "buy", "subscribe"],
  contact: ["contact", "get-in-touch", "reach-us"],
  blog_index: ["blog", "articles", "insights", "resources", "news"],
  case_studies: ["case-studies", "case-study", "portfolio", "work", "clients"],
  faq: ["faq", "help", "support", "questions"],
};
const PRIORITY_ORDER = ["about", "services", "pricing", "case_studies", "blog_index", "faq", "contact", "blog_post", "other"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOISE_RE = new RegExp(
  `(?:^|/)(?:${NOISE_SEGMENTS.map(esc).join("|")})(?![a-z0-9])|\\.(?:${NOISE_FILE_EXTENSIONS.join("|")})$`, "i");
const TYPE_RES = Object.entries(PAGE_TYPE_KEYWORDS).map(
  ([type, words]) => [type, new RegExp(`(?<![a-z0-9])(?:${words.map(esc).join("|")})(?![a-z0-9])`)] as const);
const MAX_NAME_CHARS = 100;

const withScheme = (url: string) => (url.includes("://") ? url : `https://${url}`);

function host(url: string): string {
  try {
    return new URL(withScheme(url.trim())).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pairs(links: unknown): [string, string][] {
  if (Array.isArray(links)) {
    return links.filter((i) => Array.isArray(i) && i.length >= 2).map((i) => [String(i[0] ?? ""), String(i[1] ?? "")]);
  }
  if (links && typeof links === "object") return Object.entries(links).map(([t, u]) => [t, String(u ?? "")]);
  return [];
}

/** The page type of a URL path (a key of PAGE_TYPE_KEYWORDS, `blog_post` or `other`). */
export function classifyPath(path: string): string {
  const segments = path.toLowerCase().split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    for (const [type, re] of TYPE_RES) {
      if (re.test(segments[i])) return type === "blog_index" && segments.length > i + 1 ? "blog_post" : type;
    }
  }
  return "other";
}

/** Up to `limit` main internal pages from the homepage's links: {link text: url}, best page first. */
export function selectMainLinks(linkSources: unknown[], baseUrls: string[], limit = 5): Record<string, string> {
  const bases = baseUrls.filter((u) => u && u.trim());
  if (!bases.length || limit < 1) return {};
  const hosts = new Set(bases.map(host));
  const resolveAgainst = withScheme(bases[0].trim());

  const candidates = new Map<string, [text: string, clean: string, type: string]>();
  for (const source of linkSources) {
    for (const [text, rawHref] of pairs(source)) {
      const href = rawHref.trim();
      if (!href) continue;
      let parsed: URL;
      try {
        parsed = new URL(href, resolveAgainst);
      } catch {
        continue;
      }
      if (!["http:", "https:"].includes(parsed.protocol) || !hosts.has(parsed.host.toLowerCase().replace(/^www\./, ""))) continue;
      const path = parsed.pathname;
      if (!path.replace(/^\/+|\/+$/g, "") || NOISE_RE.test(path)) continue;
      const clean = `${parsed.protocol}//${parsed.host}${path}`.replace(/\/+$/, "");
      const key = normalizeUrl(clean);
      if (!candidates.has(key)) candidates.set(key, [text, clean, classifyPath(path)]);
    }
  }

  const byType = new Map<string, [string, string][]>();
  for (const [text, clean, type] of candidates.values()) {
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push([text, clean]);
  }
  for (const pages of byType.values()) pages.sort((a, b) => a[1].length - b[1].length);
  const rank = (t: string) => (PRIORITY_ORDER.includes(t) ? PRIORITY_ORDER.indexOf(t) : PRIORITY_ORDER.length);
  const orderedTypes = [...byType.keys()].sort((a, b) => rank(a) - rank(b));

  const picks: Record<string, string> = {};
  const rounds = Math.max(0, ...[...byType.values()].map((p) => p.length));
  for (let round = 0; round < rounds; round++) {
    for (const type of orderedTypes) {
      const pages = byType.get(type)!;
      if (round < pages.length) {
        const [text, url] = pages[round];
        const name = text.split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_NAME_CHARS);
        picks[name && !(name in picks) ? name : url] = url;
        if (Object.keys(picks).length >= limit) return picks;
      }
    }
  }
  return picks;
}
