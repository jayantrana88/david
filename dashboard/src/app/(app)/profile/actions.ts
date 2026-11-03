"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { saveNotes, saveProfileFields, saveResume } from "@/lib/data/profile";
import { OPPORTUNITY_TYPES, type ActionResult } from "@/lib/types";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters.`)
    .transform((v) => v || null);

const list = (max: number, itemMax: number) =>
  z
    .string()
    .transform((v) => v.split(/[\n,;]/).map((s) => s.trim()).filter(Boolean))
    .refine((v) => v.length <= max, `At most ${max} entries.`)
    .refine((v) => v.every((s) => s.length <= itemMax), `Keep each entry under ${itemMax} characters.`);

const url = text(300).refine((v) => v === null || /^https?:\/\/\S+$/.test(v), "Use a full http(s):// link.");

const schema = z.object({
  full_name: text(200),
  headline: text(300),
  summary: text(2000),
  skills: list(30, 60),
  experience_years: z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 60) {
        ctx.addIssue({ code: "custom", message: "Enter a number from 0 to 60." });
        return z.NEVER;
      }
      return n;
    }),
  education: text(500),
  target_roles: list(5, 100),
  opportunity_type: z.enum(OPPORTUNITY_TYPES),
  phone: text(50),
  linkedin_url: url,
  portfolio_url: url,
});

function done(message: string): ActionResult {
  revalidatePath("/", "layout");
  return { ok: true, message };
}

const failed = (e: unknown): ActionResult => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong" });

export async function uploadResumeAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const file = form.get("resume");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a PDF or DOCX file first.", fieldErrors: { resume: "Required." } };
  }
  try {
    await saveResume(file, null);
    return done("Resume uploaded. The daemon reads it within a minute; reload to see your profile.");
  } catch (e) {
    return failed(e);
  }
}

export async function saveNotesAction(rederive: boolean, _: ActionResult, form: FormData): Promise<ActionResult> {
  const notes = String(form.get("career_notes") ?? "").trim();
  if (notes.length > 5000) return { ok: false, message: "Keep the notes under 5000 characters.", fieldErrors: { career_notes: "Too long." } };
  try {
    await saveNotes(notes, rederive);
    return done(rederive ? "Saved. The daemon is reading your resume and notes again." : "Notes saved.");
  } catch (e) {
    return failed(e);
  }
}

export async function saveProfileAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const input = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, String(form.get(k) ?? "")]));
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Some fields need fixing.",
      fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
    };
  }
  try {
    await saveProfileFields(parsed.data);
    return done("Profile saved.");
  } catch (e) {
    return failed(e);
  }
}
