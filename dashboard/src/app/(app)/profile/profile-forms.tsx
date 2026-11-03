"use client";

import { useActionState } from "react";
import { toast } from "sonner";
import { FileText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/form";
import { StatusBadge, type Tone } from "@/components/status-badge";
import type { ActionResult, CandidateProfile } from "@/lib/types";
import { saveNotesAction, saveProfileAction, uploadResumeAction } from "./actions";

const card = "rounded-xl border bg-card shadow-card";

function useAction(fn: (prev: ActionResult, form: FormData) => Promise<ActionResult>) {
  return useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await fn(prev, form);
    if (result?.ok) toast.success(result.message);
    else if (result && !result.fieldErrors) toast.error(result.message);
    return result;
  }, null);
}

const STATUS: Record<string, [Tone, string]> = {
  pending: ["info", "Reading your resume…"],
  done: ["success", "Ready"],
  failed: ["danger", "Could not read it"],
};

export function ProfileForms({ profile }: { profile: CandidateProfile | null }) {
  const [uploadState, upload, uploading] = useAction(uploadResumeAction);
  const [notesState, saveNotes, savingNotes] = useAction(saveNotesAction.bind(null, false));
  const [rederiveState, rederive, rederiving] = useAction(saveNotesAction.bind(null, true));
  const [fieldsState, saveFields, savingFields] = useAction(saveProfileAction);

  const status = profile?.parse_status ? STATUS[profile.parse_status] : null;
  const err = fieldsState?.fieldErrors ?? {};
  const hasProfile = profile?.parse_status === "done" || profile?.parse_status === "failed";

  return (
    <div className="space-y-6">
      {/* resume + notes */}
      <div className={card}>
        <div className="flex items-center justify-between gap-4 border-b px-6 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">Resume and notes</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">PDF or DOCX, up to 5 MB. It is attached to every email.</p>
          </div>
          {status && <StatusBadge tone={status[0]} pulse={profile?.parse_status === "pending"}>{status[1]}</StatusBadge>}
        </div>

        <div className="grid gap-6 p-6 md:grid-cols-2">
          <form action={upload} className="space-y-3">
            <Field
              label="Resume"
              htmlFor="resume"
              error={uploadState?.fieldErrors?.resume}
              hint={
                profile?.resume_filename ? (
                  <span className="inline-flex items-center gap-1.5">
                    <FileText className="size-3.5" /> Current file:{" "}
                    <a href="/profile/resume" target="_blank" rel="noreferrer" className="underline underline-offset-2">{profile.resume_filename}</a>. Uploading another replaces it and
                    re-reads your profile (hand edits below are overwritten).
                  </span>
                ) : (
                  "No resume yet."
                )
              }
            >
              <input id="resume" name="resume" type="file" required className="input h-auto py-2" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
            </Field>
            <Button type="submit" className="h-9 px-4" disabled={uploading}>
              {uploading ? "Uploading…" : profile?.resume_filename ? "Replace resume" : "Upload resume"}
            </Button>
          </form>

          <form className="space-y-3">
            <Field
              label="About your career"
              htmlFor="career_notes"
              optional
              error={notesState?.fieldErrors?.career_notes ?? rederiveState?.fieldErrors?.career_notes}
              hint="Anything the resume doesn't say: what you want to do next, the kind of company you like, internship or job. These win over the resume where they disagree."
            >
              <textarea id="career_notes" name="career_notes" rows={5} defaultValue={profile?.career_notes ?? ""} className="input" maxLength={5000} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" formAction={rederive} className="h-9 gap-1.5 px-4" disabled={rederiving}>
                <RefreshCw className="size-4" /> {rederiving ? "Saving…" : "Save and re-read profile"}
              </Button>
              <Button type="submit" formAction={saveNotes} variant="outline" className="h-9 px-3.5" disabled={savingNotes}>
                Save notes only
              </Button>
            </div>
          </form>
        </div>

        {profile?.parse_status === "failed" && profile.parse_error && (
          <p className="border-t px-6 py-3 text-[13px] text-danger">{profile.parse_error}</p>
        )}
      </div>

      {/* the derived profile */}
      <form action={saveFields} className={card} key={profile?.updated_at ?? "none"}>
        <div className="border-b px-6 py-4">
          <h2 className="text-[15px] font-semibold">Your profile</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {hasProfile
              ? "Read from your resume. Fix anything that's wrong: the emails and the fit check use exactly this."
              : "Appears here once your resume has been read. You can also fill it in by hand."}
          </p>
        </div>

        <div className="grid gap-5 p-6 sm:grid-cols-2">
          <Field label="Full name" htmlFor="full_name" error={err.full_name} hint="Signs the emails.">
            <input id="full_name" name="full_name" defaultValue={profile?.full_name ?? ""} className="input" />
          </Field>
          <Field label="Looking for" htmlFor="opportunity_type" error={err.opportunity_type}>
            <select id="opportunity_type" name="opportunity_type" defaultValue={profile?.opportunity_type ?? "either"} className="input">
              <option value="job">A job</option>
              <option value="internship">An internship</option>
              <option value="either">Either</option>
            </select>
          </Field>
          <Field label="Headline" htmlFor="headline" error={err.headline} className="sm:col-span-2">
            <input id="headline" name="headline" defaultValue={profile?.headline ?? ""} className="input" />
          </Field>
          <Field label="Summary" htmlFor="summary" error={err.summary} className="sm:col-span-2">
            <textarea id="summary" name="summary" rows={3} defaultValue={profile?.summary ?? ""} className="input" />
          </Field>
          <Field label="Roles to apply for" htmlFor="target_roles" error={err.target_roles} hint="One per line, up to 5. A task can override these.">
            <textarea id="target_roles" name="target_roles" rows={3} defaultValue={(profile?.target_roles ?? []).join("\n")} className="input" />
          </Field>
          <Field label="Skills" htmlFor="skills" error={err.skills} hint="Comma or line separated.">
            <textarea id="skills" name="skills" rows={3} defaultValue={(profile?.skills ?? []).join(", ")} className="input" />
          </Field>
          <Field label="Years of experience" htmlFor="experience_years" optional error={err.experience_years}>
            <input id="experience_years" name="experience_years" type="number" min={0} max={60} step="any" defaultValue={profile?.experience_years ?? ""} className="input tabular" />
          </Field>
          <Field label="Education" htmlFor="education" optional error={err.education}>
            <input id="education" name="education" defaultValue={profile?.education ?? ""} className="input" />
          </Field>
          <Field label="Phone" htmlFor="phone" optional error={err.phone} hint="Added under your name in each email.">
            <input id="phone" name="phone" defaultValue={profile?.phone ?? ""} className="input" />
          </Field>
          <Field label="LinkedIn" htmlFor="linkedin_url" optional error={err.linkedin_url} hint="The only links an email may carry are these two.">
            <input id="linkedin_url" name="linkedin_url" type="url" defaultValue={profile?.linkedin_url ?? ""} className="input" />
          </Field>
          <Field label="Portfolio or GitHub" htmlFor="portfolio_url" optional error={err.portfolio_url}>
            <input id="portfolio_url" name="portfolio_url" type="url" defaultValue={profile?.portfolio_url ?? ""} className="input" />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-b-xl border-t bg-subtle px-6 py-4">
          <p className="text-[13px] text-muted-foreground">Saved changes apply to the next email the daemon writes; no restart needed.</p>
          <Button type="submit" className="h-9 px-4" disabled={savingFields}>
            {savingFields ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </form>
    </div>
  );
}
