"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createTasks, deleteTask, requeueTask, setTaskRepeat, updatePendingTask, type NewTask } from "@/lib/data/tasks";
import { MAX_TASKS_PER_SUBMIT } from "@/lib/constants";
import { OPPORTUNITY_TYPES, type ActionResult } from "@/lib/types";

const lines = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split(/[\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);

// The same limits as the `tasks` table's CHECK constraints (db/schema.sql).
const fields = z.object({
  candidates: z.coerce
    .number({ error: "Enter a number." })
    .int("Use a whole number.")
    .min(1, "At least 1.")
    .max(200, "At most 200."),
  metro_radius_km: z
    .union([z.literal(""), z.coerce.number({ error: "Enter a number." }).min(0, "0 or more.")])
    .transform((v) => (v === "" ? null : v)),
  max_employees: z.coerce
    .number({ error: "Enter a number." })
    .int("Use a whole number.")
    .min(1, "At least 1.")
    .max(100000, "At most 100000."),
  target_role: z
    .string()
    .trim()
    .max(200, "Keep it under 200 characters.")
    .transform((v) => v || null),
  opportunity_type: z.enum(["", ...OPPORTUNITY_TYPES]).transform((v) => (v === "" ? null : v)),
  repeat_daily: z.boolean(),
});

/** The task fields as the forms post them. */
const readFields = (form: FormData) =>
  fields.safeParse({
    candidates: form.get("candidates"),
    metro_radius_km: form.get("metro_radius_km") ?? "",
    max_employees: form.get("max_employees"),
    target_role: form.get("target_role") ?? "",
    opportunity_type: form.get("opportunity_type") ?? "",
    repeat_daily: form.get("repeat_daily") === "on",
  });
const text = z.string().max(200, "Keep it under 200 characters.");

function errors(error: z.ZodError): Record<string, string> {
  return Object.fromEntries(error.issues.map((i) => [String(i.path[0]), i.message]));
}

function done(message: string): ActionResult {
  revalidatePath("/", "layout");
  return { ok: true, message };
}

function failed(e: unknown): ActionResult {
  return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
}

export async function createTasksAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const categories = lines(form.get("categories"));
  const locations = lines(form.get("locations"));
  const parsed = readFields(form);

  const fieldErrors: Record<string, string> = parsed.success ? {} : errors(parsed.error);
  if (!categories.length) fieldErrors.categories = "Add at least one category.";
  if (!locations.length) fieldErrors.locations = "Add at least one location.";
  for (const [name, list] of [["categories", categories], ["locations", locations]] as const) {
    const bad = list.find((v) => !text.safeParse(v).success);
    if (bad) fieldErrors[name] = `"${bad.slice(0, 30)}…" is too long (200 characters at most).`;
  }
  if (Object.keys(fieldErrors).length || !parsed.success) {
    return { ok: false, message: "Check the highlighted fields.", fieldErrors };
  }
  const total = categories.length * locations.length;
  if (total > MAX_TASKS_PER_SUBMIT) {
    return {
      ok: false,
      message: `That's ${total} searches; add at most ${MAX_TASKS_PER_SUBMIT} at a time.`,
    };
  }

  const tasks: NewTask[] = categories.flatMap((category) =>
    locations.map((location) => ({ category, location, ...parsed.data })),
  );
  try {
    const created = await createTasks(tasks);
    return done(created === 1 ? "Task added. The daemon picks it up within 30 s." : `${created} tasks added. They run one at a time, oldest first.`);
  } catch (e) {
    return failed(e);
  }
}

export async function updateTaskAction(id: number, _: ActionResult, form: FormData): Promise<ActionResult> {
  const category = String(form.get("category") ?? "").trim();
  const location = String(form.get("location") ?? "").trim();
  const parsed = readFields(form);
  const fieldErrors: Record<string, string> = parsed.success ? {} : errors(parsed.error);
  if (!category) fieldErrors.category = "Required.";
  if (!location) fieldErrors.location = "Required.";
  if (!text.safeParse(category).success) fieldErrors.category = "At most 200 characters.";
  if (!text.safeParse(location).success) fieldErrors.location = "At most 200 characters.";
  if (Object.keys(fieldErrors).length || !parsed.success) {
    return { ok: false, message: "Check the highlighted fields.", fieldErrors };
  }
  try {
    const ok = await updatePendingTask(id, { category, location, ...parsed.data });
    if (!ok) return { ok: false, message: `Task #${id} has already started, so it can't be edited.` };
    return done(`Task #${id} updated.`);
  } catch (e) {
    return failed(e);
  }
}

export async function requeueTaskAction(id: number): Promise<ActionResult> {
  try {
    const ok = await requeueTask(id);
    if (!ok) return { ok: false, message: `Task #${id} can't be re-run: only a completed or failed task can.` };
    return done(`Task #${id} is queued again. Leads it already saved are skipped.`);
  } catch (e) {
    return failed(e);
  }
}

export async function setTaskRepeatAction(id: number, repeat: boolean): Promise<ActionResult> {
  try {
    const ok = await setTaskRepeat(id, repeat);
    if (!ok) return { ok: false, message: `Task #${id} no longer exists.` };
    return done(repeat ? `Task #${id} will run again every day.` : `Task #${id} won't repeat.`);
  } catch (e) {
    return failed(e);
  }
}

export async function deleteTaskAction(id: number): Promise<ActionResult> {
  try {
    const ok = await deleteTask(id);
    if (!ok) return { ok: false, message: `Task #${id} is running, so it can't be deleted.` };
    return done(`Task #${id} deleted.`);
  } catch (e) {
    return failed(e);
  }
}
