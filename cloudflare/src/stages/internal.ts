/**
 * Internal stage (stages/internal/): up to 5 internal pages of every qualified lead, through Jina.
 * Queue: qualified scrapes with no `website_pages` row, or only the `content_json IS NULL` placeholder left
 * when every read failed. Never throws for a Jina failure: no internal links -> one "Homepage only" page;
 * every link failed -> one placeholder (offered again). A lead's pages are replaced as a whole (one batch).
 */
import { type Ctx, idle, LeadFailed, notBackedOff, recordOutcome, type StageResult, wake } from "../core";
import { insertSql } from "../db";
import { extractEmails, jinaRead } from "../jina";
import { unique, utcNow } from "../util";

export const MAX_SUBPAGES = 5;
export const MAX_CONTENT_CHARS = 8000;
export const HOMEPAGE_ONLY_URL = "Homepage only";
export const FETCH_FAILED_NAME = "Internal pages";
const LEADS_PER_TICK = 2;      // each reads up to 5 pages: 10 Jina reads, under the free tier's 20 a minute

interface QualifiedScrape {
  id: string;
  website_id: string;
  summary: string | null;
  main_links: Record<string, string> | null;
}

interface Page {
  name: string;
  url: string | null;
  content: { title?: string; description?: string; content: string } | null;
  emails: string[];
}

export async function runInternal(ctx: Ctx): Promise<StageResult> {
  const scrapes = await ctx.db.all<QualifiedScrape>(
    `SELECT s.id, s.website_id, s.summary, s.main_links FROM website_scrapes s
     WHERE s.is_qualified = 1
       AND NOT EXISTS (SELECT 1 FROM website_pages p WHERE p.scrape_id = s.id AND p.content_json IS NOT NULL)
       AND ${notBackedOff("internal", "s.id")}
     ORDER BY s.created_at LIMIT ?`,
    [utcNow(ctx.now), LEADS_PER_TICK],
  );
  if (!scrapes.length) return idle("no qualified lead waiting for its pages");

  let ok = 0, failed = 0, pagesSaved = 0;
  const outcomes = await Promise.all(scrapes.map((s) => readAndSave(ctx, s).then(
    (n) => {
      pagesSaved += n;
      // the placeholder is saved; the lead comes back after the backoff to be read in full again
      return n ? null : new LeadFailed("no internal page could be read; placeholder saved");
    },
    (e: unknown) => e,
  )));
  for (let i = 0; i < scrapes.length; i++) {
    const how = await recordOutcome(ctx, "internal", scrapes[i].id, `scrape ${scrapes[i].id}`, outcomes[i]);
    if (how === "ok") ok++;
    else if (how === "failed") failed++;
  }
  if (pagesSaved) await wake(ctx.db, "email");
  return { worked: true, note: `${scrapes.length} lead(s): ${pagesSaved} page(s) saved, ${failed} failed`, succeeded: ok, failed };
}

/** Read one lead's pages and save them; returns how many real pages were saved (0 = placeholder). */
async function readAndSave(ctx: Ctx, scrape: QualifiedScrape): Promise<number> {
  const links = Object.entries(scrape.main_links ?? {}).slice(0, MAX_SUBPAGES);
  let pages: Page[];
  let real = 0;
  if (!links.length) {
    pages = [{ name: "Homepage", url: HOMEPAGE_ONLY_URL, content: { content: scrape.summary ?? "" }, emails: [] }];
    real = 1;
  } else {
    const read = (await Promise.all(links.map(([name, url]) => readPage(ctx, name, url)))).filter((p): p is Page => p !== null);
    if (read.length) {
      pages = read;
      real = read.length;
      ctx.log.log(`scrape ${scrape.id}: read ${read.length}/${links.length} internal page(s)`);
    } else {
      ctx.log.warn(`scrape ${scrape.id}: none of the ${links.length} internal pages could be read; saving a placeholder for a retry`);
      pages = [{ name: FETCH_FAILED_NAME, url: null, content: null, emails: [] }];
    }
  }

  const statements = [ctx.db.stmt("DELETE FROM website_pages WHERE scrape_id = ?", [scrape.id])];
  for (const page of pages) {
    const { sql, params } = insertSql("website_pages", { scrape_id: scrape.id, page_name: page.name, page_url: page.url, content_json: page.content });
    statements.push(ctx.db.stmt(sql, params));
  }
  // Before (in the same batch as) the pages: the email stage offers a lead once it has pages
  const emails = unique(pages.flatMap((p) => p.emails));
  if (emails.length) {
    const row = await ctx.db.get<{ email: string | null }>("SELECT email FROM websites WHERE id = ?", [scrape.website_id]);
    const have = (row?.email ?? "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    const merged = unique([...have, ...emails]);
    if (merged.length > have.length) statements.unshift(ctx.db.stmt("UPDATE websites SET email = ? WHERE id = ?", [merged.join(", "), scrape.website_id]));
  }
  await ctx.db.batch(statements);
  return real;
}

async function readPage(ctx: Ctx, name: string, url: string): Promise<Page | null> {
  const resp = await jinaRead(url, ctx.cfg.keys.jina, (m) => ctx.log.warn(m));
  if (!resp || resp.code !== 200) return null;
  const data = resp.data ?? {};
  const content = (data.content ?? "").trim();
  if (!content) return null;
  const title = (data.title ?? "").trim();
  const description = (data.description ?? "").trim();
  return {
    name, url,
    content: { title, description, content: content.slice(0, MAX_CONTENT_CHARS) },
    emails: extractEmails(data.links, content, description, title),     // the whole page, not just what is saved
  };
}
