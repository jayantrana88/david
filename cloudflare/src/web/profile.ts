/** The Profile page: upload the resume, write career notes, edit what the AI derived. */
import { wake } from "../core";
import { setClause } from "../db";
import { base64ToBytes, bytesToBase64, sha256Hex } from "../util";
import { flashOf, formText, type Req, redirect } from "./common";
import { badge, html, layout, raw, when } from "./html";

// D1 holds rows up to 2 MB, and the resume is stored as base64 (4/3 of its size)
export const MAX_RESUME_BYTES = 1_400_000;
const RESUME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

type Profile = Record<string, unknown> & {
  parse_status: string | null; parse_error: string | null; parsed_at: string | null; resume_filename: string | null;
  skills: string[]; target_roles: string[]; opportunity_type: string; updated_at: string;
};

export async function profilePage(req: Req): Promise<Response> {
  const p = await req.db.get<Profile>("SELECT * FROM candidate_profile WHERE id = 1");
  const v = (k: string) => (p?.[k] === null || p?.[k] === undefined ? "" : String(p[k]));
  const status = p?.parse_status ?? null;
  const body = html`
<div class="panel"><div class="row"><b>Status</b> ${status ? badge(status === "done" ? "ready" : status) : badge("empty")}
${p?.parsed_at ? html`<span class="muted small">read ${when(p.parsed_at)}</span>` : ""}</div>
${p?.parse_error ? html`<p class="flash bad">${p.parse_error}</p>` : ""}
${status === "pending" ? html`<p class="muted small">The profile stage reads it at the next tick (within a minute or two). Reload to see the result.</p>` : ""}</div>

<h2>Resume</h2>
<div class="panel">
${p?.resume_filename ? html`<p>Current: <a href="/profile/resume">${p.resume_filename}</a></p>` : html`<p class="muted">No resume yet.</p>`}
<form method="post" action="/profile/resume" enctype="multipart/form-data" class="row">
<input type="file" name="resume" accept=".pdf,.docx" required style="max-width:360px"><button class="primary">Upload</button></form>
<p class="muted small">PDF or DOCX, up to 1.4 MB. It is attached to every application, and read once into your profile below.</p></div>

<h2>Your notes</h2>
<form method="post" action="/profile/notes" class="panel">
<label>Anything the resume doesn't say: what you want, where, when you can start…</label>
<textarea name="career_notes" maxlength="5000">${v("career_notes")}</textarea>
<p class="row"><button name="rederive" value="0">Save</button><button class="primary" name="rederive" value="1">Save and read my profile again</button></p></form>

<h2>Profile</h2>
<form method="post" action="/profile/fields" class="panel">
<p class="muted small">Filled in from your resume and notes; edit anything. Saving marks the profile ready, so the other stages start.</p>
<div class="cols">
<div><label>Full name</label><input name="full_name" value="${v("full_name")}" maxlength="200"></div>
<div><label>Headline</label><input name="headline" value="${v("headline")}" maxlength="300"></div>
<div><label>Target roles (one per line, up to 5)</label><textarea name="target_roles">${(p?.target_roles ?? []).join("\n")}</textarea></div>
<div><label>Skills (one per line or comma separated)</label><textarea name="skills">${(p?.skills ?? []).join("\n")}</textarea></div>
<div><label>Looking for</label><select name="opportunity_type">${["either", "job", "internship"].map((o) => html`<option ${o === (p?.opportunity_type ?? "either") ? raw("selected") : ""}>${o}</option>`)}</select></div>
<div><label>Years of experience</label><input name="experience_years" type="number" min="0" max="60" step="any" value="${v("experience_years")}"></div>
<div><label>Education</label><input name="education" value="${v("education")}" maxlength="500"></div>
<div><label>Phone (in the signature)</label><input name="phone" value="${v("phone")}" maxlength="50"></div>
<div><label>LinkedIn URL</label><input name="linkedin_url" value="${v("linkedin_url")}" maxlength="300"></div>
<div><label>Portfolio / GitHub URL</label><input name="portfolio_url" value="${v("portfolio_url")}" maxlength="300"></div>
</div>
<label>Summary</label><textarea name="summary" maxlength="2000">${v("summary")}</textarea>
<p><button class="primary">Save profile</button></p></form>`;
  return layout("Profile", "/profile", body, flashOf(req.url));
}

async function upsert(req: Req, fields: Record<string, unknown>) {
  const { sql, params } = setClause(fields);
  await req.db.batch([
    req.db.stmt("INSERT OR IGNORE INTO candidate_profile (id) VALUES (1)"),
    req.db.stmt(`UPDATE candidate_profile SET ${sql} WHERE id = 1`, params),
  ]);
}

export async function uploadResume(req: Req): Promise<Response> {
  const form = await req.request.formData();
  const file = form.get("resume") as unknown;
  if (!(file instanceof File) || file.size === 0) return redirect("/profile", "Choose a PDF or DOCX file first.", false);
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!(ext in RESUME_TYPES)) return redirect("/profile", "Upload a PDF or DOCX file.", false);
  if (file.size > MAX_RESUME_BYTES) return redirect("/profile", "The file is over 1.4 MB (the database's row limit); export a lighter PDF.", false);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = await sha256Hex(bytes);
  const old = await req.db.get<{ resume_sha256: string | null }>("SELECT resume_sha256 FROM candidate_profile WHERE id = 1");
  await req.db.run("INSERT OR REPLACE INTO resume_files (sha256, filename, mime, size, base64) VALUES (?, ?, ?, ?, ?)",
    [sha, file.name.slice(0, 200), RESUME_TYPES[ext], file.size, bytesToBase64(bytes)]);
  await upsert(req, {
    resume_path: sha, resume_filename: file.name.slice(0, 200), resume_mime: RESUME_TYPES[ext], resume_sha256: sha,
    parse_status: "pending", parse_error: null,
  });
  if (old?.resume_sha256 && old.resume_sha256 !== sha) await req.db.run("DELETE FROM resume_files WHERE sha256 = ?", [old.resume_sha256]);
  await wake(req.db, "profile");
  return redirect("/profile", "Resume uploaded. The profile stage reads it within a minute or two; reload to see your profile.");
}

export async function downloadResume(req: Req): Promise<Response> {
  const row = await req.db.get<{ filename: string; mime: string; base64: string }>(
    "SELECT f.filename, f.mime, f.base64 FROM candidate_profile p JOIN resume_files f ON f.sha256 = p.resume_sha256 WHERE p.id = 1");
  if (!row) return new Response("No resume", { status: 404 });
  return new Response(base64ToBytes(row.base64), {
    headers: { "Content-Type": row.mime, "Content-Disposition": `inline; filename="${row.filename.replace(/["\\\r\n]/g, "")}"`, "Cache-Control": "no-store" },
  });
}

export async function saveNotes(req: Req): Promise<Response> {
  const form = await req.request.formData();
  const notes = formText(form, "career_notes", 5000);
  const rederive = form.get("rederive") === "1";
  await upsert(req, rederive ? { career_notes: notes || null, parse_status: "pending", parse_error: null } : { career_notes: notes || null });
  if (rederive) await wake(req.db, "profile");
  return redirect("/profile", rederive ? "Saved. The profile stage reads your resume and notes again." : "Notes saved.");
}

export async function saveFields(req: Req): Promise<Response> {
  const form = await req.request.formData();
  const list = (k: string, max: number, itemMax: number) => formText(form, k, 5000).split(/[\n,;]/).map((s) => s.trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, itemMax));
  const url = (k: string) => {
    const v = formText(form, k, 300);
    return v && !/^https?:\/\/\S+$/.test(v) ? undefined : v || null;
  };
  const years = formText(form, "experience_years");
  const yearsNum = years === "" ? null : Number(years);
  if (yearsNum !== null && (!Number.isFinite(yearsNum) || yearsNum < 0 || yearsNum > 60)) return redirect("/profile", "Years of experience: a number from 0 to 60.", false);
  const linkedin = url("linkedin_url");
  const portfolio = url("portfolio_url");
  if (linkedin === undefined || portfolio === undefined) return redirect("/profile", "Use full http(s):// links.", false);
  const kind = formText(form, "opportunity_type");
  await upsert(req, {
    full_name: formText(form, "full_name", 200) || null, headline: formText(form, "headline", 300) || null,
    summary: formText(form, "summary", 2000) || null, skills: list("skills", 30, 60), target_roles: list("target_roles", 5, 100),
    experience_years: yearsNum, education: formText(form, "education", 500) || null,
    opportunity_type: ["job", "internship", "either"].includes(kind) ? kind : "either",
    phone: formText(form, "phone", 50) || null, linkedin_url: linkedin, portfolio_url: portfolio,
    parse_status: "done", parse_error: null,      // edited by hand counts as done: the other stages start
  });
  await wake(req.db, "scrape", "email");
  return redirect("/profile", "Profile saved.");
}
