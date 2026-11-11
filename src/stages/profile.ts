/**
 * Profile stage (stages/profile/): the resume (PDF / DOCX) and the user's notes -> the candidate profile.
 *
 * Queue: the `candidate_profile` row while `parse_status = 'pending'` (the dashboard sets it on upload and
 * "re-derive"). The resume's text comes from Workers AI's free `toMarkdown` (instead of pypdf / python-docx),
 * then the AI reads the profile out of it. A bad file or an unusable reply becomes `failed` + `parse_error`,
 * never an exception; an LLMUnavailable holds the stage and leaves the row `pending`. The result is applied
 * only while `updated_at` is unchanged (the user may have uploaded again meanwhile).
 */
import { CandidateProfile, loadResume } from "../candidate";
import { type Ctx, idle, type StageResult, StageHold, wake } from "../core";
import { setClause } from "../db";
import { LLMUnavailable, makeLLM } from "../llm";
import { CANDIDATE_PROFILE, type DerivedProfile, parseProfile, profilePrompt } from "../prompts";
import { base64ToBytes, errorText, utcNow } from "../util";

type Outcome = { derived: DerivedProfile | null; resumeText: string | null; error: string | null };

export async function runProfile(ctx: Ctx): Promise<StageResult> {
  const row = await ctx.db.get("SELECT * FROM candidate_profile WHERE id = 1 AND parse_status = 'pending'");
  if (!row) return idle("no profile waiting to be derived");
  const profile = CandidateProfile.fromRow(row);

  let outcome: Outcome;
  try {
    outcome = await derive(ctx, profile);
  } catch (e) {
    if (e instanceof LLMUnavailable) {
      return { worked: true, note: `waiting for the AI: ${e.message}`, hold: { secs: e.holdSecs, reason: e.message } };
    }
    throw e;
  }
  const update: Record<string, unknown> = { parsed_at: utcNow(ctx.now) };
  if (outcome.resumeText !== null) update.resume_text = outcome.resumeText;
  if (!outcome.derived) {
    Object.assign(update, { parse_status: "failed", parse_error: outcome.error });
  } else {
    Object.assign(update, { parse_status: "done", parse_error: null });
    for (const [key, value] of Object.entries(outcome.derived)) {
      if (value !== "" && value !== null && !(Array.isArray(value) && !value.length)) update[key] = value;
    }
  }
  const { sql, params } = setClause(update);
  const applied = await ctx.db.run(`UPDATE candidate_profile SET ${sql} WHERE id = 1 AND updated_at = ?`, [...params, profile.updated_at]);
  if (!applied) return { worked: true, note: "the profile changed while it was read; reading it again next tick" };
  if (outcome.derived) {
    ctx.log.log(`profile derived: ${outcome.derived.headline || outcome.derived.target_roles.join(", ")}`);
    await wake(ctx.db, "scrape", "email");
    return { worked: true, note: "profile derived", succeeded: 1 };
  }
  ctx.log.warn(`profile not derived: ${outcome.error}`);
  return { worked: true, note: `profile failed: ${outcome.error}`, failed: 1 };
}

async function derive(ctx: Ctx, profile: CandidateProfile): Promise<Outcome> {
  let text = "";
  if (profile.resume_sha256) {
    const file = await loadResume(ctx.db, profile);
    if (!file) return { derived: null, resumeText: null, error: "the resume file is missing; upload it again" };
    try {
      text = await resumeText(ctx.env, file.filename, file.mime, file.base64);
    } catch (e) {
      if (e instanceof StageHold) throw e;      // the conversion service itself failed: try again later
      return { derived: null, resumeText: null, error: e instanceof Error ? e.message : String(e) };
    }
    ctx.log.log(`resume '${file.filename}': ${text.length} characters of text`);
  }
  if (!text && !profile.career_notes.trim()) {
    return { derived: null, resumeText: null, error: "upload a resume or write a few lines about your career first" };
  }

  let reply: string;
  try {
    reply = await makeLLM(ctx.env, ctx.cfg).chat(profilePrompt(text, profile.career_notes), CANDIDATE_PROFILE);
  } catch (e) {
    if (e instanceof LLMUnavailable) throw e;
    ctx.log.warn(`AI call failed: ${errorText(e).slice(0, 200)}`);
    return { derived: null, resumeText: text || null, error: "the AI call failed; try again" };
  }
  const derived = parseProfile(reply);
  if (!derived) {
    ctx.log.warn(`reply held no usable profile: ${reply.slice(0, 200)}`);
    return { derived: null, resumeText: text || null, error: "the AI could not read a profile out of this; add a few lines of notes and try again" };
  }
  return { derived, resumeText: text || null, error: null };
}

/** The resume's text, through Workers AI's markdown conversion (free for PDF and DOCX). */
export async function resumeText(env: Env, filename: string, mime: string, base64: string): Promise<string> {
  const bytes = base64ToBytes(base64);
  let result;
  try {
    result = await env.AI.toMarkdown({ name: filename, blob: new Blob([bytes], { type: mime }) });
  } catch (e) {
    throw new StageHold(`could not convert the resume: ${errorText(e)}`, 600);
  }
  if (result.format === "error") throw new Error(`could not read the resume (${result.error}); upload it as a PDF or DOCX`);
  const text = result.data.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("the resume has no text in it (a scanned image?); upload a text PDF or DOCX, or write notes");
  return text;
}
