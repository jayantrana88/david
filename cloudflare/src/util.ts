/** Small pure helpers shared by every module (no bindings, no network: the tests import them directly). */

export const utcNow = (now: Date = new Date()): string => now.toISOString();

/** ISO time `secs` from `now`. */
export const isoIn = (secs: number, now: Date = new Date()): string => new Date(now.getTime() + secs * 1000).toISOString();

/** Seconds until the next midnight UTC (when the free-tier daily allowances reset). */
export function secsUntilUtcMidnight(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/** Midnight UTC today, ISO. */
export function todayStartIso(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Canonical form of a website URL, so trivially different spellings of the same site compare equal (the
 * dedupe key): scheme, "www.", query string, fragment, trailing slash and case are ignored; the path is kept.
 * Same as core/http.py::normalize_url.
 */
export function normalizeUrl(url: string | null | undefined): string {
  let u = (url ?? "").trim().toLowerCase();
  u = u.replace(/^[a-z][a-z0-9+.\-]*:\/\//, "");
  u = u.split(/[?#]/, 1)[0];
  if (u.startsWith("www.")) u = u.slice(4);
  return u.replace(/\/+$/, "");
}

/** Lower-case ASCII words: accents dropped, every run of other characters one space (geo.py::norm). */
export function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Python's `" ".join(text.split())`. */
export const squash = (text: string | null | undefined): string => (text ?? "").split(/\s+/).filter(Boolean).join(" ");

export const errorText = (e: unknown): string => (e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : String(e));

/** The words of `text` (Python's `len(text.split())`). */
export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Unique values, first-seen order. */
export const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── bytes ──────────────────────────────────────────────────────────────────────

type B64Native = { fromBase64?: (s: string) => Uint8Array };

export function base64ToBytes(b64: string): Uint8Array {
  const native = (Uint8Array as unknown as B64Native).fromBase64;
  if (native) return native(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** UTF-8 text as base64 (for MIME headers and bodies). */
export const textToBase64 = (text: string): string => bytesToBase64(new TextEncoder().encode(text));

/** URL-safe base64 without padding (OAuth PKCE, signed cookies). */
export const base64url = (bytes: Uint8Array): string => bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A JSON value from text, or `fallback` when it isn't JSON. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Decode the HTML entities scraped text carries (&amp; &#39; &#x2019; &nbsp; ...). */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

/** Visible text of an HTML fragment: tags (and script / style bodies) dropped, entities decoded, whitespace squashed. */
export function htmlToText(html: string): string {
  return squash(
    decodeEntities(
      html
        .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

/** Browser-looking headers for a page we fetch ourselves (core/http.py::browser_headers). */
export function browserHeaders(acceptLanguage = "en-US,en;q=0.9"): Record<string, string> {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Accept-Language": acceptLanguage,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
}
