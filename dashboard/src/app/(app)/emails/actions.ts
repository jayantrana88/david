"use server";

import { revalidatePath } from "next/cache";
import { retryEmail } from "@/lib/data/leads";
import type { ActionResult } from "@/lib/types";

export async function retryEmailAction(id: string): Promise<ActionResult> {
  try {
    const ok = await retryEmail(id);
    if (!ok) return { ok: false, message: "This email can't be retried: it was sent, or is being sent." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Cleared. The email pool writes this lead a new email." };
}
