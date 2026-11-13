/** The Profile page's API: the resume, the career notes, and the fields the AI derived (editable). */
import { setClause } from "../codec";
import { sha256Hex } from "../util";
import { fail, flag, json, numberField, ok, type Req, readBody, text } from "./http";

const RESUME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export async function getProfile(req: Req): Promise<Response> {
  // resume_text is the whole resume as text: the page never shows it
  const profile = await req.db.get(
    `SELECT resume_path, resume_filename, resume_mime, career_notes, full_name, headline, summary, skills, experience_years, education,
            target_roles, opportunity_type, phone, linkedin_url, portfolio_url, parse_status, parse_error, parsed_at, updated_at
     FROM candidate_profile WHERE id = 1`,
  );
  return json({ profile: profile ?? null, maxResumeMb: req.host.maxResumeBytes / 1_000_000 });
}

async function upsert(req: Req, fields: Record<string, unknown>) {
  const { sql, params } = setClause(fields);
  await req.db.batch([
    req.db.stmt("INSERT OR IGNORE INTO candidate_profile (id) VALUES (1)"),
    req.db.stmt(`UPDATE candidate_profile SET ${sql} WHERE id = 1`, params),
  ]);
}

export async function uploadResume(req: Req): Promise<Response> {
  let file: unknown;
  try {
    file = (await req.request.formData()).get("resume");
  } catch {
    return fail("Choose a PDF or DOCX file first.", { resume: "Required." });
  }
  if (!(file instanceof File) || file.size === 0) return fail("Choose a PDF or DOCX file first.", { resume: "Required." });
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(ext in RESUME_TYPES)) return fail("Upload a PDF or DOCX file.");
  if (file.size > req.host.maxResumeBytes) {
    return fail(`The file is over ${req.host.maxResumeBytes / 1_000_000} MB; export a lighter PDF.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = await sha256Hex(bytes);
  const filename = file.name.slice(0, 200);
  const path = await req.host.saveResume({ bytes, filename, mime: RESUME_TYPES[ext], sha, ext });
  await upsert(req, {
    resume_path: path,
    resume_filename: filename,
    resume_mime: RESUME_TYPES[ext],
    resume_sha256: sha,
    parse_status: "pending",
    parse_error: null,
  });
  await req.host.wake("profile");
  return ok("Resume uploaded. It is read within a minute or two; this page updates by itself.");
}

export async function downloadResume(req: Req): Promise<Response> {
  const resume = await req.host.readResume();
  if (!resume) return new Response("No resume uploaded.", { status: 404 });
  return new Response(resume.bytes, {
    headers: {
      "Content-Type": resume.mime,
      "Content-Disposition": `inline; filename="${resume.filename.replace(/["\\\r\n]/g, "")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function saveNotes(req: Req): Promise<Response> {
  const body = await readBody(req);
  const notes = text(body, "career_notes", 6000);
  if (notes.length > 5000) return fail("Keep the notes under 5000 characters.", { career_notes: "Too long." });
  const rederive = flag(body, "rederive");
  await upsert(req, rederive ? { career_notes: notes || null, parse_status: "pending", parse_error: null } : { career_notes: notes || null });
  if (rederive) await req.host.wake("profile");
  return ok(rederive ? "Saved. Your resume and notes are being read again." : "Notes saved.");
}

export async function saveFields(req: Req): Promise<Response> {
  const body = await readBody(req);
  const errors: Record<string, string> = {};
  const short = (key: string, max: number) => {
    const v = text(body, key, max + 1);
    if (v.length > max) errors[key] = `At most ${max} characters.`;
    return v || null;
  };
  const list = (key: string, max: number, itemMax: number) => {
    const items = text(body, key, 20000).split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
    if (items.length > max) errors[key] = `At most ${max} entries.`;
    else if (items.some((s) => s.length > itemMax)) errors[key] = `Keep each entry under ${itemMax} characters.`;
    return items;
  };
  const url = (key: string) => {
    const v = short(key, 300);
    if (v && !/^https?:\/\/\S+$/.test(v)) errors[key] = "Use a full http(s):// link.";
    return v;
  };
  const years = numberField(text(body, "experience_years"), { min: 0, max: 60 });
  if ("error" in years) errors.experience_years = "Enter a number from 0 to 60.";
  const kind = text(body, "opportunity_type");
  if (!["job", "internship", "either"].includes(kind)) errors.opportunity_type = "Pick one of the options.";
  const fields = {
    full_name: short("full_name", 200),
    headline: short("headline", 300),
    summary: short("summary", 2000),
    skills: list("skills", 30, 60),
    experience_years: "value" in years ? years.value : null,
    education: short("education", 500),
    target_roles: list("target_roles", 5, 100),
    opportunity_type: kind,
    phone: short("phone", 50),
    linkedin_url: url("linkedin_url"),
    portfolio_url: url("portfolio_url"),
  };
  if (Object.keys(errors).length) return fail("Some fields need fixing.", errors);
  // edited by hand counts as done: the other stages start
  await upsert(req, { ...fields, parse_status: "done", parse_error: null });
  await req.host.wake("scrape", "email");
  return ok("Profile saved.");
}
