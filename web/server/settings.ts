/**
 * The local dashboard's Settings API: the `app_settings` / `app_secrets` rows the daemon reads at start. Saving bumps
 * `app_settings.version`; the daemon notices within 5 s, finishes its work and restarts itself with the new settings
 * (and writes `applied_*` back, shown here). Going from dry run to send needs nothing here: the daemon deletes the
 * drafts itself.
 */
import { setClause } from "../../src/codec";
import { envPassword, lockKey, MIN_PASSWORD } from "../../src/api/auth";
import { fail, flag, json, numberField, ok, type Req, readBody, text } from "../../src/api/http";

const SECRETS: [key: string, label: string, help: string][] = [
  ["ai_api_key", "AI provider", "For the model above (Workers AI's key when Model is empty)"],
  ["jina_api_key", "Jina Reader", "Reads company websites"],
  ["serper_api_key", "Serper", "LinkedIn search"],
  ["telegram_bot_token", "Telegram bot token", "From @BotFather"],
  ["telegram_chat_id", "Telegram chat ID", "Where the bot posts"],
  ["gmail_client_id", "Gmail client ID", "Google Cloud OAuth client"],
  ["gmail_client_secret", "Gmail client secret", "For Gmail sending"],
  ["outlook_client_id", "Outlook client ID", "Microsoft Entra app"],
  ["outlook_client_secret", "Outlook client secret", "Only for a Web app"],
];
const DELIVERIES = ["telegram", "gmail", "outlook"];
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const raw = (s: Record<string, unknown>, key: string) => (s[key] === null || s[key] === undefined || s[key] === "" ? null : s[key]);

export async function getSettings(req: Req): Promise<Response> {
  const { db, host } = req;
  await db.run("INSERT OR IGNORE INTO app_settings (id) VALUES (1)");
  await db.run("INSERT OR IGNORE INTO app_secrets (id) VALUES (1)");
  const s = (await db.get<Record<string, unknown>>("SELECT * FROM app_settings WHERE id = 1")) ?? {};
  const k = (await db.get<Record<string, string | null>>("SELECT * FROM app_secrets WHERE id = 1")) ?? {};
  return json({
    host: "local",
    fields: {
      ai_model: raw(s, "ai_model"),
      cloudflare_account_id: raw(s, "cloudflare_account_id"),
      email_mode: s.email_mode === "send" ? "send" : "dry_run",
      email_delivery: DELIVERIES.includes(String(s.email_delivery)) ? s.email_delivery : "telegram",
      email_max_sends_per_day: raw(s, "email_max_sends_per_day"),
      email_enabled: s.email_enabled === null || s.email_enabled === undefined ? true : Boolean(s.email_enabled),
      email_instructions: raw(s, "email_instructions"),
    },
    defaultModel: "Cloudflare Gemma",
    secrets: SECRETS.map(([key, label, help]) => {
      const value = (k[key] ?? "").trim();
      return { key, label, help, set: !!value, last4: value ? value.slice(-4) : null };
    }),
    mailboxes: [],
    lock: { locked: (await lockKey(host.env, db)) !== null, fromSecret: envPassword(host.env) !== null, minLength: MIN_PASSWORD },
    meta: { version: Number(s.version ?? 1), updated_at: (s.updated_at as string | undefined) ?? null },
    daemon: { applied_version: s.applied_version ?? null, applied_at: s.applied_at ?? null, apply_error: s.apply_error ?? null },
  });
}

export async function saveSettings(req: Req): Promise<Response> {
  const body = await readBody(req);
  const errors: Record<string, string> = {};
  const short = (key: string, max: number) => {
    const v = text(body, key, max + 1);
    if (v.length > max) errors[key] = `At most ${max} characters.`;
    return v.slice(0, max) || null;
  };
  const sends = numberField(text(body, "email_max_sends_per_day"), { int: true, min: 1 });
  if ("error" in sends) errors.email_max_sends_per_day = sends.error;
  const delivery = text(body, "email_delivery");
  if (delivery && !DELIVERIES.includes(delivery)) errors.email_delivery = "Pick one of the options.";
  const mode = text(body, "email_mode");
  if (mode && !["dry_run", "send"].includes(mode)) errors.email_mode = "Pick one of the options.";
  const fields = {
    ai_model: short("ai_model", 200),
    cloudflare_account_id: short("cloudflare_account_id", 100),
    email_mode: mode === "send" ? "send" : "dry_run",
    email_delivery: DELIVERIES.includes(delivery) ? delivery : "telegram",
    email_max_sends_per_day: "value" in sends ? sends.value : null,
    email_enabled: flag(body, "email_enabled"),
    email_instructions: short("email_instructions", 2000),
  };
  if (Object.keys(errors).length) return fail("Some settings need fixing.", errors);
  const { sql, params } = setClause(fields);
  await req.db.batch([
    req.db.stmt("INSERT OR IGNORE INTO app_settings (id) VALUES (1)"),
    req.db.stmt(`UPDATE app_settings SET ${sql}, version = version + 1, updated_at = ${NOW} WHERE id = 1`, params),
  ]);
  return ok("Settings saved. The daemon restarts by itself to apply them.");
}

export async function saveSecret(req: Req): Promise<Response> {
  const body = await readBody(req);
  const key = text(body, "key");
  if (!SECRETS.some(([k]) => k === key)) return fail("Unknown key");
  const clear = flag(body, "clear");
  const value = text(body, "value", 1001);
  if (!clear) {
    if (!value) return fail("Paste the key first.", { value: "Required." });
    if (value.length > 1000 || /\s/.test(value)) return fail("That doesn't look like an API key.", { value: "No spaces, at most 1000 characters." });
  }
  await req.db.batch([
    req.db.stmt("INSERT OR IGNORE INTO app_secrets (id) VALUES (1)"),
    req.db.stmt(`UPDATE app_secrets SET ${key} = ?, updated_at = ${NOW} WHERE id = 1`, [clear ? null : value]),
    // the daemon reads the keys with the settings, at start
    req.db.stmt(`UPDATE app_settings SET version = version + 1, updated_at = ${NOW} WHERE id = 1`),
  ]);
  return ok(clear ? "Key cleared." : "Key saved. The daemon restarts by itself to use it.");
}
