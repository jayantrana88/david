/** The dashboard's reads: the Overview and every list, as JSON (the shapes web/src/lib/types.ts names). */
import { type Req, json, PAGE_SIZE, pageNumber, searchTerm } from "./http";

const TASK_STATUSES = ["pending", "running", "completed", "failed"] as const;
const EMAIL_STATUSES = ["draft", "sending", "sent", "send_failed", "rejected", "generation_failed"] as const;

// ── query building ────────────────────────────────────────────────────────────────

/** A WHERE built condition by condition (all ANDed). Column names come from code, never from input. */
class Where {
  private parts: string[] = [];
  private values: unknown[] = [];

  raw(sql: string, ...values: unknown[]) {
    this.parts.push(sql);
    this.values.push(...values);
    return this;
  }
  eq(col: string, value: unknown) {
    return this.raw(`${col} = ?`, value);
  }
  /** `col IS NULL` for null, else `col = ?`. */
  is(col: string, value: null | boolean) {
    return value === null ? this.raw(`${col} IS NULL`) : this.eq(col, value);
  }
  /** `(col LIKE %term% OR ...)`; nothing for an empty term. */
  search(columns: string[], term: string) {
    if (!term) return this;
    return this.raw(`(${columns.map((c) => `${c} LIKE ?`).join(" OR ")})`, ...columns.map(() => `%${term}%`));
  }
  /** Rows whose `column` falls inside the UTC days `?from=&to=` (inclusive; either end may be open). */
  inRange(range: Range, column = "created_at") {
    if (range.from) this.raw(`${column} >= ?`, `${range.from}T00:00:00.000Z`);
    if (range.to) {
      const next = new Date(`${range.to}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      this.raw(`${column} < ?`, next.toISOString());
    }
    return this;
  }
  get sql(): string {
    return this.parts.length ? `WHERE ${this.parts.join(" AND ")}` : "";
  }
  get params(): unknown[] {
    return this.values;
  }
}

type Range = { from?: string; to?: string };
type Filter = (w: Where) => Where;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: string | null): v is string => !!v && DAY.test(v) && !Number.isNaN(Date.parse(v));

function rangeOf(url: URL): Range {
  let from = validDay(url.searchParams.get("from")) ? url.searchParams.get("from")! : undefined;
  let to = validDay(url.searchParams.get("to")) ? url.searchParams.get("to")! : undefined;
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
}

const todayStart = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
};

async function count(req: Req, table: string, filter: Filter = (w) => w, range: Range = {}): Promise<number> {
  const w = filter(new Where()).inRange(range);
  return (await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} ${w.sql}`, w.params))?.n ?? 0;
}

/** One page of rows plus the total that match, newest first. */
async function list<T>(req: Req, select: string, from: string, w: Where, alias: string): Promise<{ rows: T[]; total: number }> {
  const total = (await req.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${from} ${w.sql}`, w.params))?.n ?? 0;
  const rows = await req.db.all<T>(
    `SELECT ${select} FROM ${from} ${w.sql} ORDER BY ${alias}.created_at DESC, ${alias}.id DESC LIMIT ? OFFSET ?`,
    [...w.params, PAGE_SIZE, (pageNumber(req.url) - 1) * PAGE_SIZE],
  );
  return { rows, total };
}

/** The joined company's two columns, nested as the pages expect (`websites: { name, website_url }`). */
type WithSite = { site_name: string | null; site_url: string | null };
const nestSite = ({ site_name, site_url, ...rest }: WithSite & Record<string, unknown>) => ({
  ...rest,
  websites: site_url === null ? null : { name: site_name, website_url: site_url },
});

const param = (req: Req, name: string, allowed: readonly string[]): string | undefined => {
  const v = req.url.searchParams.get(name) ?? "";
  return allowed.includes(v) ? v : undefined;
};

// ── overview ──────────────────────────────────────────────────────────────────────

const NO_PAGES = "NOT EXISTS (SELECT 1 FROM website_pages p WHERE p.scrape_id = website_scrapes.id)";
const HAS_PAGES = "EXISTS (SELECT 1 FROM website_pages p WHERE p.scrape_id = website_scrapes.id)";
const NO_SCRAPE = "NOT EXISTS (SELECT 1 FROM website_scrapes s WHERE s.website_id = websites.id)";

export async function overview(req: Req): Promise<Response> {
  const range = rangeOf(req.url);
  const dated = Boolean(range.from || range.to);
  const today = todayStart();
  // With a range chosen, every number is "rows created in the range" and the "today" extras are dropped.
  const n = (table: string, filter?: Filter) => count(req, table, filter, range);
  const todayOnly = (table: string, filter: Filter = (w) => w) => (dated ? Promise.resolve(0) : n(table, (w) => filter(w).raw("created_at >= ?", today)));

  const jobs: Record<string, Promise<number>> = {
    websites: n("websites"),
    websitesToday: todayOnly("websites"),
    withEmail: n("websites", (w) => w.raw("email IS NOT NULL AND email <> ''")),
    unscanned: n("websites", (w) => w.raw(NO_SCRAPE)),
    scrapes: n("website_scrapes"),
    scrapesToday: todayOnly("website_scrapes"),
    qualified: n("website_scrapes", (w) => w.eq("is_qualified", 1)),
    qualifiedToday: todayOnly("website_scrapes", (w) => w.eq("is_qualified", 1)),
    rejected: n("website_scrapes", (w) => w.eq("is_qualified", 0)),
    awaitingVerdict: n("website_scrapes", (w) => w.is("is_qualified", null)),
    withPages: n("website_scrapes", (w) => w.eq("is_qualified", 1).raw(HAS_PAGES)),
    awaitingPages: n("website_scrapes", (w) => w.eq("is_qualified", 1).raw(NO_PAGES)),
    pages: n("website_pages"),
    pagesToday: todayOnly("website_pages"),
    failedPages: n("website_pages", (w) => w.raw("content_json IS NULL")),
    emails: n("cold_emails"),
    sentToday: dated ? Promise.resolve(0) : count(req, "cold_emails", (w) => w.eq("status", "sent").raw("sent_at >= ?", today)),
    tasks: n("tasks"),
    ...Object.fromEntries(TASK_STATUSES.map((s) => [`task_${s}`, n("tasks", (w) => w.eq("status", s))])),
    ...Object.fromEntries(EMAIL_STATUSES.map((s) => [`email_${s}`, n("cold_emails", (w) => w.eq("status", s))])),
  };
  const latestOf = async (table: string) =>
    [table, (await req.db.get<{ created_at: string }>(`SELECT created_at FROM ${table} ORDER BY created_at DESC LIMIT 1`))?.created_at ?? null] as const;

  const tw = new Where().inRange(range);
  const ew = new Where().inRange(range, "e.created_at");
  const [values, latest, running, recentTasks, recentEmails, profile, keys, pendingOrRunning, extras] = await Promise.all([
    Promise.all(Object.values(jobs)).then((v) => Object.fromEntries(Object.keys(jobs).map((k, i) => [k, v[i]]))),
    Promise.all(["tasks", "websites", "website_scrapes", "website_pages", "cold_emails"].map(latestOf)).then((p) => Object.fromEntries(p)),
    req.db.get("SELECT id, category, location, leads_saved, candidates, started_at FROM tasks WHERE status = 'running' LIMIT 1"),
    req.db.all(`SELECT id, category, location, status, leads_saved, candidates, created_at, error FROM tasks ${tw.sql} ORDER BY created_at DESC LIMIT 5`, tw.params),
    req.db.all<Record<string, unknown> & { site_name: string | null }>(
      `SELECT e.id, e.email_address, e.subject, e.status, e.sent_at, e.created_at, w.name AS site_name
       FROM cold_emails e LEFT JOIN websites w ON w.id = e.website_id ${ew.sql} ORDER BY e.created_at DESC LIMIT 5`, ew.params),
    req.db.get<{ parse_status: string | null }>("SELECT parse_status FROM candidate_profile WHERE id = 1"),
    req.db.get<{ serper_api_key: string | null }>("SELECT serper_api_key FROM app_secrets WHERE id = 1"),
    req.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('pending', 'running')"),
    req.host.overviewExtras(),
  ]);

  return json({
    n: values,
    latest,
    running: running ?? null,
    recentTasks,
    recentEmails: recentEmails.map(({ site_name, ...rest }) => ({ ...rest, websites: { name: site_name } })),
    stages: extras.stages,
    paused: extras.paused,
    setup: { profile: profile?.parse_status === "done", keys: !!keys?.serper_api_key?.trim(), task: (pendingOrRunning?.n ?? 0) > 0 },
  });
}

// ── tasks ─────────────────────────────────────────────────────────────────────────

const TASK_COLUMNS =
  "id, source, category, location, candidates, metro_radius_km, max_employees, target_role, opportunity_type, status, repeat_daily, leads_saved, error, created_at, started_at, finished_at, updated_at";

export async function tasks(req: Req): Promise<Response> {
  const status = param(req, "status", TASK_STATUSES);
  const w = new Where();
  if (status) w.eq("status", status);
  w.search(["category", "location"], searchTerm(req.url.searchParams.get("q")));
  const [result, counts] = await Promise.all([
    list(req, TASK_COLUMNS, "tasks", w, "tasks"),
    Promise.all(TASK_STATUSES.map((s) => count(req, "tasks", (q) => q.eq("status", s)))),
  ]);
  return json({ ...result, counts });
}

// ── companies ─────────────────────────────────────────────────────────────────────

export async function websites(req: Req): Promise<Response> {
  const range = rangeOf(req.url);
  const email = param(req, "email", ["with", "without"]);
  const w = new Where();
  if (email === "with") w.raw("(w.email IS NOT NULL AND w.email <> '')");
  if (email === "without") w.raw("(w.email IS NULL OR w.email = '')");
  w.search(["w.name", "w.website_url", "w.email", "w.category", "w.location"], searchTerm(req.url.searchParams.get("q")));
  w.inRange(range, "w.created_at");
  const [result, all, withEmail] = await Promise.all([
    list(
      req,
      "w.id, w.name, w.website_url, w.email, w.phone_number, w.category, w.location, w.owner, w.source, w.employee_size, w.industry, w.linkedin_url, w.created_at",
      "websites w",
      w,
      "w",
    ),
    count(req, "websites", (q) => q, range),
    count(req, "websites", (q) => q.raw("email IS NOT NULL AND email <> ''"), range),
  ]);
  return json({ ...result, counts: { all, withEmail } });
}

/** A company's progress through the pipeline, for its expanded row. */
export async function websiteProgress(req: Req, id: string): Promise<Response> {
  const scrapes = await req.db.all<{ id: string }>("SELECT id, is_qualified, summary, created_at FROM website_scrapes WHERE website_id = ?", [id]);
  const withPages = await Promise.all(
    scrapes.map(async (s) => ({
      ...s,
      website_pages: [{ count: (await req.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM website_pages WHERE scrape_id = ?", [s.id]))?.n ?? 0 }],
    })),
  );
  const emails = await req.db.all("SELECT id, status, subject, sent_at FROM cold_emails WHERE website_id = ?", [id]);
  return json({ scrapes: withPages, emails });
}

// ── fit checks ────────────────────────────────────────────────────────────────────

export async function scrapes(req: Req): Promise<Response> {
  const range = rangeOf(req.url);
  const verdict = param(req, "verdict", ["qualified", "rejected", "pending"]);
  const w = new Where();
  if (verdict === "qualified") w.eq("s.is_qualified", 1);
  if (verdict === "rejected") w.eq("s.is_qualified", 0);
  if (verdict === "pending") w.is("s.is_qualified", null);
  w.search(["s.summary", "w.name", "w.website_url"], searchTerm(req.url.searchParams.get("q")));
  w.inRange(range, "s.created_at");
  const [result, counts] = await Promise.all([
    list<WithSite & Record<string, unknown>>(
      req,
      "s.id, s.website_id, s.is_qualified, s.summary, s.created_at, w.name AS site_name, w.website_url AS site_url",
      "website_scrapes s LEFT JOIN websites w ON w.id = s.website_id",
      w,
      "s",
    ),
    Promise.all([1, 0, null].map((v) => count(req, "website_scrapes", (q) => q.is("is_qualified", v === null ? null : v === 1), range))),
  ]);
  return json({ rows: result.rows.map(nestSite), total: result.total, counts });
}

// ── pages ─────────────────────────────────────────────────────────────────────────

export async function pages(req: Req): Promise<Response> {
  const range = rangeOf(req.url);
  const content = param(req, "content", ["read", "failed"]);
  const w = new Where();
  if (content === "read") w.raw("p.content_json IS NOT NULL");
  if (content === "failed") w.raw("p.content_json IS NULL");
  w.search(["p.page_name", "p.page_url", "w.name"], searchTerm(req.url.searchParams.get("q")));
  w.inRange(range, "p.created_at");
  const [result, all, failed] = await Promise.all([
    // content_json is large: list without it, only asking whether each page has any
    list<Record<string, unknown> & WithSite & { scrape_website_id: string | null; has_content: number }>(
      req,
      `p.id, p.scrape_id, p.page_name, p.page_url, p.created_at, (p.content_json IS NOT NULL) AS has_content,
       s.website_id AS scrape_website_id, w.name AS site_name, w.website_url AS site_url`,
      "website_pages p LEFT JOIN website_scrapes s ON s.id = p.scrape_id LEFT JOIN websites w ON w.id = s.website_id",
      w,
      "p",
    ),
    count(req, "website_pages", (q) => q, range),
    count(req, "website_pages", (q) => q.raw("content_json IS NULL"), range),
  ]);
  const rows = result.rows.map(({ scrape_website_id, has_content, site_name, site_url, ...rest }) => ({
    ...rest,
    has_content: Boolean(has_content),
    website_scrapes: scrape_website_id === null ? null : { website_id: scrape_website_id, websites: nestSite({ site_name, site_url }).websites },
  }));
  return json({ rows, total: result.total, counts: { all, failed } });
}

export async function pageContent(req: Req, id: string): Promise<Response> {
  const row = await req.db.get<{ content_json: unknown }>("SELECT content_json FROM website_pages WHERE id = ?", [id]);
  return json({ content: row?.content_json ?? null });
}

// ── applications ──────────────────────────────────────────────────────────────────

export async function emails(req: Req): Promise<Response> {
  const range = rangeOf(req.url);
  const status = param(req, "status", EMAIL_STATUSES);
  const w = new Where();
  if (status) w.eq("e.status", status);
  w.search(["e.email_address", "e.subject", "w.name"], searchTerm(req.url.searchParams.get("q")));
  w.inRange(range, "e.created_at");
  const [result, counts] = await Promise.all([
    list<WithSite & Record<string, unknown>>(
      req,
      "e.id, e.website_id, e.email_address, e.subject, e.body, e.attachment_name, e.delivery, e.status, e.sent_at, e.created_at, w.name AS site_name, w.website_url AS site_url",
      "cold_emails e LEFT JOIN websites w ON w.id = e.website_id",
      w,
      "e",
    ),
    Promise.all(EMAIL_STATUSES.map((s) => count(req, "cold_emails", (q) => q.eq("status", s), range))),
  ]);
  return json({ rows: result.rows.map(nestSite), total: result.total, counts });
}
