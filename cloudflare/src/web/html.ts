/**
 * Server-rendered HTML for the dashboard: an escaping `html` template tag, the page layout and a few small
 * components. No framework and no client bundle: a Next.js app doesn't fit a free Worker (3 MB, 10 ms CPU).
 */

export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const render = (v: unknown): string => {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
};

/** Values are escaped unless they are Html (or arrays of it). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

export const raw = (s: string) => new Html(s);

export const NAV: [string, string][] = [
  ["/", "Overview"], ["/tasks", "Tasks"], ["/websites", "Companies"], ["/scrapes", "Fit checks"], ["/pages", "Pages"],
  ["/emails", "Applications"], ["/profile", "Profile"], ["/settings", "Settings"], ["/logs", "Logs"],
];

const CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e3e2dd;--accent:#2f6fde;--accent-text:#fff;
--ok:#1f7a45;--ok-bg:#e3f4ea;--warn:#8a5a00;--warn-bg:#fdf1d6;--bad:#b3261e;--bad-bg:#fbe3e1;--chip:#efeee9;--code:#f1f0ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--panel:#1e1e1c;--text:#ecebe6;--muted:#9c9b94;
--line:#33332f;--accent:#6b9bff;--accent-text:#0d0d0c;--ok:#7dd3a0;--ok-bg:#1d3326;--warn:#f0c46b;--warn-bg:#3a2f15;--bad:#ff9b92;
--bad-bg:#3d1f1c;--chip:#2a2a27;--code:#262623}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}header{background:var(--panel);border-bottom:1px solid var(--line)}
.top{max-width:1200px;margin:0 auto;padding:10px 16px;display:flex;gap:6px 14px;flex-wrap:wrap;align-items:center}
.brand{font-weight:700;margin-right:8px}nav a{color:var(--muted);text-decoration:none;padding:4px 6px;border-radius:6px}
nav a.on{color:var(--text);background:var(--chip)}main{max-width:1200px;margin:0 auto;padding:18px 16px 60px}
h1{font-size:22px;margin:4px 0 14px}h2{font-size:17px;margin:22px 0 10px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.stat .n{font-size:24px;font-weight:650}.muted{color:var(--muted)}.small{font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:13px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}.scroll{overflow-x:auto}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:var(--chip);white-space:nowrap}
.b-ok{background:var(--ok-bg);color:var(--ok)}.b-warn{background:var(--warn-bg);color:var(--warn)}.b-bad{background:var(--bad-bg);color:var(--bad)}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:14px}.flash.ok{background:var(--ok-bg);color:var(--ok)}.flash.bad{background:var(--bad-bg);color:var(--bad)}
form.inline{display:inline}label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input,select,textarea{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:7px 9px;width:100%}
textarea{min-height:90px}input[type=checkbox]{width:auto}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--chip);color:var(--text);border-radius:7px;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}button.danger{color:var(--bad)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 16px}
pre{background:var(--code);padding:10px;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:13px;max-height:420px;overflow:auto}
details summary{cursor:pointer}.pager{margin-top:12px}.filters{margin-bottom:12px}.filters input{max-width:260px}
.filters select{width:auto}td .row{flex-wrap:nowrap}.wrap{word-break:break-word}`;

export function layout(title: string, path: string, body: Html, flash?: { ok: boolean; msg: string } | null): Response {
  const nav = NAV.map(([href, label]) => html`<a href="${href}" class="${(href === "/" ? path === "/" : path.startsWith(href)) ? "on" : ""}">${label}</a>`);
  const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Job applier</title><style>${raw(CSS)}</style></head><body>
<header><div class="top"><span class="brand">Job applier</span><nav class="row">${nav}</nav>
<form method="post" action="/logout" class="inline" style="margin-left:auto"><button>Sign out</button></form></div></header>
<main>${flash ? html`<div class="flash ${flash.ok ? "ok" : "bad"}">${flash.msg}</div>` : ""}<h1>${title}</h1>${body}</main></body></html>`;
  return new Response(page.value, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" } });
}

export function bare(title: string, body: Html, status = 200): Response {
  const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${raw(CSS)}</style></head><body><main style="max-width:440px;padding-top:12vh">${body}</main></body></html>`;
  return new Response(page.value, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } });
}

// ── components ────────────────────────────────────────────────────────────────

const TONE: Record<string, string> = {
  completed: "ok", sent: "ok", done: "ok", qualified: "ok", read: "ok", ready: "ok",
  running: "warn", pending: "warn", draft: "warn", sending: "warn", "awaiting AI": "warn", held: "warn", idle: "",
  warning: "warn", error: "bad", failed: "bad", send_failed: "bad", rejected: "bad", generation_failed: "bad", "not a fit": "bad", "read failed": "bad",
};
export const badge = (label: string) => html`<span class="badge ${TONE[label] ? `b-${TONE[label]}` : ""}">${label.replace(/_/g, " ")}</span>`;

export function when(iso: string | null | undefined): Html {
  if (!iso) return html`<span class="muted">–</span>`;
  const d = new Date(iso);
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  const abs = Math.abs(secs);
  const rel = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return html`<span title="${iso}">${secs >= 0 ? `${rel} ago` : `in ${rel}`}</span>`;
}

/** A POST button (with an optional confirm prompt). */
export function action(href: string, label: string, opts: { fields?: Record<string, string>; confirm?: string; cls?: string } = {}): Html {
  const hidden = Object.entries(opts.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  const onsubmit = opts.confirm ? raw(` onsubmit="return confirm(${esc(JSON.stringify(opts.confirm))})"`) : "";
  return html`<form method="post" action="${href}" class="inline"${onsubmit}>${hidden}<button class="${opts.cls ?? ""}">${label}</button></form>`;
}

export function table(headers: string[], rows: (Html | string)[][], empty = "Nothing here yet."): Html {
  if (!rows.length) return html`<div class="panel muted">${empty}</div>`;
  return html`<div class="scroll"><table><thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
<tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
}

export const PAGE_SIZE = 25;

export function pager(url: URL, total: number): Html {
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) => {
    const u = new URL(url);
    u.searchParams.set("page", String(p));
    return u.pathname + u.search;
  };
  return html`<div class="row pager muted small">${page > 1 ? html`<a class="btn" href="${link(page - 1)}">← Newer</a>` : ""}
<span>Page ${page} of ${pages} · ${total} total</span>${page < pages ? html`<a class="btn" href="${link(page + 1)}">Older →</a>` : ""}</div>`;
}

/** A filter bar: a select of `options` (named `name`) and a search box, submitted as GET. */
export function filters(url: URL, name: string, options: [string, string][], placeholder = "Search"): Html {
  const current = url.searchParams.get(name) ?? "";
  return html`<form class="row filters" method="get">
<select name="${name}">${options.map(([v, l]) => html`<option value="${v}" ${v === current ? raw("selected") : ""}>${l}</option>`)}</select>
<input name="q" value="${url.searchParams.get("q") ?? ""}" placeholder="${placeholder}"><button>Filter</button></form>`;
}

export const truncate = (s: string | null | undefined, n: number) => {
  const t = s ?? "";
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
