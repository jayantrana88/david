/** The dashboard's data pages: Overview, Tasks, Companies, Fit checks, Pages, Applications, Logs. */
import { itemKey, type Stage, stageStates, STAGES, wake } from "../core";
import { type Html, action, badge, filters, html, layout, PAGE_SIZE, pager, raw, table, truncate, when } from "./html";
import { flashOf, formText, pageNumber, type Req, redirect, searchTerm } from "./common";
import { tick } from "../runner";

const MAX_TASKS_PER_SUBMIT = 50;

async function count(req: Req, sql: string, params: unknown[] = []): Promise<number> {
  return (await req.db.get<{ n: number }>(sql, params))?.n ?? 0;
}

/** A WHERE built from optional conditions. */
function where(parts: [string, unknown[]][]): { sql: string; params: unknown[] } {
  const used = parts.filter(([s]) => s);
  return { sql: used.length ? `WHERE ${used.map(([s]) => s).join(" AND ")}` : "", params: used.flatMap(([, p]) => p) };
}

const like = (cols: string[], q: string): [string, unknown[]] =>
  q ? [`(${cols.map((c) => `${c} LIKE ?`).join(" OR ")})`, cols.map(() => `%${q}%`)] : ["", []];

// ── overview ──────────────────────────────────────────────────────────────────

export async function overview(req: Req): Promise<Response> {
  const n = (sql: string) => count(req, sql);
  const [companies, withEmail, unscanned, qualified, rejected, awaiting, withPages, emails, drafts, sent, failedEmails, pending, running] = await Promise.all([
    n("SELECT COUNT(*) AS n FROM websites"),
    n("SELECT COUNT(*) AS n FROM websites WHERE email IS NOT NULL AND email <> ''"),
    n("SELECT COUNT(*) AS n FROM websites w WHERE NOT EXISTS (SELECT 1 FROM website_scrapes s WHERE s.website_id = w.id)"),
    n("SELECT COUNT(*) AS n FROM website_scrapes WHERE is_qualified = 1"),
    n("SELECT COUNT(*) AS n FROM website_scrapes WHERE is_qualified = 0"),
    n("SELECT COUNT(*) AS n FROM website_scrapes WHERE is_qualified IS NULL"),
    n("SELECT COUNT(DISTINCT scrape_id) AS n FROM website_pages WHERE content_json IS NOT NULL"),
    n("SELECT COUNT(*) AS n FROM cold_emails"),
    n("SELECT COUNT(*) AS n FROM cold_emails WHERE status = 'draft'"),
    n("SELECT COUNT(*) AS n FROM cold_emails WHERE status = 'sent'"),
    n("SELECT COUNT(*) AS n FROM cold_emails WHERE status IN ('send_failed', 'rejected', 'generation_failed')"),
    n("SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'"),
    req.db.get<{ id: number; category: string; location: string; leads_saved: number; candidates: number; started_at: string }>(
      "SELECT id, category, location, leads_saved, candidates, started_at FROM tasks WHERE status = 'running' LIMIT 1"),
  ]);
  const profile = await req.db.get<{ parse_status: string | null; headline: string | null; parse_error: string | null }>(
    "SELECT parse_status, headline, parse_error FROM candidate_profile WHERE id = 1");
  const settings = await req.db.get<{ email_mode: string | null; email_delivery: string | null; paused: boolean | null }>(
    "SELECT email_mode, email_delivery, paused FROM app_settings WHERE id = 1");
  const states = await stageStates(req.db);
  const nowIso = new Date().toISOString();

  const stat = (label: string, value: number | string, sub?: Html | string) =>
    html`<div class="panel stat"><div class="muted small">${label}</div><div class="n">${value}</div>${sub ? html`<div class="muted small">${sub}</div>` : ""}</div>`;

  const setup: Html[] = [];
  if (!profile || profile.parse_status !== "done") {
    setup.push(html`<li><a href="/profile">Upload your resume</a> on the Profile page${profile?.parse_status === "failed" ? html` (last try failed: ${profile.parse_error})` : ""}.</li>`);
  }
  setup.push(html`<li>Add your <a href="/settings#keys">Serper key</a> (LinkedIn search) and, for real sends, your delivery channel's keys. Jina's key is optional.</li>`);
  if (!pending && !running) setup.push(html`<li><a href="/tasks">Add a task</a>: a kind of company and a place.</li>`);

  const stageRows = STAGES.map((s: Stage) => {
    const st = states[s];
    const state = st.hold_until && st.hold_until > nowIso ? badge("held") : st.idle_until && st.idle_until > nowIso ? badge("idle") : badge("ready");
    return [html`<b>${s}</b>`, state,
      st.hold_until && st.hold_until > nowIso ? html`until ${when(st.hold_until)}: ${st.hold_reason}` : html`<span class="wrap">${st.last_note ?? ""}</span>`,
      when(st.last_run_at),
      html`<div class="row">${action("/run", "Run now", { fields: { stage: s } })}${st.hold_until && st.hold_until > nowIso ? action("/run", "Force", { fields: { stage: s, force: "1" } }) : ""}</div>`];
  });

  const body = html`
${setup.length > 1 || !profile ? html`<div class="panel"><b>Getting started</b><ol>${setup}</ol></div>` : ""}
${settings?.paused ? html`<div class="flash bad">Paused: the scheduled ticks do nothing. Resume on the <a href="/settings">Settings</a> page.</div>` : ""}
<div class="grid">
${stat("Running task", running ? `#${running.id}` : "none", running ? `${running.category} in ${running.location}: ${running.leads_saved}/${running.candidates}` : `${pending} pending`)}
${stat("Companies", companies, `${withEmail} with an address · ${unscanned} not checked yet`)}
${stat("Fit checks", qualified, `qualified · ${rejected} not a fit · ${awaiting} awaiting AI`)}
${stat("Pages read", withPages, "companies with their pages")}
${stat("Applications", emails, `${sent} sent · ${drafts} drafts · ${failedEmails} failed`)}
${stat("Mode", settings?.email_mode === "send" ? "send" : "dry run", `delivery: ${settings?.email_delivery ?? "telegram"}`)}
</div>
<h2>Stages</h2>
<p class="muted small">A cron tick every minute runs one stage a small step (a free Worker gets 10 ms of CPU per run). A stage with nothing to do is looked at again within 10 minutes, or at once when the stage before it writes work.</p>
${table(["Stage", "State", "Last", "Ran", ""], stageRows)}`;
  return layout("Overview", "/", body, flashOf(req.url));
}

export async function runNow(req: Req): Promise<Response> {
  const form = await req.request.formData();
  const stage = formText(form, "stage") as Stage;
  if (!STAGES.includes(stage)) return redirect("/", "Unknown stage", false);
  const result = await tick(req.env, { only: stage, force: form.get("force") === "1" });
  return redirect("/", result);
}

// ── tasks ─────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: number; category: string; location: string; candidates: number; max_employees: number; metro_radius_km: number | null;
  target_role: string | null; opportunity_type: string | null; status: string; repeat_daily: boolean; leads_saved: number;
  error: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}

export async function tasks(req: Req): Promise<Response> {
  const status = req.url.searchParams.get("status") ?? "";
  const q = searchTerm(req.url.searchParams.get("q"));
  const w = where([[["pending", "running", "completed", "failed"].includes(status) ? "status = ?" : "", [status]], like(["category", "location"], q)]);
  const total = await count(req, `SELECT COUNT(*) AS n FROM tasks ${w.sql}`, w.params);
  const rows = await req.db.all<TaskRow>(`SELECT * FROM tasks ${w.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...w.params, PAGE_SIZE, (pageNumber(req.url) - 1) * PAGE_SIZE]);

  const body = html`
<details class="panel" ${total ? "" : raw("open")}><summary><b>New task</b></summary>
<form method="post" action="/tasks">
<div class="cols"><div><label>Kinds of company (one per line)</label><textarea name="categories" required placeholder="software company&#10;design agency"></textarea></div>
<div><label>Places (one per line): a city, "City, State/Country", a region or a country</label><textarea name="locations" required placeholder="Bengaluru&#10;Berlin, Germany"></textarea></div></div>
<div class="cols">
<div><label>Companies to save (each search)</label><input name="candidates" type="number" min="1" max="200" value="10"></div>
<div><label>Largest company size (employees)</label><input name="max_employees" type="number" min="1" max="100000" value="50"></div>
<div><label>Metro radius km (city searches; empty = 30)</label><input name="metro_radius_km" type="number" min="0" step="any"></div>
<div><label>Role to ask about (empty = your profile's)</label><input name="target_role" maxlength="200"></div>
<div><label>Kind of work</label><select name="opportunity_type"><option value="">Your profile's</option><option value="job">Job</option><option value="internship">Internship</option><option value="either">Either</option></select></div>
<div><label><input type="checkbox" name="repeat_daily"> Run again every day</label></div></div>
<p><button class="primary">Add</button> <span class="muted small">Each kind × place is one task; they run one at a time, oldest first.</span></p>
</form></details>
${filters(req.url, "status", [["", "Every status"], ["pending", "Pending"], ["running", "Running"], ["completed", "Completed"], ["failed", "Failed"]], "Search kind or place")}
${table(["#", "Search", "Status", "Saved", "Note", "Created", ""], rows.map((t) => [
    html`${t.id}`,
    html`<b>${t.category}</b><br><span class="muted small">${t.location} · ≤${t.max_employees} people${t.target_role ? ` · ${t.target_role}` : ""}${t.opportunity_type ? ` · ${t.opportunity_type}` : ""}${t.repeat_daily ? " · daily" : ""}</span>`,
    badge(t.status), html`${t.leads_saved}/${t.candidates}`, html`<span class="small wrap">${truncate(t.error, 300)}</span>`, when(t.created_at),
    html`<div class="row">${t.status === "completed" || t.status === "failed" ? action(`/tasks/${t.id}/requeue`, "Re-run") : ""}
${t.status === "running" ? action(`/tasks/${t.id}/stop`, "Stop", { confirm: "Stop this task? Leads it saved stay." }) : ""}
${action(`/tasks/${t.id}/repeat`, t.repeat_daily ? "Don't repeat" : "Repeat daily")}
${t.status !== "running" ? action(`/tasks/${t.id}/delete`, "Delete", { cls: "danger", confirm: "Delete this task? Leads it saved stay." }) : ""}</div>`,
  ]), "No tasks yet. Add one above.")}
${pager(req.url, total)}`;
  return layout("Tasks", "/tasks", body, flashOf(req.url));
}

export async function createTasks(req: Req): Promise<Response> {
  const form = await req.request.formData();
  const lines = (k: string) => formText(form, k, 20000).split(/[\n;]/).map((s) => s.trim()).filter(Boolean);
  const categories = lines("categories");
  const locations = lines("locations");
  if (!categories.length || !locations.length) return redirect("/tasks", "Add at least one kind of company and one place.", false);
  if ([...categories, ...locations].some((v) => v.length > 200)) return redirect("/tasks", "Keep each line under 200 characters.", false);
  if (categories.length * locations.length > MAX_TASKS_PER_SUBMIT) return redirect("/tasks", `That's ${categories.length * locations.length} searches; add at most ${MAX_TASKS_PER_SUBMIT} at a time.`, false);
  const candidates = Number(formText(form, "candidates")) || 10;
  const maxEmployees = Number(formText(form, "max_employees")) || 50;
  const radiusText = formText(form, "metro_radius_km");
  const radius = radiusText === "" ? null : Number(radiusText);
  if (!Number.isInteger(candidates) || candidates < 1 || candidates > 200) return redirect("/tasks", "Companies to save: a whole number from 1 to 200.", false);
  if (!Number.isInteger(maxEmployees) || maxEmployees < 1 || maxEmployees > 100000) return redirect("/tasks", "Largest size: a whole number from 1 to 100000.", false);
  if (radius !== null && (!Number.isFinite(radius) || radius < 0)) return redirect("/tasks", "Metro radius: 0 or more.", false);
  const role = formText(form, "target_role", 200) || null;
  const kind = ["job", "internship", "either"].includes(formText(form, "opportunity_type")) ? formText(form, "opportunity_type") : null;
  const repeat = form.get("repeat_daily") === "on" ? 1 : 0;
  await req.db.batch(categories.flatMap((category) => locations.map((location) => req.db.stmt(
    `INSERT INTO tasks (source, category, location, candidates, max_employees, metro_radius_km, target_role, opportunity_type, repeat_daily)
     VALUES ('linkedin', ?, ?, ?, ?, ?, ?, ?, ?)`, [category, location, candidates, maxEmployees, radius, role, kind, repeat]))));
  await wake(req.db, "sourcing");
  const created = categories.length * locations.length;
  return redirect("/tasks", created === 1 ? "Task added. A tick picks it up within a minute." : `${created} tasks added. They run one at a time, oldest first.`);
}

export async function taskAction(req: Req, id: number, what: string): Promise<Response> {
  const db = req.db;
  if (what === "requeue") {
    const n = await db.run("UPDATE tasks SET status = 'pending', error = NULL, cursor = NULL WHERE id = ? AND status IN ('completed', 'failed')", [id]);
    await wake(db, "sourcing");
    return redirect("/tasks", n ? `Task #${id} is queued again. Leads it already saved are skipped.` : `Task #${id} can't be re-run: only a completed or failed task can.`, n > 0);
  }
  if (what === "stop") {
    const n = await db.run("UPDATE tasks SET status = 'failed', error = 'stopped from the dashboard', finished_at = ? WHERE id = ? AND status = 'running'", [new Date().toISOString(), id]);
    return redirect("/tasks", n ? `Task #${id} stopped.` : `Task #${id} isn't running.`, n > 0);
  }
  if (what === "repeat") {
    const n = await db.run("UPDATE tasks SET repeat_daily = 1 - repeat_daily WHERE id = ?", [id]);
    return redirect("/tasks", n ? `Task #${id}: daily repeat changed.` : `Task #${id} no longer exists.`, n > 0);
  }
  if (what === "delete") {
    const n = await db.run("DELETE FROM tasks WHERE id = ? AND status <> 'running'", [id]);
    return redirect("/tasks", n ? `Task #${id} deleted.` : `Task #${id} is running; stop it first.`, n > 0);
  }
  return redirect("/tasks", "Unknown action", false);
}

// ── companies ─────────────────────────────────────────────────────────────────

export async function websites(req: Req): Promise<Response> {
  const filter = req.url.searchParams.get("filter") ?? "";
  const q = searchTerm(req.url.searchParams.get("q"));
  const w = where([
    [filter === "with_email" ? "w.email IS NOT NULL AND w.email <> ''" : filter === "no_email" ? "(w.email IS NULL OR w.email = '')" : "", []],
    like(["w.name", "w.website_url", "w.email", "w.category", "w.location"], q),
  ]);
  const total = await count(req, `SELECT COUNT(*) AS n FROM websites w ${w.sql}`, w.params);
  const rows = await req.db.all<Record<string, string | null>>(
    `SELECT w.*, (SELECT s.is_qualified FROM website_scrapes s WHERE s.website_id = w.id LIMIT 1) AS fit,
            (SELECT c.status FROM cold_emails c WHERE c.website_id = w.id LIMIT 1) AS email_status
     FROM websites w ${w.sql} ORDER BY w.created_at DESC LIMIT ? OFFSET ?`,
    [...w.params, PAGE_SIZE, (pageNumber(req.url) - 1) * PAGE_SIZE]);
  const body = html`
${filters(req.url, "filter", [["", "Every company"], ["with_email", "With an address"], ["no_email", "No address"]], "Search name, site, address…")}
${table(["Company", "Size / industry", "Address", "Progress", "Added", ""], rows.map((r) => [
    html`<b>${r.name}</b><br><a href="${r.website_url}" target="_blank" rel="noopener noreferrer" class="small">${r.website_url}</a>
${r.linkedin_url ? html` · <a href="${r.linkedin_url}" target="_blank" rel="noopener noreferrer" class="small">LinkedIn</a>` : ""}
<div class="muted small">${r.category} · ${r.location}</div>`,
    html`<span class="small">${r.employee_size}<br>${r.industry}</span>`,
    html`<form method="post" action="/websites/${r.id}/email" class="row"><input name="email" value="${r.email ?? ""}" placeholder="none found" style="min-width:180px"><button>Save</button></form>`,
    html`${r.fit === null || r.fit === undefined ? badge("pending") : badge(r.fit ? "qualified" : "not a fit")} ${r.email_status ? badge(r.email_status) : ""}`,
    when(r.created_at),
    action(`/websites/${r.id}/delete`, "Delete", { cls: "danger", confirm: "Delete this company and its checks, pages and application?" }),
  ]), "No companies yet: they come from your tasks.")}
${pager(req.url, total)}`;
  return layout("Companies", "/websites", body, flashOf(req.url));
}

export async function websiteAction(req: Req, id: string, what: string): Promise<Response> {
  if (what === "delete") {
    await req.db.run("DELETE FROM websites WHERE id = ?", [id]);
    return redirect("/websites", "Company deleted.");
  }
  if (what === "email") {
    const form = await req.request.formData();
    const email = formText(form, "email", 500);
    if (email && !email.split(",").every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))) return redirect("/websites", "Use valid addresses, separated by commas.", false);
    await req.db.run("UPDATE websites SET email = ? WHERE id = ?", [email || null, id]);
    await req.db.run("DELETE FROM backoff WHERE item = ?", [itemKey("email", id)]);
    await wake(req.db, "email");
    return redirect("/websites", "Address saved.");
  }
  return redirect("/websites", "Unknown action", false);
}

// ── fit checks ────────────────────────────────────────────────────────────────

export async function scrapes(req: Req): Promise<Response> {
  const filter = req.url.searchParams.get("filter") ?? "";
  const q = searchTerm(req.url.searchParams.get("q"));
  const w = where([
    [filter === "qualified" ? "s.is_qualified = 1" : filter === "rejected" ? "s.is_qualified = 0" : filter === "pending" ? "s.is_qualified IS NULL" : "", []],
    like(["s.summary", "w.name", "w.website_url"], q),
  ]);
  const from = "website_scrapes s LEFT JOIN websites w ON w.id = s.website_id";
  const total = await count(req, `SELECT COUNT(*) AS n FROM ${from} ${w.sql}`, w.params);
  const rows = await req.db.all<{ id: string; website_id: string; is_qualified: boolean | null; summary: string | null; created_at: string; name: string | null; website_url: string | null }>(
    `SELECT s.id, s.website_id, s.is_qualified, s.summary, s.created_at, w.name, w.website_url FROM ${from} ${w.sql}
     ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, [...w.params, PAGE_SIZE, (pageNumber(req.url) - 1) * PAGE_SIZE]);
  const body = html`
${filters(req.url, "filter", [["", "Every verdict"], ["qualified", "Qualified"], ["rejected", "Not a fit"], ["pending", "Awaiting AI"]], "Search summary or company")}
${table(["Company", "Verdict", "Summary", "Checked", ""], rows.map((s) => [
    html`<b>${s.name}</b><br><a class="small" href="${s.website_url ?? ""}" target="_blank" rel="noopener noreferrer">${s.website_url}</a>`,
    badge(s.is_qualified === null ? "awaiting AI" : s.is_qualified ? "qualified" : "not a fit"),
    html`<span class="small">${s.summary}</span>`, when(s.created_at),
    html`<div class="row">${s.is_qualified !== true ? action(`/scrapes/${s.id}/verdict`, "Qualify", { fields: { v: "1" } }) : ""}
${s.is_qualified !== false ? action(`/scrapes/${s.id}/verdict`, "Not a fit", { fields: { v: "0" } }) : ""}
${action(`/scrapes/${s.id}/verdict`, "Ask AI again", { fields: { v: "" } })}
${action(`/scrapes/${s.id}/delete`, "Read again", { confirm: "Delete this check (and its pages)? The homepage is read again." })}</div>`,
  ]), "No fit checks yet.")}
${pager(req.url, total)}`;
  return layout("Fit checks", "/scrapes", body, flashOf(req.url));
}

export async function scrapeAction(req: Req, id: string, what: string): Promise<Response> {
  const row = await req.db.get<{ website_id: string }>("SELECT website_id FROM website_scrapes WHERE id = ?", [id]);
  if (!row) return redirect("/scrapes", "That check no longer exists.", false);
  if (what === "verdict") {
    const v = formText(await req.request.formData(), "v");
    const verdict = v === "1" ? true : v === "0" ? false : null;
    await req.db.run("UPDATE website_scrapes SET is_qualified = ? WHERE id = ?", [verdict, id]);
    await req.db.run("DELETE FROM backoff WHERE item = ?", [itemKey("scrape", row.website_id)]);
    await wake(req.db, verdict === null ? "scrape" : "internal");
    return redirect("/scrapes", verdict === null ? "The AI judges this company again at the next scrape tick." : `Verdict set to ${verdict ? "qualified" : "not a fit"}.`);
  }
  if (what === "delete") {
    await req.db.run("DELETE FROM website_scrapes WHERE id = ?", [id]);
    await req.db.run("DELETE FROM backoff WHERE item = ?", [itemKey("scrape", row.website_id)]);
    await wake(req.db, "scrape");
    return redirect("/scrapes", "Deleted. The scrape stage reads this website again.");
  }
  return redirect("/scrapes", "Unknown action", false);
}

// ── pages ─────────────────────────────────────────────────────────────────────

export async function pages(req: Req): Promise<Response> {
  const filter = req.url.searchParams.get("filter") ?? "";
  const q = searchTerm(req.url.searchParams.get("q"));
  const w = where([
    [filter === "read" ? "p.content_json IS NOT NULL" : filter === "failed" ? "p.content_json IS NULL" : "", []],
    like(["p.page_name", "p.page_url", "w.name"], q),
  ]);
  const from = "website_pages p LEFT JOIN website_scrapes s ON s.id = p.scrape_id LEFT JOIN websites w ON w.id = s.website_id";
  const total = await count(req, `SELECT COUNT(*) AS n FROM ${from} ${w.sql}`, w.params);
  const rows = await req.db.all<{ id: string; scrape_id: string; page_name: string; page_url: string | null; has_content: number; created_at: string; name: string | null; text: string | null }>(
    `SELECT p.id, p.scrape_id, p.page_name, p.page_url, p.created_at, (p.content_json IS NOT NULL) AS has_content, w.name,
            substr(json_extract(p.content_json, '$.content'), 1, 1500) AS text
     FROM ${from} ${w.sql} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`, [...w.params, PAGE_SIZE, (pageNumber(req.url) - 1) * PAGE_SIZE]);
  const body = html`
${filters(req.url, "filter", [["", "Every page"], ["read", "Read"], ["failed", "Read failed"]], "Search page or company")}
${table(["Company", "Page", "Read", "Added", ""], rows.map((p) => [
    html`<b>${p.name}</b>`,
    html`${p.page_name}<br>${p.page_url?.startsWith("http") ? html`<a class="small" href="${p.page_url}" target="_blank" rel="noopener noreferrer">${p.page_url}</a>` : html`<span class="muted small">${p.page_url}</span>`}
${p.text ? html`<details><summary class="small">Text</summary><pre>${p.text}</pre></details>` : ""}`,
    badge(p.has_content ? "read" : "read failed"), when(p.created_at),
    action("/pages/reread", "Read again", { fields: { scrape_id: p.scrape_id }, confirm: "Delete this company's pages and read them again?" }),
  ]), "No pages read yet.")}
${pager(req.url, total)}`;
  return layout("Pages", "/pages", body, flashOf(req.url));
}

export async function rereadPages(req: Req): Promise<Response> {
  const scrapeId = formText(await req.request.formData(), "scrape_id");
  const n = await req.db.run("DELETE FROM website_pages WHERE scrape_id = ?", [scrapeId]);
  await req.db.run("DELETE FROM backoff WHERE item = ?", [itemKey("internal", scrapeId)]);
  await wake(req.db, "internal");
  return redirect("/pages", `${n} page(s) deleted. The internal stage reads this company's pages again.`);
}

// ── applications ──────────────────────────────────────────────────────────────

const RETRYABLE = ["draft", "rejected", "generation_failed", "send_failed"];

export async function emails(req: Req): Promise<Response> {
  const status = req.url.searchParams.get("status") ?? "";
  const q = searchTerm(req.url.searchParams.get("q"));
  const w = where([
    [["draft", "sending", "sent", "send_failed", "rejected", "generation_failed"].includes(status) ? "e.status = ?" : "", [status]],
    like(["e.email_address", "e.subject", "w.name"], q),
  ]);
  const from = "cold_emails e LEFT JOIN websites w ON w.id = e.website_id";
  const total = await count(req, `SELECT COUNT(*) AS n FROM ${from} ${w.sql}`, w.params);
  const rows = await req.db.all<Record<string, string | null>>(
    `SELECT e.*, w.name, w.website_url FROM ${from} ${w.sql} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
    [...w.params, PAGE_SIZE, (pageNumber(req.url) - 1) * PAGE_SIZE]);
  const body = html`
${filters(req.url, "status", [["", "Every status"], ["draft", "Drafts"], ["sending", "Sending (unknown outcome)"], ["sent", "Sent"], ["send_failed", "Send failed"], ["rejected", "Rejected"], ["generation_failed", "No draft passed"]], "Search address or subject")}
${table(["Company", "Application", "Status", "Written", ""], rows.map((e) => [
    html`<b>${e.name}</b><br><span class="small">${e.email_address}</span>`,
    html`<b>${e.subject ?? ""}</b>${e.body ? html`<details><summary class="small">Body${e.attachment_name ? ` · attached: ${e.attachment_name}` : ""}</summary><pre>${e.body}</pre></details>` : ""}`,
    html`${badge(e.status ?? "")}${e.delivery ? html`<div class="muted small">${e.delivery}</div>` : ""}`,
    html`${when(e.created_at)}${e.sent_at ? html`<div class="small muted">sent ${when(e.sent_at)}</div>` : ""}`,
    RETRYABLE.includes(e.status ?? "") ? action(`/emails/${e.id}/retry`, e.status === "draft" ? "Write again" : "Retry", { confirm: "Delete this row so the email stage writes a new application?" }) : "",
  ]), "No applications yet.")}
${pager(req.url, total)}`;
  return layout("Applications", "/emails", body, flashOf(req.url));
}

export async function retryEmail(req: Req, id: string): Promise<Response> {
  const row = await req.db.get<{ website_id: string }>(
    `DELETE FROM cold_emails WHERE id = ? AND status IN (${RETRYABLE.map(() => "?").join(", ")}) RETURNING website_id`, [id, ...RETRYABLE]);
  if (!row) return redirect("/emails", "This email can't be retried: it was sent, or is being sent.", false);
  await req.db.run("DELETE FROM backoff WHERE item = ?", [itemKey("email", row.website_id)]);
  await wake(req.db, "email");
  return redirect("/emails", "Cleared. The email stage writes this company a new application.");
}

// ── logs ──────────────────────────────────────────────────────────────────────

export async function logs(req: Req): Promise<Response> {
  const stage = req.url.searchParams.get("stage") ?? "";
  const w = where([[stage ? "stage = ?" : "", [stage]]]);
  const rows = await req.db.all<{ at: string; stage: string; level: string; message: string }>(
    `SELECT at, stage, level, message FROM logs ${w.sql} ORDER BY id DESC LIMIT 300`, w.params);
  const body = html`
<form class="row filters" method="get"><select name="stage"><option value="">Every stage</option>
${[...STAGES, "tick"].map((s) => html`<option ${s === stage ? raw("selected") : ""}>${s}</option>`)}</select><button>Filter</button></form>
<p class="muted small">The last 300 lines (kept 3 days). Every line also goes to the Worker's logs in the Cloudflare dashboard.</p>
${table(["When", "Stage", "", "Message"], rows.map((l) => [when(l.at), html`${l.stage}`,
    l.level === "info" ? "" : badge(l.level), html`<span class="small wrap">${l.message}</span>`]), "Nothing logged yet.")}`;
  return layout("Logs", "/logs", body, flashOf(req.url));
}

