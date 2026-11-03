const UNITS: [number, string][] = [
  [86400 * 365, "y"],
  [86400 * 30, "mo"],
  [86400, "d"],
  [3600, "h"],
  [60, "m"],
];

/** "5m ago", "3d ago", "just now". */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(secs)) return "";
  if (Math.abs(secs) < 60) return "just now";
  for (const [size, unit] of UNITS) {
    if (Math.abs(secs) >= size) {
      const n = Math.floor(Math.abs(secs) / size);
      return secs < 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
    }
  }
  return "";
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** "acme.com/about" from "https://www.acme.com/about/". */
export function prettyUrl(url: string | null | undefined): string {
  if (!url) return "";
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((100 * part) / whole) : 0;
}

/** Readable text from the scraper's markdown-ish summaries: no headings, emphasis, links or images. */
export function plainText(md: string | null | undefined): string {
  if (!md) return "";
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*{4,}/g, " · ") // "**A****B**": back-to-back bold items
    .replace(/\*+|`+|~~|__/g, "")
    .replace(/(\s·\s)+/g, " · ")
    .replace(/^\s*·\s*|\s*·\s*$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
