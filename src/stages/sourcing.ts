/**
 * Sourcing stage (stages/sourcing/): the user's `tasks` -> `websites`, through the LinkedIn source.
 *
 * One task at a time, oldest first: claim it (`pending` -> `running`), then each tick reads a few company
 * pages (Settings → Sourcing) and saves the leads that pass, until `candidates` are saved or the search runs
 * out (`completed`, a shortfall noted in `error`), or it can't go on (`failed` + `error`). Where the search
 * got to is in `tasks.cursor` (the daemon keeps it in memory: one run is one call there), so a Worker tick can
 * stop anywhere. `leads_saved` is a progress counter only. No auto-retry: the user re-queues a task, and a
 * `repeat_daily` task is queued again 24 h after it finished.
 *
 * LinkedIn refusing pages holds the stage (the company is retried once); three refusals in a row fail the
 * task, as the daemon's run aborts. Browser Rendering's daily allowance running out holds it until midnight.
 */
import { type Ctx, idle, type StageResult, StageHold, wake } from "../core";
import { type Db, insertSql } from "../db";
import { type City, citiesFrom, type CityLookup, openMeteoSearch, resolveTarget, type Target } from "../sourcing/geo";
import {
  BrowserQuotaExhausted, checkLocation, checkSite, type Company, type CompanyInfo, companiesFrom, employeeUpperBound,
  fetchCompany, normalizeWebsite, SearchAuthError, serperSearch,
} from "../sourcing/linkedin";
import { errorText, isoIn, normalizeUrl, secsUntilUtcMidnight, utcNow } from "../util";

export const MAX_SEARCH_PAGES = 10;
const MAX_EMPTY_SEARCH_PAGES = 2;
const MAX_FETCHES_PER_RUN = 300;
const MAX_CONSECUTIVE_BLOCKS = 3;
const BLOCK_HOLD_SECS = 20 * 60;
const DEFAULT_METRO_RADIUS_KM = 30;
const REPEAT_EVERY_SECS = 24 * 3600;

interface Task {
  id: number;
  category: string;
  location: string;
  candidates: number;
  metro_radius_km: number | null;
  max_employees: number;
  target_role: string | null;
  opportunity_type: string | null;
  leads_saved: number;
  cursor: Cursor | null;
}

interface Cursor {
  target: Target | null;
  page: number;                   // Google result pages read
  queue: (Company & { retried?: boolean })[];
  seen: string[];                 // company slugs already queued
  emptyPages: number;
  ended: string;                  // why the search stopped giving companies ("" = more pages may follow)
  saved: number;                  // leads this run saved
  checked: number;
  fetches: number;
  blocks: number;                 // refused pages in a row
  rejects: Record<string, number>;
}

const freshCursor = (): Cursor => ({ target: null, page: 0, queue: [], seen: [], emptyPages: 0, ended: "", saved: 0, checked: 0, fetches: 0, blocks: 0, rejects: {} });

class TaskFailed extends Error {}

export async function runSourcing(ctx: Ctx): Promise<StageResult> {
  const { db } = ctx;
  const requeued = await db.run(
    `UPDATE tasks SET status = 'pending', error = NULL, leads_saved = 0, cursor = NULL
     WHERE repeat_daily = 1 AND status IN ('completed', 'failed') AND finished_at <= ?`, [isoIn(-REPEAT_EVERY_SECS, ctx.now)]);
  if (requeued) ctx.log.log(`${requeued} daily task(s) queued again`);

  let task = await db.get<Task>("SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at LIMIT 1");
  if (!task) {
    const next = await db.get<{ id: number }>("SELECT id FROM tasks WHERE status = 'pending' ORDER BY created_at, id LIMIT 1");
    if (!next) return idle("no pending task");
    task = await db.get<Task>(
      `UPDATE tasks SET status = 'running', started_at = ?, finished_at = NULL, error = NULL, cursor = NULL
       WHERE id = ? AND status = 'pending' RETURNING *`, [utcNow(ctx.now), next.id]);
    if (!task) return { worked: true, note: "the task changed while it was claimed" };
    ctx.log.log(`task #${task.id} '${task.category}' in '${task.location}': ${task.candidates} lead(s) wanted`);
  }

  const cursor: Cursor = { ...freshCursor(), ...(task.cursor ?? {}) };
  const tag = `task #${task.id}`;
  const lookup = cityLookup(db);
  const savedBefore = cursor.saved;
  try {
    if (!cursor.target) {
      cursor.target = await resolveTarget(lookup, task.location);
      if (!cursor.target) throw new TaskFailed(`'${task.location}' was not recognised. Use 'City', 'City, State/Province/Country' or a region/country`);
      ctx.log.log(`${tag}: '${task.location}' is a ${cursor.target.scope} in ${cursor.target.country}`);
    }
    await work(ctx, task, cursor, lookup);
    if (cursor.saved >= task.candidates) {
      await finish(db, task, cursor, "completed", null);
    } else if (!cursor.queue.length && cursor.ended) {
      const note = cursor.checked ? `fewer leads than wanted: ${cursor.saved} of ${task.candidates} (${cursor.ended})` : `no LinkedIn companies found (${cursor.ended})`;
      await finish(db, task, cursor, "completed", note);
    } else {
      await saveCursor(db, task, cursor);
    }
  } catch (e) {
    if (e instanceof StageHold) {
      await saveCursor(db, task, cursor);
      throw e;
    }
    const message = e instanceof TaskFailed || e instanceof SearchAuthError ? e.message : errorText(e);
    await finish(db, task, cursor, "failed", message);
    ctx.log.error(`${tag} failed: ${message}`);
    return { worked: true, note: `${tag} failed: ${message}`, failed: 1 };
  } finally {
    if (cursor.saved > savedBefore) await wake(db, "scrape");
  }
  return { worked: true, note: `${tag}: ${cursor.saved}/${task.candidates} saved, ${cursor.checked} companies checked, ${cursor.page} search page(s)`, succeeded: cursor.saved - savedBefore };
}

/** Read up to `perTick` company pages, saving the leads that pass (counted in `cursor.saved`). */
async function work(ctx: Ctx, task: Task, cursor: Cursor, lookup: CityLookup): Promise<void> {
  const { cfg, db, env } = ctx;
  const tag = `task #${task.id}`;
  const target = cursor.target!;
  let budget = cfg.sourcing.perTick;
  while (budget > 0 && cursor.saved < task.candidates) {
    if (!cursor.queue.length) {
      if (cursor.ended) break;
      await nextSearchPage(ctx, task, cursor);
      continue;
    }
    if (cursor.fetches >= MAX_FETCHES_PER_RUN) throw new TaskFailed(`reached the cap of ${MAX_FETCHES_PER_RUN} LinkedIn page fetches per run`);
    const company = cursor.queue.shift()!;
    budget--;
    cursor.fetches++;
    let outcome;
    try {
      outcome = await fetchCompany(env, cfg.sourcing.transport, company.linkedin_url);
    } catch (e) {
      cursor.queue.unshift(company);
      cursor.fetches--;
      if (e instanceof BrowserQuotaExhausted) {
        throw new StageHold(`${e.message}; the free plan's browser time is used up for today (or switch Settings → Sourcing to plain fetch)`, secsUntilUtcMidnight(ctx.now));
      }
      throw e;
    }
    if (!outcome.info) {
      if (outcome.status === "404") {
        reject(cursor, "fetch failed (404)");
        continue;
      }
      cursor.blocks++;
      if (cursor.blocks >= MAX_CONSECUTIVE_BLOCKS) {
        throw new TaskFailed(`LinkedIn refused ${MAX_CONSECUTIVE_BLOCKS} pages in a row (${outcome.status}); it is likely throttling Cloudflare's IPs. Re-run the task later, or switch Settings → Sourcing → LinkedIn pages through`);
      }
      if (!company.retried) cursor.queue.unshift({ ...company, retried: true });
      else reject(cursor, `fetch failed (${outcome.status})`);
      throw new StageHold(`LinkedIn refused ${company.linkedin_url} (${outcome.status}); waiting ${BLOCK_HOLD_SECS / 60} min`, BLOCK_HOLD_SECS);
    }
    cursor.blocks = 0;
    cursor.checked++;
    const [lead, reason, note] = await evaluate(db, lookup, task, company, outcome.info, target);
    if (!lead) {
      reject(cursor, reason);
      ctx.log.log(`${tag} [${cursor.checked}] ${company.name}: skipped: ${reason}`);
      continue;
    }
    const { sql, params } = insertSql("websites", lead);
    await db.batch([db.stmt(sql, params), db.stmt("UPDATE tasks SET leads_saved = leads_saved + 1 WHERE id = ?", [task.id])]);
    cursor.saved++;
    ctx.log.log(`${tag} [${cursor.checked}] ${company.name}: saved ${lead.website_url} (${lead.employee_size}; ${note})`);
  }
}

function reject(cursor: Cursor, reason: string) {
  cursor.rejects[reason] = (cursor.rejects[reason] ?? 0) + 1;
}

async function nextSearchPage(ctx: Ctx, task: Task, cursor: Cursor) {
  const page = cursor.page + 1;
  if (page > MAX_SEARCH_PAGES) {
    cursor.ended = `reached the cap of ${MAX_SEARCH_PAGES} result pages`;
    return;
  }
  const results = await serperSearch(ctx.cfg.keys.serper, `site:linkedin.com/company ${task.category} ${task.location}`, page);
  cursor.page = page;
  if (!results.length) {
    cursor.ended = `Google returned no results on page ${page}`;
    return;
  }
  const seen = new Set(cursor.seen);
  const fresh = companiesFrom(results, seen);
  cursor.seen = [...seen];
  cursor.queue.push(...fresh);
  cursor.emptyPages = fresh.length ? 0 : cursor.emptyPages + 1;
  ctx.log.log(`task #${task.id}: search page ${page}: ${fresh.length} new compan${fresh.length === 1 ? "y" : "ies"}`);
  if (cursor.emptyPages >= MAX_EMPTY_SEARCH_PAGES) cursor.ended = `${cursor.emptyPages} result page(s) in a row had no new company (up to page ${page})`;
  else if (page >= MAX_SEARCH_PAGES) cursor.ended = `reached the cap of ${MAX_SEARCH_PAGES} result pages`;
}

/** The rules for one fetched company: [the websites row, or null; reject reason; location note]. */
async function evaluate(db: Db, lookup: CityLookup, task: Task, company: Company, li: CompanyInfo, target: Target)
  : Promise<[Record<string, unknown> | null, string, string]> {
  const name = li.name || company.name;
  const radius = task.metro_radius_km ?? DEFAULT_METRO_RADIUS_KM;
  const [ok, source, detail] = await checkLocation(lookup, target, li, name, radius);
  const note = `${source}: ${detail.slice(0, 70)}`;
  if (!ok) return [null, "location: " + (source === "none" ? "unconfirmed" : `wrong place (${source})`), note];

  const upper = employeeUpperBound(li.size);
  if (upper === null) return [null, "size: unknown", note];
  if (upper > task.max_employees) return [null, `size: too big (${li.size})`, note];

  if (!li.website) return [null, "website: not listed on LinkedIn", note];
  const [site, why] = normalizeWebsite(li.website);
  if (!site) return [null, `website: ${why}`, note];
  const key = normalizeUrl(site);
  if (await db.get("SELECT 1 FROM websites WHERE url_key = ? LIMIT 1", [key])) return [null, "already in DB", note];
  const check = await checkSite(site);
  // not remembered: a site that was only down for a moment gets another chance on the next run
  if (!check.reachable) return [null, `website: not reachable (${check.status})`, note];

  return [{
    name, website_url: site, url_key: key, category: task.category, location: task.location, source: "Linkedin",
    employee_size: li.size, employee_max: upper, industry: li.industry || null, linkedin_url: company.linkedin_url,
    target_role: task.target_role || null, opportunity_type: task.opportunity_type || null,
  }, "ok", note];
}

async function saveCursor(db: Db, task: Task, cursor: Cursor) {
  await db.run("UPDATE tasks SET cursor = ? WHERE id = ?", [cursor, task.id]);
}

async function finish(db: Db, task: Task, cursor: Cursor, status: "completed" | "failed", error: string | null) {
  const rejects = Object.entries(cursor.rejects).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}: ${n}`).join("; ");
  const summary = `${cursor.saved} saved, ${cursor.checked} checked${rejects ? `; skipped ${rejects}` : ""}`;
  await db.run("UPDATE tasks SET status = ?, error = ?, finished_at = ?, cursor = ? WHERE id = ?",
    [status, error ? `${error} [${summary}]` : status === "completed" ? null : summary, utcNow(), { ...cursor, queue: [] }, task.id]);
}

/** Open-Meteo, cached in D1 (`geo_cache`) and in memory for the isolate's life. */
const memo = new Map<string, City[]>();
export function cityLookup(db: Db): CityLookup {
  return async (name, country) => {
    const key = `${name.trim().toLowerCase()}|${country ?? ""}`;
    if (name.trim().length < 2) return [];
    const hit = memo.get(key);
    if (hit) return hit;
    const row = await db.get<{ result: string }>("SELECT result FROM geo_cache WHERE query = ?", [key]);
    if (row) {
      const cities = JSON.parse(row.result) as City[];
      memo.set(key, cities);
      return cities;
    }
    let cities: City[];
    try {
      cities = citiesFrom(name, await openMeteoSearch(name.trim(), country));
    } catch (e) {
      throw new StageHold(`the geocoding service failed (${errorText(e)}); trying again later`, 600);
    }
    memo.set(key, cities);
    await db.run("INSERT OR REPLACE INTO geo_cache (query, result) VALUES (?, ?)", [key, JSON.stringify(cities)]);
    return cities;
  };
}
