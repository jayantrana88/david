/**
 * Email stage (stages/email/): an application to every uncontacted company, resume attached.
 *
 * Queue: qualified leads with an address and at least one page read, and no `cold_emails` row except a
 * `send_failed` one. Empty until the profile is ready and (with "attach resume") a resume exists. Per tick:
 * the AI writes the round's drafts (batched, rule-checked), then per lead:
 *   dry_run   a `draft` row, nothing sent (switching to send deletes the drafts: settings save)
 *   send      `sending` row -> deliver (Telegram / Gmail / Outlook) -> `sent` / `send_failed` / `rejected`;
 *             `uncertain` leaves the row `sending`, so the lead is never emailed twice.
 * NoApprovedDraft (no draft passed the rules) writes a `generation_failed` row in send mode. Every write
 * replaces the lead's row, so a lead keeps exactly one.
 */
import { loadResume, readyProfile } from "../candidate";
import { type Ctx, idle, LeadFailed, LeadSkipped, notBackedOff, recordOutcome, type StageResult } from "../core";
import { type Db, insertSql } from "../db";
import { LLMUnavailable, makeLLM } from "../llm";
import type { Attachment, Mailer } from "../mail/mail";
import { makeOAuthMailer } from "../mail/oauth";
import { Telegram } from "../mail/telegram";
import type { Config } from "../settings";
import { secsUntilUtcMidnight, todayStartIso, utcNow } from "../util";
import { compose, type Lead, MAX_CONTEXT_CHARS, pickEmail, writeMany } from "./writer";

class NoApprovedDraft extends LeadFailed {
  constructor(readonly toEmail: string) {
    super("no draft passed the rules", true);
  }
}

export async function makeMailer(db: Db, cfg: Config): Promise<Mailer> {
  if (cfg.email.delivery === "telegram") return new Telegram(cfg.keys.telegramBotToken, cfg.keys.telegramChatId);
  return makeOAuthMailer(db, cfg, cfg.email.delivery);
}

/** Emails sent (or possibly sent) today, against "max sends per day". */
async function sentToday(db: Db, now: Date): Promise<number> {
  const today = todayStartIso(now);
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cold_emails WHERE (status = 'sent' AND sent_at >= ?) OR (status = 'sending' AND created_at >= ?)", [today, today]);
  return row?.n ?? 0;
}

export async function runEmail(ctx: Ctx): Promise<StageResult> {
  const { cfg, db } = ctx;
  if (!cfg.email.enabled) return idle("emails are turned off (Settings → Email)");
  const { profile, why } = await readyProfile(db);
  if (!profile) return idle(why);
  const dryRun = cfg.email.mode === "dry_run";
  let attachment: Attachment | null = null;
  if (cfg.email.attachResume) {
    attachment = await loadResume(db, profile);
    if (!attachment) return idle("no resume to attach: upload one on the Profile page, or turn off \"attach resume\"");
  }
  let room = cfg.ai.emailBatch;
  if (!dryRun && cfg.email.maxSendsPerDay) {
    const sent = await sentToday(db, ctx.now);
    if (sent >= cfg.email.maxSendsPerDay) {
      const reason = `sent today's ${cfg.email.maxSendsPerDay} email(s) (max sends per day); resuming after midnight UTC`;
      return { worked: true, note: reason, hold: { secs: secsUntilUtcMidnight(ctx.now), reason } };
    }
    room = Math.min(room, cfg.email.maxSendsPerDay - sent);
  }
  // Built before any AI call, so a channel that isn't set up holds the stage instead of wasting drafts
  let mailer: Mailer | null = null;
  if (!dryRun) {
    try {
      mailer = await makeMailer(db, cfg);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { worked: true, note: reason, hold: { secs: 900, reason } };
    }
  }

  const leads = await uncontactedLeads(ctx, room);
  if (!leads.length) return idle("no lead waiting for an application");

  const addresses = leads.map((l) => pickEmail(l.email));
  const writable = leads.filter((_, i) => addresses[i]);
  const drafts = await writeMany(makeLLM(ctx.env, cfg), writable, profile, attachment !== null, cfg.ai.emailBatch,
    cfg.email.instructions, (m) => ctx.log.log(m));
  const byLead = new Map(writable.map((l, i) => [l.id, drafts[i]]));

  let ok = 0, failed = 0;
  let hold: LLMUnavailable | null = null;
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const to = addresses[i];
    const label = lead.name || lead.id;
    let outcome: unknown = null;
    if (!to) outcome = new LeadSkipped("no valid email address");
    else {
      const draft = byLead.get(lead.id);
      if (draft instanceof LLMUnavailable) {
        hold = draft;
        continue;               // not counted: the stage holds
      }
      if (draft instanceof Error) outcome = draft;
      else if (!draft) outcome = new NoApprovedDraft(to);
      else {
        const plan = { websiteId: lead.id, to, subject: draft.subject, body: compose(lead.name, draft.body, profile), attachmentName: attachment?.filename ?? null };
        outcome = await deliver(ctx, plan, dryRun, mailer, attachment, profile.full_name || cfg.email.senderName, label).then(() => null, (e: unknown) => e);
      }
    }
    if (outcome instanceof NoApprovedDraft && !dryRun) {
      await replaceEmailRow(db, { website_id: lead.id, email_address: outcome.toEmail, status: "generation_failed" });
    }
    const how = await recordOutcome(ctx, "email", lead.id, label, outcome);
    if (how === "ok") ok++;
    else if (how === "failed") failed++;
  }
  return {
    worked: true,
    note: `${leads.length} lead(s): ${ok} ${dryRun ? "drafted" : "sent"}, ${failed} failed`,
    succeeded: ok, failed,
    hold: hold ? { secs: hold.holdSecs, reason: hold.message } : undefined,
  };
}

async function uncontactedLeads(ctx: Ctx, limit: number): Promise<Lead[]> {
  const rows = await ctx.db.all<Lead & { content_json: string }>(
    `SELECT w.id, w.name, w.category, w.location, w.email,
            (SELECT json_group_array(json_object(
                        'page_name', p.page_name, 'page_url', p.page_url,
                        'content_json', CASE WHEN json_type(p.content_json, '$.content') = 'text'
                            THEN json_set(p.content_json, '$.content', substr(json_extract(p.content_json, '$.content'), 1, ?))
                            ELSE json(p.content_json) END))
             FROM website_pages p WHERE p.scrape_id = s.id) AS content_json,
            w.industry, w.employee_size, s.summary, w.target_role, w.opportunity_type
     FROM websites w
     JOIN website_scrapes s ON s.website_id = w.id AND s.is_qualified = 1
     WHERE w.email IS NOT NULL AND w.email <> ''
       AND EXISTS (SELECT 1 FROM website_pages p WHERE p.scrape_id = s.id AND p.content_json IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM cold_emails c WHERE c.website_id = w.id AND c.status <> 'send_failed')
       AND ${notBackedOff("email", "w.id")}
     ORDER BY w.created_at LIMIT ?`,
    [MAX_CONTEXT_CHARS, utcNow(ctx.now), limit],
  );
  return rows;
}

/** Delete any `cold_emails` row the lead has and insert `row` (one batch): a lead keeps exactly one row. */
async function replaceEmailRow(db: Db, row: Record<string, unknown>): Promise<string> {
  const { sql, params } = insertSql("cold_emails", row, "id");
  const [, inserted] = await db.batch([db.stmt("DELETE FROM cold_emails WHERE website_id = ?", [row.website_id]), db.stmt(sql, params)]);
  return String((inserted.results[0] as { id: string }).id);
}

interface Plan {
  websiteId: string;
  to: string;
  subject: string;
  body: string;
  attachmentName: string | null;
}

/** Keep this order: the `sending` row, then the send, then its outcome (never a lead emailed twice). */
async function deliver(ctx: Ctx, plan: Plan, dryRun: boolean, mailer: Mailer | null, attachment: Attachment | null, fromName: string, label: string) {
  const row = { website_id: plan.websiteId, email_address: plan.to, subject: plan.subject, body: plan.body, attachment_name: plan.attachmentName };
  if (dryRun || !mailer) {
    await replaceEmailRow(ctx.db, { ...row, status: "draft" });
    ctx.log.log(`${label} → ${plan.to}: draft saved (dry run, not sent)`);
    return;
  }
  const delivery = ctx.cfg.email.delivery;
  const id = await replaceEmailRow(ctx.db, { ...row, delivery, status: "sending" });
  const [status, detail] = await mailer.send(plan.to, plan.subject, plan.body, attachment ? [attachment] : null, fromName);
  if (status === "uncertain") {
    throw new LeadFailed(`no answer from ${delivery}, it may have been sent; left as 'sending' (check the Sent folder): ${detail}`, true);
  }
  await ctx.db.run(`UPDATE cold_emails SET status = ?${status === "sent" ? ", sent_at = ?" : ""} WHERE id = ?`,
    status === "sent" ? [status, utcNow(), id] : [status, id]);
  if (status === "sent") ctx.log.log(`${label} → ${plan.to}: sent via ${delivery} (${detail})`);
  else if (status === "rejected") throw new LeadFailed(`${delivery} refused ${plan.to}: ${detail}`, true);
  else throw new LeadFailed(`not sent via ${delivery}: ${detail}`);
}
