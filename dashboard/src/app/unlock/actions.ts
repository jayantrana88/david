"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  LOCK_COOKIE,
  LOCK_COOKIE_MAX_AGE,
  lockHash,
  recordGuess,
  sessionToken,
  verifyPassword,
  waitSeconds,
} from "@/lib/lock";
import type { ActionResult } from "@/lib/types";

export async function unlockAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const hash = lockHash();
  if (!hash) redirect("/");
  const wait = waitSeconds();
  if (wait > 0) return { ok: false, message: `Too many wrong passwords. Try again in ${wait} seconds.` };
  const ok = verifyPassword(String(form.get("password") ?? ""), hash);
  recordGuess(ok);
  if (!ok) return { ok: false, message: "Wrong password." };
  (await cookies()).set(LOCK_COOKIE, sessionToken(hash), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: LOCK_COOKIE_MAX_AGE,
  });
  redirect("/");
}
