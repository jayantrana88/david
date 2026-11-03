"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { saveSettings, SECRET_KEYS, setSecret, type SecretKey } from "@/lib/data/settings";
import {
  LOCK_COOKIE,
  LOCK_COOKIE_MAX_AGE,
  lockHash,
  MIN_PASSWORD_LENGTH,
  removePassword,
  sessionToken,
  setPassword,
} from "@/lib/lock";
import { EMAIL_DELIVERIES, type ActionResult } from "@/lib/types";

// Empty means "not set here" (NULL): the daemon uses config.py's default.
// Limits mirror utils/config_schema.py and the CHECK constraints in db/schema.sql.
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters.`)
    .transform((v) => v || null);

const number = (opts: { min?: number; max?: number; int?: boolean; gt?: number }) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: "Enter a number." });
        return z.NEVER;
      }
      if (opts.int && !Number.isInteger(n)) ctx.addIssue({ code: "custom", message: "Use a whole number." });
      if (opts.min !== undefined && n < opts.min) ctx.addIssue({ code: "custom", message: `At least ${opts.min}.` });
      if (opts.gt !== undefined && n <= opts.gt) ctx.addIssue({ code: "custom", message: `Must be more than ${opts.gt}.` });
      if (opts.max !== undefined && n > opts.max) ctx.addIssue({ code: "custom", message: `At most ${opts.max}.` });
      return n;
    });

const schema = z.object({
  ai_model: text(200),
  cloudflare_account_id: text(100),
  email_delivery: z.enum(EMAIL_DELIVERIES),
  email_max_sends_per_day: number({ min: 1, int: true }),
  email_instructions: text(2000),
});

export async function saveSettingsAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const input = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, String(form.get(k) ?? "")]));
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Some settings need fixing.",
      fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
    };
  }
  try {
    await saveSettings(parsed.data);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Settings saved. The daemon restarts by itself to apply them." };
}

function asKey(key: string): SecretKey {
  if (!(SECRET_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown key ${key}`);
  return key as SecretKey;
}

export async function setSecretAction(key: string, _: ActionResult, form: FormData): Promise<ActionResult> {
  const value = String(form.get("value") ?? "").trim();
  if (!value) return { ok: false, message: "Paste the key first.", fieldErrors: { value: "Required." } };
  if (value.length > 1000 || /\s/.test(value)) {
    return { ok: false, message: "That doesn't look like an API key.", fieldErrors: { value: "No spaces, at most 1000 characters." } };
  }
  try {
    await setSecret(asKey(key), value);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Key saved. The daemon restarts by itself to use it." };
}

export async function clearSecretAction(key: string): Promise<ActionResult> {
  try {
    await setSecret(asKey(key), null);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Key cleared." };
}

// The optional dashboard password (src/lib/lock.ts). It isn't a daemon setting, so it doesn't restart it.
export async function setLockAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const password = String(form.get("password") ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
      fieldErrors: { password: `At least ${MIN_PASSWORD_LENGTH} characters.` },
    };
  }
  if (password.length > 200) return { ok: false, message: "At most 200 characters.", fieldErrors: { password: "Too long." } };
  try {
    setPassword(password);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  // This browser stays signed in; every other one has to enter the new password.
  const hash = lockHash();
  if (hash) {
    (await cookies()).set(LOCK_COOKIE, sessionToken(hash), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: LOCK_COOKIE_MAX_AGE,
    });
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Password saved." };
}

export async function removeLockAction(): Promise<ActionResult> {
  try {
    removePassword();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  (await cookies()).delete(LOCK_COOKIE);
  revalidatePath("/", "layout");
  return { ok: true, message: "Password removed. The dashboard is open." };
}

export async function lockNowAction(): Promise<ActionResult> {
  (await cookies()).delete(LOCK_COOKIE);
  revalidatePath("/", "layout");
  return { ok: true, message: "Locked." };
}
