"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { deleteWebsite, updateWebsite, websiteProgress } from "@/lib/data/leads";
import type { ActionResult } from "@/lib/types";

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters.`)
    .transform((v) => v || null);

const schema = z.object({
  // The scrape pool stores several addresses comma-separated; the email pool picks a usable one.
  email: optional(500).refine(
    (v) => v === null || v.split(",").every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())),
    "Use valid addresses, separated by commas.",
  ),
  phone_number: optional(50),
  owner: optional(200),
});

export async function updateWebsiteAction(id: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  const parsed = schema.safeParse({
    email: form.get("email") ?? "",
    phone_number: form.get("phone_number") ?? "",
    owner: form.get("owner") ?? "",
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: "Check the highlighted fields.",
      fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
    };
  }
  try {
    await updateWebsite(id, parsed.data);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Lead updated." };
}

export async function deleteWebsiteAction(id: string): Promise<ActionResult> {
  try {
    await deleteWebsite(id);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Lead deleted." };
}

export async function websiteProgressAction(id: string) {
  return websiteProgress(id);
}
