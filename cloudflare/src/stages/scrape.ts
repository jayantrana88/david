/**
 * Scrape stage (stages/scrape/): each new lead's homepage via Jina, then the AI's fit check for the
 * candidate. Queue: leads with no `website_scrapes` row, or one still `is_qualified IS NULL` (only the AI is
 * asked again, from the saved `homepage_text`). Empty until the candidate profile is ready.
 *
 * Errors are data, not exceptions:
 *   Jina can't read the homepage          -> is_qualified=False (terminal)
 *   Jina reads it, the AI answers         -> True / False
 *   Jina reads it, the AI fails           -> NULL (offered again; an LLMUnavailable also holds the stage)
 */
import { type CandidateProfile, readyProfile } from "../candidate";
import { type Ctx, FAILURE_BACKOFF_SECS, LeadFailed, notBackedOff, recordOutcome, type StageResult, idle, wake } from "../core";
import { insertSql } from "../db";
import { jinaRead, pageText, parseJinaResponse } from "../jina";
import { askInBatches, type LLM, LLMUnavailable, makeLLM } from "../llm";
import { parseVerdict, parseVerdicts, QUALIFICATION, QUALIFICATION_BATCH, qualificationBatchPrompt, qualificationPrompt, type Verdict } from "../prompts";
import { errorText, utcNow } from "../util";

export const MAX_MAIN_LINKS = 5;
export const QUALIFY_CONTEXT_CHARS = 3000;

interface ScrapeJob {
  id: string;
  name: string | null;
  website_url: string;
  target_role: string | null;
  opportunity_type: string | null;
  scrape_id: string | null;
  homepage_text: string | null;
}

interface ScrapeResult {
  isQualified: boolean | null;
  text: string;
  mainLinks: Record<string, string> | null;
  summary: string | null;
  emails: string[];
  llmError: LLMUnavailable | null;
}

const label = (j: ScrapeJob) => j.name || j.website_url || j.id;

export async function runScrape(ctx: Ctx): Promise<StageResult> {
  const { profile, why } = await readyProfile(ctx.db);
  if (!profile) return idle(why);
  const jobs = await ctx.db.all<ScrapeJob>(
    `SELECT w.id, w.name, w.website_url, w.target_role, w.opportunity_type, s.id AS scrape_id, s.homepage_text
     FROM websites w LEFT JOIN website_scrapes s ON s.website_id = w.id
     WHERE (s.id IS NULL OR s.is_qualified IS NULL) AND ${notBackedOff("scrape", "w.id")}
     ORDER BY w.created_at LIMIT ?`,
    [utcNow(ctx.now), ctx.cfg.ai.qualifyBatch],
  );
  if (!jobs.length) return idle("no website waiting for a scrape");

  const results = await scrapeRound(ctx, jobs, profile);
  let ok = 0, failed = 0, qualified = 0;
  let hold: LLMUnavailable | null = null;
  for (let i = 0; i < jobs.length; i++) {
    const outcome = await save(ctx, jobs[i], results[i]).then(() => null, (e: unknown) => e);
    if (outcome instanceof LLMUnavailable) {
      hold = outcome;       // the row is saved (NULL); the stage holds, the lead isn't counted as failed
      continue;
    }
    const how = await recordOutcome(ctx, "scrape", jobs[i].id, label(jobs[i]), outcome);
    if (how === "ok") {
      ok++;
      if (results[i].isQualified) qualified++;
    } else if (how === "failed") failed++;
  }
  if (qualified) await wake(ctx.db, "internal");
  const note = `${jobs.length} lead(s): ${qualified} qualified, ${ok - qualified} decided otherwise, ${failed} failed`;
  return { worked: true, note, succeeded: ok, failed, hold: hold ? { secs: hold.holdSecs, reason: hold.message } : undefined };
}

async function scrapeRound(ctx: Ctx, jobs: ScrapeJob[], profile: CandidateProfile): Promise<ScrapeResult[]> {
  const results = await Promise.all(jobs.map((job) => (job.scrape_id ? saved(job) : readHomepage(ctx, job))));
  const asks: number[] = [];
  results.forEach((r, i) => {
    if (r.isQualified !== null) return;
    if (!r.text) r.isQualified = false;     // nothing on the page to judge
    else asks.push(i);
  });
  const answers = await qualifyMany(ctx, makeLLM(ctx.env, ctx.cfg), profile.brief(),
    asks.map((i) => ({ text: results[i].text, seeking: profile.seeking(jobs[i].target_role, jobs[i].opportunity_type) })));
  asks.forEach((i, k) => {
    const answer = answers[k];
    const r = results[i];
    if (answer instanceof LLMUnavailable) r.llmError = answer;
    else if (answer instanceof Error) ctx.log.warn(`${label(jobs[i])}: no verdict (${answer.message})`);
    else if (answer) {
      r.isQualified = answer.qualified;
      r.summary = answer.summary;
    }
  });
  return results;
}

function saved(job: ScrapeJob): ScrapeResult {
  return { isQualified: null, text: job.homepage_text ?? "", mainLinks: null, summary: null, emails: [], llmError: null };
}

async function readHomepage(ctx: Ctx, job: ScrapeJob): Promise<ScrapeResult> {
  const resp = await jinaRead(job.website_url, ctx.cfg.keys.jina, (m) => ctx.log.warn(m));
  if (!resp || resp.code !== 200) {
    ctx.log.warn(`${label(job)}: ${resp ? `Jina answered code ${resp.code}` : "Jina could not read the homepage"}; saving as unqualified`);
    return { isQualified: false, text: "", mainLinks: null, summary: null, emails: [], llmError: null };
  }
  const parsed = parseJinaResponse(resp, job.website_url, MAX_MAIN_LINKS);
  return {
    isQualified: null, text: pageText(parsed.data, QUALIFY_CONTEXT_CHARS), mainLinks: parsed.mainLinks,
    summary: null, emails: parsed.emails, llmError: null,
  };
}

/** One answer per company: a Verdict, null ("no verdict this time"), or the error (scrape/qualify.py). */
export async function qualifyMany(ctx: Ctx, llm: LLM, candidate: string, requests: { text: string; seeking: string }[]) {
  return askInBatches<{ text: string; seeking: string }, Verdict | null>(
    requests,
    ctx.cfg.ai.qualifyBatch,
    async (chunk) => {
      const reply = await llm.chat(qualificationBatchPrompt(candidate, chunk.map((r) => [r.seeking, r.text])), QUALIFICATION_BATCH);
      return parseVerdicts(reply, chunk.length);
    },
    async (request, attempts) => {
      let reply: string;
      try {
        reply = await llm.chat(qualificationPrompt(candidate, request.seeking, request.text), QUALIFICATION, attempts);
      } catch (e) {
        if (e instanceof LLMUnavailable) throw e;
        ctx.log.warn(`qualification failed: ${errorText(e).slice(0, 200)}`);
        return null;
      }
      const verdict = parseVerdict(reply);
      if (!verdict) ctx.log.warn(`qualification reply held no clear verdict: ${reply.slice(0, 200)}`);
      return verdict;
    },
    (m) => ctx.log.log(`qualification: ${m}`),
  );
}

/** Save one lead's result. Throws what to record: the AI's error (after saving), or LeadFailed. */
async function save(ctx: Ctx, job: ScrapeJob, r: ScrapeResult): Promise<void> {
  if (job.scrape_id) {          // the AI was asked again about a saved read
    if (r.isQualified === null) throw r.llmError ?? new LeadFailed(`still no verdict from the AI; left NULL, asked again in ${FAILURE_BACKOFF_SECS / 60} min`);
    await ctx.db.run("UPDATE website_scrapes SET is_qualified = ?, summary = ? WHERE id = ?", [r.isQualified, r.summary, job.scrape_id]);
    ctx.log.log(`${label(job)}: ${r.isQualified ? "qualified" : "not a fit"} (asked again)`);
    return;
  }
  const { sql, params } = insertSql("website_scrapes", {
    website_id: job.id, homepage_text: r.text || null, main_links: r.mainLinks, summary: r.summary, is_qualified: r.isQualified,
  });
  const statements = [ctx.db.stmt(sql, params)];
  // One comma-separated string: the column the email stage's queue depends on
  if (r.emails.length) statements.push(ctx.db.stmt("UPDATE websites SET email = ? WHERE id = ?", [r.emails.join(", "), job.id]));
  await ctx.db.batch(statements);
  ctx.log.log(r.isQualified === null
    ? `${label(job)}: saved, no verdict yet (left NULL)`
    : `${label(job)}: ${r.isQualified ? "qualified" : "not a fit"}${r.emails.length ? `, ${r.emails.length} email(s)` : ""}`);
  if (r.llmError) throw r.llmError;
  // saved NULL: offered again after the backoff (the daemon's in-memory "done" set has no Worker equivalent)
  if (r.isQualified === null) throw new LeadFailed("no verdict from the AI yet; saved with is_qualified NULL");
}
