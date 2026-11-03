/**
 * The candidate: the one `candidate_profile` row, as the stages use it (stages/profile/models.py). The
 * scrape and email stages load it at every tick and do nothing until it is ready.
 */
import type { Db } from "./db";

const OPPORTUNITY_WORDS: Record<string, string> = { job: "job", internship: "internship", either: "job or internship" };

const txt = (row: Record<string, unknown>, key: string) => String(row[key] ?? "").trim();
const lst = (row: Record<string, unknown>, key: string): string[] => {
  const v = row[key];
  return Array.isArray(v) ? v.map((i) => String(i ?? "").trim()).filter(Boolean) : [];
};

export class CandidateProfile {
  full_name = "";
  headline = "";
  summary = "";
  skills: string[] = [];
  experience_years: number | null = null;
  education = "";
  target_roles: string[] = [];
  opportunity_type = "either";
  phone = "";
  linkedin_url = "";
  portfolio_url = "";
  career_notes = "";
  resume_path = "";
  resume_filename = "";
  resume_mime = "";
  resume_sha256 = "";
  parse_status = "";
  updated_at = "";

  static fromRow(row: Record<string, unknown>): CandidateProfile {
    const p = new CandidateProfile();
    for (const key of ["full_name", "headline", "summary", "education", "phone", "linkedin_url", "portfolio_url", "career_notes",
      "resume_path", "resume_filename", "resume_mime", "resume_sha256", "parse_status", "updated_at"] as const) {
      p[key] = txt(row, key);
    }
    p.skills = lst(row, "skills");
    p.target_roles = lst(row, "target_roles");
    p.opportunity_type = txt(row, "opportunity_type") || "either";
    const years = row.experience_years;
    p.experience_years = years === null || years === undefined ? null : Number(years);
    return p;
  }

  /** Derived at least once and usable for writing applications. */
  get ready(): boolean {
    return this.parse_status === "done" && (this.target_roles.length > 0 || !!this.headline);
  }

  roleFor(targetRole?: string | null): string {
    if (targetRole) return targetRole;
    const roles = this.target_roles.slice(0, 3);
    return roles.length ? roles.join(" or ") : this.headline || "a role that fits my background";
  }

  opportunityFor(opportunityType?: string | null): string {
    return OPPORTUNITY_WORDS[opportunityType || this.opportunity_type] ?? "job or internship";
  }

  /** What the candidate asks one company about, e.g. 'Backend Developer (internship)'. */
  seeking(targetRole?: string | null, opportunityType?: string | null): string {
    return `${this.roleFor(targetRole)} (${this.opportunityFor(opportunityType)})`;
  }

  /** The only links an application may carry. */
  links(): string[] {
    return [this.linkedin_url, this.portfolio_url].filter(Boolean);
  }

  /** The candidate in a few lines, for the prompts. Only what's filled in. */
  brief(): string {
    const fmt = (n: number) => String(Number(n.toPrecision(6)));
    const lines: [string, string][] = [
      ["Name", this.full_name], ["Headline", this.headline], ["Background", this.summary],
      ["Skills", this.skills.slice(0, 15).join(", ")],
      ["Experience", this.experience_years !== null ? `${fmt(this.experience_years)} years` : ""],
      ["Education", this.education], ["Roles wanted", this.target_roles.join(", ")],
      ["Looking for", this.opportunityFor()], ["In their own words", this.career_notes.slice(0, 800)],
    ];
    return lines.filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  }
}

export async function loadProfile(db: Db): Promise<CandidateProfile | null> {
  const row = await db.get("SELECT * FROM candidate_profile WHERE id = 1");
  return row ? CandidateProfile.fromRow(row) : null;
}

/** The profile when it is ready to use, else null with the reason (shown as the stage's note). */
export async function readyProfile(db: Db): Promise<{ profile: CandidateProfile | null; why: string }> {
  const profile = await loadProfile(db);
  if (!profile) return { profile: null, why: "no candidate profile yet: upload a resume on the Profile page" };
  if (!profile.ready) {
    return {
      profile: null,
      why: `the candidate profile is '${profile.parse_status || "empty"}', not ready yet${profile.parse_status === "pending" ? " (waiting for the profile stage)" : ""}`,
    };
  }
  return { profile, why: "" };
}

/** The resume file as base64, with its name and type, or null. */
export async function loadResume(db: Db, profile: CandidateProfile): Promise<{ filename: string; mime: string; base64: string } | null> {
  if (!profile.resume_sha256) return null;
  const row = await db.get<{ filename: string; mime: string; base64: string }>(
    "SELECT filename, mime, base64 FROM resume_files WHERE sha256 = ?", [profile.resume_sha256]);
  return row ? { filename: profile.resume_filename || row.filename, mime: row.mime, base64: row.base64 } : null;
}
