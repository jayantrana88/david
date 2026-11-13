/**
 * What a button or form does: a POST to the API that answers with an ActionResult (`ok`, a message to toast,
 * and `fieldErrors` to show under the inputs). A success reloads whatever is on screen (`act` in ./api).
 */
import { act, actForm, api, invalidate } from "@/lib/api";
import type { ActionResult } from "@/lib/types";

type Prev = ActionResult;

// ── companies ───────────────────────────────────────────────────────────────────
export const updateWebsiteAction = (id: string, _: Prev, form: FormData) => actForm(`/api/websites/${id}/update`, form);
export const deleteWebsiteAction = (id: string) => act(`/api/websites/${id}/delete`);
export const websiteProgressAction = (id: string) =>
  api.get<{
    scrapes: { id: string; is_qualified: boolean | null; summary: string | null; created_at: string; website_pages: { count: number }[] }[];
    emails: { id: string; status: string; subject: string | null; sent_at: string | null }[];
  }>(`/api/websites/${id}/progress`);

// ── fit checks ──────────────────────────────────────────────────────────────────
export const setVerdictAction = (id: string, verdict: boolean | null) => act(`/api/scrapes/${id}/verdict`, { verdict });
export const deleteScrapeAction = (id: string) => act(`/api/scrapes/${id}/delete`);

// ── pages ───────────────────────────────────────────────────────────────────────
export const pageContentAction = (id: string) => api.get<{ content: unknown }>(`/api/pages/${id}/content`).then((r) => r.content ?? null);
export const rereadPagesAction = (scrapeId: string) => act("/api/pages/reread", { scrape_id: scrapeId });

// ── applications ────────────────────────────────────────────────────────────────
export const retryEmailAction = (id: string) => act(`/api/emails/${id}/retry`);

// ── tasks ───────────────────────────────────────────────────────────────────────
export const createTasksAction = (_: Prev, form: FormData) => actForm("/api/tasks", form, { repeat_daily: form.get("repeat_daily") === "on" });
export const updateTaskAction = (id: number, _: Prev, form: FormData) =>
  actForm(`/api/tasks/${id}/update`, form, { repeat_daily: form.get("repeat_daily") === "on" });
export const requeueTaskAction = (id: number) => act(`/api/tasks/${id}/requeue`);
export const stopTaskAction = (id: number) => act(`/api/tasks/${id}/stop`);
export const setTaskRepeatAction = (id: number, repeat: boolean) => act(`/api/tasks/${id}/repeat`, { repeat });
export const deleteTaskAction = (id: number) => act(`/api/tasks/${id}/delete`);

// ── profile ─────────────────────────────────────────────────────────────────────
export async function uploadResumeAction(_: Prev, form: FormData): Promise<ActionResult> {
  const file = form.get("resume");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a PDF or DOCX file first.", fieldErrors: { resume: "Required." } };
  }
  try {
    const result = await api.post<ActionResult>("/api/profile/resume", form);
    invalidate();
    return result;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}
export const saveNotesAction = (rederive: boolean, _: Prev, form: FormData) => actForm("/api/profile/notes", form, { rederive });
export const saveProfileAction = (_: Prev, form: FormData) => actForm("/api/profile/fields", form);

// ── settings ────────────────────────────────────────────────────────────────────
export const saveSettingsAction = (_: Prev, form: FormData) =>
  actForm("/api/settings", form, {
    email_enabled: form.get("email_enabled") === "on",
    email_attach_resume: form.get("email_attach_resume") === "on",
    paused: form.get("paused") === "on",
  });
export const setSecretAction = (key: string, _: Prev, form: FormData) => actForm("/api/settings/secret", form, { key });
export const clearSecretAction = (key: string) => act("/api/settings/secret", { key, clear: true });
export const setLockAction = (_: Prev, form: FormData) => actForm("/api/settings/password", form);
export const removeLockAction = (current: string) => act("/api/settings/password/remove", { current });
export const lockNowAction = () => act("/api/logout");
export const disconnectMailboxAction = (provider: string) => act(`/api/settings/mailbox/${provider}/disconnect`);
export const testSendAction = (_: Prev, form: FormData) => actForm("/api/settings/test-send", form);

// ── the password screen ─────────────────────────────────────────────────────────
export const unlockAction = (_: Prev, form: FormData) => actForm("/api/login", form);
