"use server";

import { revalidatePath } from "next/cache";
import { deleteScrape, setVerdict } from "@/lib/data/leads";
import type { ActionResult } from "@/lib/types";

const LABEL = { true: "qualified", false: "not a fit", null: "awaiting AI" } as const;

export async function setVerdictAction(id: string, verdict: boolean | null): Promise<ActionResult> {
  try {
    await setVerdict(id, verdict);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: `Verdict set to ${LABEL[String(verdict) as keyof typeof LABEL]}.` };
}

export async function deleteScrapeAction(id: string): Promise<ActionResult> {
  try {
    await deleteScrape(id);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Scrape deleted. The scrape pool reads this website again." };
}
