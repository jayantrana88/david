/**
 * The email writer (stages/email/writer.py + recipients.py): the AI writes the middle of an application, it
 * is checked against cheap rules and rewritten with the problems found until one passes (3 tries); the
 * round's first drafts go out batched. `compose` wraps the middle in "Hi <company> team," and the signature.
 */
import type { CandidateProfile } from "../candidate";
import { LeadFailed } from "../core";
import { askInBatches, type LLM, LLMUnavailable } from "../llm";
import { COLD_EMAIL, COLD_EMAIL_BATCH, coldEmailBatchPrompt, coldEmailPrompt, type LeadFacts, parseEmailDraft, parseEmailDrafts } from "../prompts";
import { errorText, wordCount } from "../util";

export const MAX_CONTEXT_CHARS = 2000;
export const GENERATION_ATTEMPTS = 3;
const MIN_BODY_WORDS = 60;
const MAX_BODY_WORDS = 155;
const MAX_PARAGRAPHS = 3;
const MAX_PARAGRAPH_WORDS = 70;

const GREETING_RE = /^\s*(hi|hello|hey|dear)\b/i;
const SIGN_OFF_RE = /^\s*(best|best regards|regards|kind regards|sincerely|cheers|thanks|thank you)[,!.]?\s*$/im;
const LIST_LINE_RE = /^\s*(?:[-*•]|\d+[.)])\s/m;
const DASH_RE = /[—–]|\s-{1,2}\s|--/;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()"']+/gi;
const RESUME_RE = /r[eé]sum[eé]|\bcv\b/i;

export interface Lead {
  id: string;
  name: string | null;
  category: string | null;
  location: string | null;
  email: string | null;
  content_json: unknown;
  industry: string | null;
  employee_size: string | null;
  summary: string | null;
  target_role: string | null;
  opportunity_type: string | null;
}

export interface Draft {
  subject: string;
  body: string;
}

// ── recipients ────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const ASSET_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".css", ".js"];
const JUNK_LOCAL_PARTS = new Set(["noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "postmaster", "abuse", "privacy", "unsubscribe"]);
const JUNK_DOMAINS = ["sentry.io", "wixpress.com", "example.com", "example.org", "domain.com", "yourdomain.com", "yoursite.com"];

/** The first usable address in `websites.email` (comma-separated), or null. */
export function pickEmail(raw: string | null | undefined): string | null {
  for (let candidate of (raw ?? "").split(/[,;\s]+/)) {
    candidate = candidate.trim().toLowerCase();
    if (!EMAIL_RE.test(candidate) || ASSET_SUFFIXES.some((s) => candidate.endsWith(s))) continue;
    const at = candidate.lastIndexOf("@");
    const local = candidate.slice(0, at);
    const domain = candidate.slice(at + 1);
    if (JUNK_LOCAL_PARTS.has(local)) continue;
    if (JUNK_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) continue;
    return candidate;
  }
  return null;
}

/** "Hi <company> team," (the part of the name before a separator), or "Hi there,". */
export function greeting(name: string | null | undefined): string {
  const short = (name ?? "").trim().split(/\s*[|–—]\s*|\s+-\s+|:\s/)[0].trim();
  return short ? `Hi ${short} team,` : "Hi there,";
}

export function signature(profile: CandidateProfile): string {
  return ["Best regards,", profile.full_name, profile.phone, profile.linkedin_url, profile.portfolio_url].filter(Boolean).join("\n");
}

export function compose(name: string | null | undefined, body: string, profile: CandidateProfile): string {
  return `${greeting(name)}\n\n${body.trim()}\n\n${signature(profile)}`;
}

// ── rules ─────────────────────────────────────────────────────────────────────

/** Cheap, token-free checks on a draft: the problems found (empty = OK). */
export function checkRules(draft: Draft, allowedLinks: string[], attached: boolean): string[] {
  const { subject, body } = draft;
  const issues: string[] = [];
  const subjectWords = wordCount(subject);
  if (subjectWords < 2 || subjectWords > 10) issues.push("the subject must be 3 to 8 words");
  if (GREETING_RE.test(body)) issues.push("remove the greeting; it is added automatically, start with the first paragraph");
  const words = wordCount(body);
  if (words < MIN_BODY_WORDS || words > MAX_BODY_WORDS) issues.push(`the body is ${words} words; it must be 70 to 140 words`);
  const paragraphs = body.trim().split(/\n\s*\n/).filter((p) => p.trim());
  if (paragraphs.length > MAX_PARAGRAPHS) issues.push(`the body has ${paragraphs.length} paragraphs; use 2 or 3 short ones`);
  else if (paragraphs.length === 1 && words > MAX_PARAGRAPH_WORDS) issues.push("split the body into 2 or 3 short paragraphs separated by a blank line");
  if (paragraphs.some((p) => wordCount(p) > MAX_PARAGRAPH_WORDS)) issues.push("a paragraph is too long; keep each one to 3 lines");
  if (LIST_LINE_RE.test(body)) issues.push("write in short paragraphs, with no bullet points or numbered lists");
  if (DASH_RE.test(`${subject}\n${body}`)) issues.push("remove every dash (—, – or a hyphen between words); use a comma or a full stop instead");
  const allowed = new Set(allowedLinks.map((u) => u.replace(/\/+$/, "").toLowerCase()));
  const urls = [...`${subject}\n${body}`.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, "").replace(/\/+$/, "").toLowerCase());
  if (urls.some((u) => !allowed.has(u))) {
    issues.push(allowedLinks.length ? `remove every link except ${allowedLinks.join(", ")}` : "remove every link; the email must not contain any");
  }
  if (attached && !RESUME_RE.test(body)) issues.push("say in the last paragraph that your resume is attached");
  if (/\[[^\]]*\]|\{\{|\}\}/.test(subject + body)) issues.push("remove placeholders like [Name]");
  if (SIGN_OFF_RE.test(body)) issues.push("remove the sign off; a signature is added automatically");
  return issues;
}

// ── writing ───────────────────────────────────────────────────────────────────

const researchText = (lead: Lead) => JSON.stringify(lead.content_json ?? null).slice(0, MAX_CONTEXT_CHARS);

const leadFacts = (lead: Lead, profile: CandidateProfile): LeadFacts => ({
  name: lead.name ?? "", category: lead.category ?? "", industry: lead.industry ?? "", size: lead.employee_size ?? "",
  location: lead.location ?? "", fit_summary: lead.summary ?? "", seeking: profile.seeking(lead.target_role, lead.opportunity_type),
});

const candidateText = (profile: CandidateProfile, attached: boolean) =>
  attached ? profile.brief() : profile.brief() + "\n- Note: no resume is attached to this email; don't mention one.";

/**
 * One answer per lead, in order: an approved Draft, null (no draft passed the rules), or the error
 * (LLMUnavailable, or LeadFailed for another AI error). Never throws.
 */
export async function writeMany(llm: LLM, leads: Lead[], profile: CandidateProfile, attached: boolean, emailBatch: number,
  instructions: string, log: (m: string) => void): Promise<(Draft | null | Error)[]> {
  const generate = async (lead: Lead, feedback: string[] | null, attempts?: number): Promise<Draft | null> => {
    const prompt = coldEmailPrompt(candidateText(profile, attached), leadFacts(lead, profile), researchText(lead), profile.links(), feedback, instructions);
    let text: string;
    try {
      text = await llm.chat(prompt, COLD_EMAIL, attempts);
    } catch (e) {
      if (e instanceof LLMUnavailable) throw e;
      throw new LeadFailed(`AI error while writing: ${errorText(e).slice(0, 200)}`);
    }
    const draft = parseEmailDraft(text);
    if (draft) return { subject: draft[0], body: draft[1] };
    log(`${lead.name ?? lead.id}: the AI reply was not valid subject/body JSON`);
    return null;
  };

  const first = await askInBatches<Lead, Draft | null>(
    leads,
    emailBatch,
    async (chunk) => {
      const prompt = coldEmailBatchPrompt(candidateText(profile, attached), chunk.map((l) => leadFacts(l, profile)),
        chunk.map(researchText), profile.links(), instructions);
      const reply = await llm.chat(prompt, COLD_EMAIL_BATCH);
      return new Map([...parseEmailDrafts(reply, chunk.length)].map(([n, [subject, body]]) => [n, { subject, body }]));
    },
    (lead, attempts) => generate(lead, null, attempts),
    (m) => log(`first drafts: ${m}`),
  );

  const checked = await Promise.allSettled(leads.map(async (lead, i): Promise<Draft | null> => {
    const answer = first[i];
    if (answer instanceof Error) throw answer;
    let draft = answer;
    let feedback: string[] | null = null;
    for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt++) {
      if (attempt > 1) draft = await generate(lead, feedback);
      if (!draft) {
        feedback = ["reply with valid JSON containing a non-empty subject and body"];
        continue;
      }
      const issues = checkRules(draft, profile.links(), attached);
      if (!issues.length) return draft;
      log(`${lead.name ?? lead.id}: attempt ${attempt} rejected: ${issues.join("; ")}`);
      feedback = issues;
    }
    return null;
  }));
  return checked.map((r) => (r.status === "fulfilled" ? r.value : r.reason instanceof Error ? r.reason : new Error(String(r.reason))));
}
