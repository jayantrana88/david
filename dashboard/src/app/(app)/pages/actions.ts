"use server";

import { revalidatePath } from "next/cache";
import { deletePagesOfScrape, pageContent } from "@/lib/data/leads";
import type { ActionResult } from "@/lib/types";

export async function pageContentAction(id: string) {
  return pageContent(id);
}

export async function rereadPagesAction(scrapeId: string): Promise<ActionResult> {
  try {
    const n = await deletePagesOfScrape(scrapeId);
    revalidatePath("/", "layout");
    return { ok: true, message: `${n} page${n === 1 ? "" : "s"} deleted. The internal pool reads this lead's pages again.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
