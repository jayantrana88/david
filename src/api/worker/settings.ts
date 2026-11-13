/**
 * The Worker's Settings API (app_settings / app_secrets) and the Gmail / Outlook sign-in.
 * Saved settings apply at the next tick (nothing to restart); saving clears every stage's hold and idle mark, so
 * a fixed key is tried at once. Going from dry run to send deletes the drafts, so those companies get a real application.
 */
import { loadProfile, loadResume } from "../../candidate";
import { STAGES, wake } from "../../core";
import { setClause } from "../../db";
import { GMAIL, OUTLOOK, oauthClient, type Provider } from "../../mail/oauth";
import { configFrom, DEFAULT_AI_MODEL, loadConfig } from "../../settings";
import { makeMailer } from "../../stages/email";
import { base64url, base64urlDecode, parseJson, randomToken } from "../../util";
import { cookieValue, envPassword, lockKey, MIN_PASSWORD, sign, signingKey, unsign } from "../auth";
import { fail, flag, json, numberField, ok, readBody, text } from "../http";
import type { WorkerReq as Req } from "./types";

const SECRET_KEYS: [key: string, label: string, help: string][] = [
  ["serper_api_key", "Serper key", "Google search for LinkedIn company pages (required). 2,500 free searches at serper.dev."],
  ["jina_api_key", "Jina key", "Optional: Jina Reader works without one at 20 reads a minute (jina.ai/reader)."],
  ["ai_api_key", "AI provider key", "Only for an OpenAI-compatible provider (the base URL above). Workers AI needs none."],
  ["telegram_bot_token", "Telegram bot token", "Delivery 'telegram': from @BotFather."],
  ["telegram_chat_id", "Telegram chat ID", "Delivery 'telegram': your chat with the bot (message it, then open api.telegram.org/bot<token>/getUpdates)."],
  ["gmail_client_id", "Gmail client ID", "Delivery 'gmail': a Google Cloud OAuth client of type Web application."],
  ["gmail_client_secret", "Gmail client secret", "Delivery 'gmail'."],
  ["outlook_client_id", "Outlook client ID", "Delivery 'outlook': a Microsoft Entra app with a Web redirect URI."],
  ["outlook_client_secret", "Outlook client secret", "Delivery 'outlook'."],
];

const CHANNELS = ["telegram", "gmail", "outlook"];
const redirectUri = (url: URL, provider: Provider) => `${url.origin}/oauth/${provider}/callback`;
const clearHolds = "UPDATE stage_state SET hold_until = NULL, hold_reason = NULL, idle_until = NULL, fail_streak = 0";

// ── read ──────────────────────────────────────────────────────────────────────────

export async function getSettings(req: Req): Promise<Response> {
  const s = (await req.db.get<Record<string, unknown>>("SELECT * FROM app_settings WHERE id = 1")) ?? {};
  const k = (await req.db.get<Record<string, string | null>>("SELECT * FROM app_secrets WHERE id = 1")) ?? {};
  const cfg = configFrom(s, k);
  const tokens = await req.db.all<{ provider: string; email: string | null; saved_at: string }>("SELECT provider, email, saved_at FROM mail_tokens");
  const raw = (key: string) => (s[key] === null || s[key] === undefined || s[key] === "" ? null : s[key]);

  const mailbox = (provider: Provider, label: string) => {
    const t = tokens.find((x) => x.provider === provider);
    return { provider, label, email: t?.email || null, saved_at: t?.saved_at ?? null, redirect_uri: redirectUri(req.url, provider) };
  };
  return json({
    host: "worker",
    // effective values for what has a default, the stored value (or null) for the rest
    fields: {
      ai_model: raw("ai_model"),
      ai_base_url: raw("ai_base_url"),
      ai_qualify_batch: cfg.ai.qualifyBatch,
      ai_email_batch: cfg.ai.emailBatch,
      email_mode: cfg.email.mode,
      email_delivery: cfg.email.delivery,
      email_max_sends_per_day: cfg.email.maxSendsPerDay,
      sender_name: raw("sender_name"),
      email_enabled: cfg.email.enabled,
      email_attach_resume: cfg.email.attachResume,
      email_instructions: raw("email_instructions"),
      linkedin_transport: cfg.sourcing.transport,
      sourcing_per_tick: cfg.sourcing.perTick,
      outlook_tenant: raw("outlook_tenant"),
      paused: cfg.paused,
    },
    defaultModel: DEFAULT_AI_MODEL,
    secrets: SECRET_KEYS.map(([key, label, help]) => {
      const value = (k[key] ?? "").trim();
      return { key, label, help, set: !!value, last4: value ? value.slice(-4) : null };
    }),
    mailboxes: [mailbox("gmail", "Gmail"), mailbox("outlook", "Outlook")],
    lock: { locked: (await lockKey(req.env, req.db)) !== null, fromSecret: envPassword(req.env) !== null, minLength: MIN_PASSWORD },
    meta: { version: Number(s.version ?? 1), updated_at: (s.updated_at as string | undefined) ?? null },
  });
}

// ── write ─────────────────────────────────────────────────────────────────────────

export async function saveSettings(req: Req): Promise<Response> {
  const body = await readBody(req);
  const errors: Record<string, string> = {};
  const num = (key: string, min: number, max: number, int = true): number | null => {
    const r = numberField(text(body, key), { int, min, max });
    if ("error" in r) {
      errors[key] = r.error;
      return null;
    }
    return r.value;
  };
  const short = (key: string, max: number) => {
    const v = text(body, key, max + 1);
    if (v.length > max) errors[key] = `At most ${max} characters.`;
    return v.slice(0, max) || null;
  };
  const mode = text(body, "email_mode");
  const delivery = text(body, "email_delivery");
  const transport = text(body, "linkedin_transport");
  if (mode && !["dry_run", "send"].includes(mode)) errors.email_mode = "Pick one of the options.";
  if (delivery && !CHANNELS.includes(delivery)) errors.email_delivery = "Pick one of the options.";
  if (transport && !["fetch", "browser"].includes(transport)) errors.linkedin_transport = "Pick one of the options.";
  const baseUrl = (short("ai_base_url", 300) ?? "").replace(/\/+$/, "");
  if (baseUrl && !/^https:\/\/\S+$/.test(baseUrl)) errors.ai_base_url = "Use an https:// URL.";

  const fields: Record<string, unknown> = {
    ai_model: short("ai_model", 200),
    ai_base_url: baseUrl || null,
    ai_qualify_batch: num("ai_qualify_batch", 1, 30),
    ai_email_batch: num("ai_email_batch", 1, 10),
    email_mode: mode === "send" ? "send" : "dry_run",
    email_delivery: CHANNELS.includes(delivery) ? delivery : "telegram",
    email_max_sends_per_day: num("email_max_sends_per_day", 1, 100000),
    sender_name: short("sender_name", 200),
    email_enabled: flag(body, "email_enabled"),
    email_attach_resume: flag(body, "email_attach_resume"),
    email_instructions: short("email_instructions", 2000),
    linkedin_transport: transport === "browser" ? "browser" : "fetch",
    sourcing_per_tick: num("sourcing_per_tick", 1, 10),
    outlook_tenant: short("outlook_tenant", 100),
    paused: flag(body, "paused"),
  };
  if (Object.keys(errors).length) return fail("Some settings need fixing.", errors);

  const before = await loadConfig(req.db);
  const { sql, params } = setClause(fields);
  const statements = [req.db.stmt(`UPDATE app_settings SET ${sql}, version = version + 1, updated_at = ? WHERE id = 1`, [...params, new Date().toISOString()])];
  let note = "";
  if (before.email.mode === "dry_run" && fields.email_mode === "send") {
    statements.push(req.db.stmt("DELETE FROM cold_emails WHERE status = 'draft'"));
    note = " The drafts were deleted, so those companies get a real application.";
  }
  statements.push(req.db.stmt(clearHolds));
  await req.db.batch(statements);
  return ok(`Settings saved; they apply at the next tick.${note}`);
}

export async function saveSecret(req: Req): Promise<Response> {
  const body = await readBody(req);
  const key = text(body, "key");
  if (!SECRET_KEYS.some(([k]) => k === key)) return fail("Unknown key");
  const clear = flag(body, "clear");
  const value = text(body, "value", 1001);
  if (!clear) {
    if (!value) return fail("Paste the key first.", { value: "Required." });
    if (value.length > 1000 || /\s/.test(value)) return fail("That doesn't look like an API key.", { value: "No spaces, at most 1000 characters." });
  }
  await req.db.batch([
    req.db.stmt(`UPDATE app_secrets SET ${key} = ?, updated_at = ? WHERE id = 1`, [clear ? null : value, new Date().toISOString()]),
    req.db.stmt(clearHolds),
  ]);
  await wake(req.db, ...STAGES);
  return ok(clear ? "Key cleared." : "Key saved; it is used from the next tick.");
}

// ── try a delivery channel ────────────────────────────────────────────────────────

export async function testSend(req: Req): Promise<Response> {
  const body = await readBody(req);
  const channel = text(body, "channel");
  const to = text(body, "to", 300);
  if (!CHANNELS.includes(channel)) return fail("Pick a channel.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return fail("Give your own email address.", { to: "Not an address." });
  const cfg = await loadConfig(req.db);
  cfg.email.delivery = channel as typeof cfg.email.delivery;
  const profile = await loadProfile(req.db);
  const resume = profile ? await loadResume(req.db, profile) : null;
  const name = profile?.full_name || cfg.email.senderName || "DAVID";
  try {
    const mailer = await makeMailer(req.db, cfg);
    const [status, detail] = await mailer.send(
      to,
      `Test application (${channel})`,
      `Hi Acme team,\n\nThis is a test application from DAVID, sent to check that ${channel} delivery works. Each application goes out exactly like this one, with the resume attached when there is one.\n\nNothing else will be sent by this test.\n\nBest regards,\n${name}`,
      resume ? [resume] : null,
      name,
    );
    const message = `${channel}: ${status}${detail ? ` (${detail.slice(0, 200)})` : ""}`;
    return status === "sent" ? ok(message) : fail(message);
  } catch (e) {
    return fail(`${channel} isn't set up: ${e instanceof Error ? e.message : e}`);
  }
}

// ── Gmail / Outlook sign-in (mail_setup.py connect, as a web flow) ─────────────────

const OAUTH_COOKIE = "ja_oauth";

/** Back to the Settings page with a message the page toasts (?msg=&ok=). */
function toSettings(msg: string, good = true): Response {
  return new Response(null, { status: 303, headers: { Location: `/settings?msg=${encodeURIComponent(msg.slice(0, 300))}&ok=${good ? 1 : 0}` } });
}

export async function oauthStart(req: Req, provider: Provider): Promise<Response> {
  const cfg = await loadConfig(req.db);
  let client;
  try {
    client = oauthClient(cfg, provider);
  } catch (e) {
    return toSettings(e instanceof Error ? e.message : String(e), false);
  }
  const state = randomToken(16);
  const verifier = randomToken(48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    client_id: client.clientId,
    response_type: "code",
    redirect_uri: redirectUri(req.url, provider),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  let authUrl: string;
  if (provider === "gmail") {
    params.set("scope", GMAIL.scopes);
    params.set("access_type", "offline");
    params.set("prompt", "consent"); // always hand out a refresh token
    authUrl = GMAIL.authUrl;
  } else {
    params.set("scope", OUTLOOK.scopes);
    params.set("response_mode", "query");
    params.set("prompt", "select_account");
    authUrl = OUTLOOK.loginUrl(cfg.keys.outlookTenant, "authorize");
  }
  const cookie = await sign(await signingKey(req.env, req.db), `${provider}~${state}~${verifier}`);
  return new Response(null, {
    status: 302,
    headers: { Location: `${authUrl}?${params}`, "Set-Cookie": `${OAUTH_COOKIE}=${cookie}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600` },
  });
}

export async function oauthCallback(req: Req, provider: Provider): Promise<Response> {
  const q = req.url.searchParams;
  if (q.get("error")) return toSettings(`Sign-in failed: ${q.get("error")}: ${q.get("error_description") ?? ""}`, false);
  const saved = await unsign(await signingKey(req.env, req.db), cookieValue(req.request, OAUTH_COOKIE));
  const [p, state, verifier] = (saved ?? "").split("~");
  if (!saved || p !== provider || state !== q.get("state") || !q.get("code")) return toSettings("That sign-in answer didn't match this request; try Connect again.", false);
  const cfg = await loadConfig(req.db);
  const client = oauthClient(cfg, provider);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: q.get("code")!,
    redirect_uri: redirectUri(req.url, provider),
    code_verifier: verifier,
    client_id: client.clientId,
  });
  if (client.clientSecret) form.set("client_secret", client.clientSecret);
  if (client.scope) form.set("scope", client.scope);
  const resp = await fetch(client.tokenUrl, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  const raw = await resp.text();
  if (!resp.ok) return toSettings(`Token exchange refused (HTTP ${resp.status}): ${raw.slice(0, 200)}`, false);
  const body = parseJson<{ refresh_token?: string; access_token?: string; id_token?: string; scope?: string }>(raw, {});
  if (!body.refresh_token) return toSettings("The provider sent no refresh token (Google: remove the app's access at myaccount.google.com/permissions and connect again).", false);
  let email = "";
  if (provider === "gmail" && body.id_token) {
    email = String(parseJson<{ email?: string }>(new TextDecoder().decode(base64urlDecode(body.id_token.split(".")[1] ?? "")), {}).email ?? "");
  } else if (provider === "outlook" && body.access_token) {
    const me = await fetch(OUTLOOK.meUrl, { headers: { Authorization: `Bearer ${body.access_token}` } });
    if (me.ok) {
      const data = (await me.json()) as { mail?: string; userPrincipalName?: string };
      email = data.mail || data.userPrincipalName || "";
    }
  }
  await req.db.run(
    "INSERT OR REPLACE INTO mail_tokens (provider, refresh_token, email, scope, access_token, expires_at, saved_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
    [provider, body.refresh_token, email, body.scope ?? "", new Date().toISOString()],
  );
  await req.db.run("UPDATE stage_state SET hold_until = NULL, hold_reason = NULL WHERE stage = 'email'");
  const res = toSettings(`Connected ${provider === "gmail" ? "Gmail" : "Outlook"}${email ? ` (${email})` : ""}.`);
  res.headers.append("Set-Cookie", `${OAUTH_COOKIE}=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return res;
}

export async function mailboxDisconnect(req: Req, provider: Provider): Promise<Response> {
  await req.db.run("DELETE FROM mail_tokens WHERE provider = ?", [provider]);
  return ok(`${provider === "gmail" ? "Gmail" : "Outlook"} disconnected.`);
}
