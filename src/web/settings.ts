/**
 * The Settings page (app_settings / app_secrets) and the Gmail / Outlook sign-in. Saved settings apply at the
 * next tick (nothing to restart); saving clears every stage's hold and idle mark, so a fixed key is tried at
 * once. Going from dry run to send deletes the drafts, so those companies get a real application.
 */
import { STAGES, wake } from "../core";
import { setClause } from "../db";
import { makeMailer } from "../stages/email";
import { GMAIL, OUTLOOK, oauthClient, type Provider } from "../mail/oauth";
import { configFrom, DEFAULT_AI_MODEL, loadConfig } from "../settings";
import { loadProfile, loadResume } from "../candidate";
import { base64url, base64urlDecode, parseJson, randomToken } from "../util";
import { cookieValue, envPassword, hashPassword, lockKey, MIN_PASSWORD, passwordMatches, sessionCookie, sign, signingKey, unsign } from "./auth";
import { flashOf, formText, type Req, redirect } from "./common";
import { action, html, layout, raw, when } from "./html";

export const SECRET_KEYS: [key: string, label: string, help: string][] = [
  ["serper_api_key", "Serper key", "Google search for LinkedIn company pages (required). 2,500 free searches at serper.dev."],
  ["jina_api_key", "Jina key", "Optional: Jina Reader works without one at 20 reads a minute (jina.ai/reader)."],
  ["ai_api_key", "AI provider key", "Only for an OpenAI-compatible provider (AI base URL below). Workers AI needs none."],
  ["telegram_bot_token", "Telegram bot token", "Delivery 'telegram': from @BotFather."],
  ["telegram_chat_id", "Telegram chat id", "Delivery 'telegram': your chat with the bot (message it, then open api.telegram.org/bot<token>/getUpdates)."],
  ["gmail_client_id", "Gmail client ID", "Delivery 'gmail': a Google Cloud OAuth client of type Web application."],
  ["gmail_client_secret", "Gmail client secret", ""],
  ["outlook_client_id", "Outlook client ID", "Delivery 'outlook': a Microsoft Entra app with a Web redirect URI."],
  ["outlook_client_secret", "Outlook client secret", ""],
];

const redirectUri = (req: Req, provider: Provider) => `${req.url.origin}/oauth/${provider}/callback`;

export async function settingsPage(req: Req): Promise<Response> {
  const s = (await req.db.get<Record<string, unknown>>("SELECT * FROM app_settings WHERE id = 1")) ?? {};
  const k = (await req.db.get<Record<string, string | null>>("SELECT * FROM app_secrets WHERE id = 1")) ?? {};
  const cfg = configFrom(s, k);
  const tokens = await req.db.all<{ provider: string; email: string | null; saved_at: string }>("SELECT provider, email, saved_at FROM mail_tokens");
  const v = (key: string) => (s[key] === null || s[key] === undefined ? "" : String(s[key]));
  const opt = (value: string, current: string, label = value) => html`<option value="${value}" ${value === current ? raw("selected") : ""}>${label}</option>`;

  const keyRows = SECRET_KEYS.map(([key, label, help]) => {
    const value = (k[key] ?? "").trim();
    return html`<div class="panel"><div class="row"><b>${label}</b> ${value ? html`<span class="badge b-ok">set …${value.slice(-4)}</span>` : html`<span class="badge">not set</span>`}</div>
${help ? html`<div class="muted small">${help}</div>` : ""}
<form method="post" action="/settings/secret" class="row" style="margin-top:8px"><input type="hidden" name="key" value="${key}">
<input name="value" type="password" autocomplete="off" placeholder="paste to set or replace" style="max-width:380px"><button>Save</button>
${value ? html`<button name="clear" value="1" class="danger">Clear</button>` : ""}</form></div>`;
  });

  const mailbox = (provider: Provider, label: string) => {
    const t = tokens.find((x) => x.provider === provider);
    return html`<div class="panel"><div class="row"><b>${label}</b> ${t ? html`<span class="badge b-ok">connected${t.email ? ` as ${t.email}` : ""}</span> <span class="muted small">${when(t.saved_at)}</span>` : html`<span class="badge">not connected</span>`}</div>
<p class="muted small">Register this redirect URI in the OAuth client: <code>${redirectUri(req, provider)}</code></p>
<div class="row"><a class="btn" href="/oauth/${provider}/start">${t ? "Connect again" : "Connect"}</a>${t ? action(`/oauth/${provider}/disconnect`, "Disconnect", { cls: "danger" }) : ""}</div></div>`;
  };

  const locked = (await lockKey(req.env, req.db)) !== null;
  const fromSecret = envPassword(req.env) !== null;
  const passwordPanel = fromSecret
    ? html`<div class="panel"><span class="badge b-ok">locked</span> The password comes from the <code>DASHBOARD_PASSWORD</code> secret. Change it under Workers &amp; Pages → this Worker → Settings → Variables and Secrets.</div>`
    : html`<div class="panel">${locked ? html`<span class="badge b-ok">locked</span>` : html`<span class="badge b-warn">open</span> <b>Anyone who has this address can open the dashboard</b>, including your API keys and resume. Set a password if the address could get out.`}
<form method="post" action="/settings/password" class="cols" style="margin-top:8px">
${locked ? html`<div><label>Current password</label><input name="current" type="password" autocomplete="current-password" required></div>` : ""}
<div><label>${locked ? "New password" : "Password"} (at least ${MIN_PASSWORD} characters)</label><input name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></div>
<div><label>Repeat it</label><input name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></div>
<div><button class="primary">${locked ? "Change password" : "Set password"}</button></div></form>
${locked ? html`<form method="post" action="/settings/password/remove" class="row" style="margin-top:8px" onsubmit="return confirm('Remove the password? Anyone with the address can then open the dashboard.')">
<input name="current" type="password" autocomplete="current-password" required placeholder="current password" style="max-width:260px"><button class="danger">Remove password</button></form>` : ""}</div>`;

  const body = html`
<h2 id="password">Dashboard password</h2>
${passwordPanel}
<form method="post" action="/settings">
<h2>AI</h2><div class="panel cols">
<div><label>Model (empty = Workers AI's ${DEFAULT_AI_MODEL})</label><input name="ai_model" value="${v("ai_model")}" maxlength="200" placeholder="${DEFAULT_AI_MODEL}"></div>
<div><label>OpenAI-compatible base URL (empty = Workers AI, free 10,000 neurons a day)</label><input name="ai_base_url" value="${v("ai_base_url")}" maxlength="300" placeholder="https://api.groq.com/openai/v1"></div>
<div><label>Companies judged per AI call (1–30)</label><input name="ai_qualify_batch" type="number" min="1" max="30" value="${cfg.ai.qualifyBatch}"></div>
<div><label>First drafts per AI call (1–10)</label><input name="ai_email_batch" type="number" min="1" max="10" value="${cfg.ai.emailBatch}"></div></div>

<h2>Applications</h2><div class="panel cols">
<div><label>Mode</label><select name="email_mode">${opt("dry_run", cfg.email.mode, "Dry run: save drafts, send nothing")}${opt("send", cfg.email.mode, "Send")}</select></div>
<div><label>Delivery (send mode)</label><select name="email_delivery">${opt("telegram", cfg.email.delivery, "Telegram: to your chat, to send by hand")}${opt("gmail", cfg.email.delivery, "Gmail: from your account")}${opt("outlook", cfg.email.delivery, "Outlook: from your account")}</select></div>
<div><label>Max sends per day (empty = no cap)</label><input name="email_max_sends_per_day" type="number" min="1" value="${v("email_max_sends_per_day")}"></div>
<div><label>Sender name (empty = your profile's name)</label><input name="sender_name" value="${v("sender_name")}" maxlength="200"></div>
<div><label><input type="checkbox" name="email_enabled" ${cfg.email.enabled ? raw("checked") : ""}> Write applications</label>
<label><input type="checkbox" name="email_attach_resume" ${cfg.email.attachResume ? raw("checked") : ""}> Attach my resume (waits until there is one)</label></div></div>
<div class="panel"><label>Your own rules for the applications (they override the default flow and style, never the hard rules: 70–140 words, no dashes or lists, only your links)</label>
<textarea name="email_instructions" maxlength="2000">${v("email_instructions")}</textarea></div>

<h2>Sourcing</h2><div class="panel cols">
<div><label>LinkedIn pages through</label><select name="linkedin_transport">${opt("fetch", cfg.sourcing.transport, "Plain fetch (often refused by LinkedIn)")}${opt("browser", cfg.sourcing.transport, "Browser Rendering (Workers Paid only; needs the BROWSER binding)")}</select></div>
<div><label>LinkedIn pages per tick (1–10)</label><input name="sourcing_per_tick" type="number" min="1" max="10" value="${cfg.sourcing.perTick}"></div>
<div><label>Outlook tenant</label><input name="outlook_tenant" value="${v("outlook_tenant")}" placeholder="common" maxlength="100"></div>
<div><label><input type="checkbox" name="paused" ${cfg.paused ? raw("checked") : ""}> Pause (the scheduled ticks do nothing)</label></div></div>
<p><button class="primary">Save settings</button></p></form>

<h2 id="keys">API keys</h2>
<p class="muted small">Stored in your D1 database as plain text. Set a dashboard password above if the address could get out.</p>
${keyRows}

<h2>Mailboxes (delivery gmail / outlook)</h2>
${mailbox("gmail", "Gmail")}${mailbox("outlook", "Outlook")}

<h2>Try a delivery channel</h2>
<form method="post" action="/settings/test-send" class="panel row">
<select name="channel" style="width:auto">${["telegram", "gmail", "outlook"].map((c) => opt(c, cfg.email.delivery))}</select>
<input name="to" type="email" required placeholder="your own address" style="max-width:300px"><button>Send a sample</button>
<span class="muted small">Really sends one sample application (with your resume) to the address you give.</span></form>`;
  return layout("Settings", "/settings", body, flashOf(req.url));
}

export async function saveSettings(req: Req): Promise<Response> {
  const form = await req.request.formData();
  const num = (key: string, min: number, max: number): number | null | undefined => {
    const t = formText(form, key);
    if (t === "") return null;
    const n = Number(t);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  };
  const fields: Record<string, unknown> = {
    ai_model: formText(form, "ai_model", 200) || null,
    ai_base_url: formText(form, "ai_base_url", 300).replace(/\/+$/, "") || null,
    ai_qualify_batch: num("ai_qualify_batch", 1, 30),
    ai_email_batch: num("ai_email_batch", 1, 10),
    email_mode: formText(form, "email_mode") === "send" ? "send" : "dry_run",
    email_delivery: ["telegram", "gmail", "outlook"].includes(formText(form, "email_delivery")) ? formText(form, "email_delivery") : "telegram",
    email_max_sends_per_day: num("email_max_sends_per_day", 1, 100000),
    sender_name: formText(form, "sender_name", 200) || null,
    email_enabled: form.get("email_enabled") === "on",
    email_attach_resume: form.get("email_attach_resume") === "on",
    email_instructions: formText(form, "email_instructions", 2000) || null,
    linkedin_transport: formText(form, "linkedin_transport") === "browser" ? "browser" : "fetch",
    sourcing_per_tick: num("sourcing_per_tick", 1, 10),
    outlook_tenant: formText(form, "outlook_tenant", 100) || null,
    paused: form.get("paused") === "on",
  };
  const bad = Object.entries(fields).filter(([, val]) => val === undefined).map(([key]) => key);
  if (bad.length) return redirect("/settings", `Check these numbers: ${bad.join(", ")}`, false);
  if (fields.ai_base_url && !/^https:\/\/\S+$/.test(String(fields.ai_base_url))) return redirect("/settings", "The AI base URL must be an https:// URL.", false);

  const before = await loadConfig(req.db);
  const { sql, params } = setClause(fields);
  const statements = [req.db.stmt(`UPDATE app_settings SET ${sql}, version = version + 1, updated_at = ? WHERE id = 1`, [...params, new Date().toISOString()])];
  let note = "";
  if (before.email.mode === "dry_run" && fields.email_mode === "send") {
    statements.push(req.db.stmt("DELETE FROM cold_emails WHERE status = 'draft'"));
    note = " The drafts were deleted, so those companies get a real application.";
  }
  statements.push(req.db.stmt("UPDATE stage_state SET hold_until = NULL, hold_reason = NULL, idle_until = NULL, fail_streak = 0"));
  await req.db.batch(statements);
  return redirect("/settings", `Settings saved; they apply at the next tick.${note}`);
}

export async function saveSecret(req: Req): Promise<Response> {
  const form = await req.request.formData();
  const key = formText(form, "key");
  if (!SECRET_KEYS.some(([k]) => k === key)) return redirect("/settings#keys", "Unknown key", false);
  const clear = form.get("clear") === "1";
  const value = formText(form, "value", 1000);
  if (!clear && (!value || /\s/.test(value))) return redirect("/settings#keys", "Paste the key first (no spaces).", false);
  await req.db.batch([
    req.db.stmt(`UPDATE app_secrets SET ${key} = ?, updated_at = ? WHERE id = 1`, [clear ? null : value, new Date().toISOString()]),
    req.db.stmt("UPDATE stage_state SET hold_until = NULL, hold_reason = NULL, idle_until = NULL, fail_streak = 0"),
  ]);
  await wake(req.db, ...STAGES);
  return redirect("/settings#keys", clear ? "Key cleared." : "Key saved; it is used from the next tick.");
}

const text = (form: FormData, key: string): string => String(form.get(key) ?? "");

/** Sets or changes the dashboard password (a salted hash in D1). Changing it signs every browser out but this one. */
export async function savePassword(req: Req): Promise<Response> {
  if (envPassword(req.env)) return redirect("/settings", "The password is set by the DASHBOARD_PASSWORD secret; change it in Cloudflare.", false);
  const form = await req.request.formData();
  const password = text(form, "password");
  if (password.length < MIN_PASSWORD) return redirect("/settings", `Use at least ${MIN_PASSWORD} characters.`, false);
  if (password !== text(form, "confirm")) return redirect("/settings", "The two passwords don't match.", false);
  if ((await lockKey(req.env, req.db)) !== null && !(await passwordMatches(req.env, req.db, text(form, "current")))) {
    return redirect("/settings", "The current password is wrong.", false);
  }
  const hash = await hashPassword(password);
  await req.db.run(
    "INSERT INTO dashboard_lock (id, password_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    [hash],
  );
  const res = redirect("/settings", "Password saved.");
  res.headers.append("Set-Cookie", await sessionCookie(`db:${hash}`));
  return res;
}

/** Removes the password: the dashboard is open again. */
export async function removePassword(req: Req): Promise<Response> {
  if (envPassword(req.env)) return redirect("/settings", "The password is set by the DASHBOARD_PASSWORD secret; remove it in Cloudflare.", false);
  if (!(await passwordMatches(req.env, req.db, text(await req.request.formData(), "current")))) {
    return redirect("/settings", "The current password is wrong.", false);
  }
  await req.db.run("DELETE FROM dashboard_lock WHERE id = 1");
  return redirect("/settings", "Password removed; the dashboard is open.");
}

export async function testSend(req: Req): Promise<Response> {
  const form = await req.request.formData();
  const channel = formText(form, "channel");
  const to = formText(form, "to", 300);
  if (!["telegram", "gmail", "outlook"].includes(channel) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return redirect("/settings", "Pick a channel and give your own address.", false);
  const cfg = await loadConfig(req.db);
  cfg.email.delivery = channel as typeof cfg.email.delivery;
  const profile = await loadProfile(req.db);
  const resume = profile ? await loadResume(req.db, profile) : null;
  const name = profile?.full_name || cfg.email.senderName || "DAVID";
  try {
    const mailer = await makeMailer(req.db, cfg);
    const [status, detail] = await mailer.send(to, `Test application (${channel})`,
      `Hi Acme team,\n\nThis is a test application from DAVID, sent to check that ${channel} delivery works. Each application goes out exactly like this one, with the resume attached when there is one.\n\nNothing else will be sent by this test.\n\nBest regards,\n${name}`,
      resume ? [resume] : null, name);
    return redirect("/settings", `${channel}: ${status}${detail ? ` (${detail.slice(0, 200)})` : ""}`, status === "sent");
  } catch (e) {
    return redirect("/settings", `${channel} isn't set up: ${e instanceof Error ? e.message : e}`, false);
  }
}

// ── Gmail / Outlook sign-in (mail_setup.py connect, as a web flow) ─────────────

const OAUTH_COOKIE = "ja_oauth";

export async function oauthStart(req: Req, provider: Provider): Promise<Response> {
  const cfg = await loadConfig(req.db);
  let client;
  try {
    client = oauthClient(cfg, provider);
  } catch (e) {
    return redirect("/settings", e instanceof Error ? e.message : String(e), false);
  }
  const state = randomToken(16);
  const verifier = randomToken(48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    client_id: client.clientId, response_type: "code", redirect_uri: redirectUri(req, provider), state,
    code_challenge: challenge, code_challenge_method: "S256",
  });
  let authUrl: string;
  if (provider === "gmail") {
    params.set("scope", GMAIL.scopes);
    params.set("access_type", "offline");
    params.set("prompt", "consent");          // always hand out a refresh token
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
    headers: {
      Location: `${authUrl}?${params}`,
      "Set-Cookie": `${OAUTH_COOKIE}=${cookie}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

export async function oauthCallback(req: Req, provider: Provider): Promise<Response> {
  const q = req.url.searchParams;
  if (q.get("error")) return redirect("/settings", `Sign-in failed: ${q.get("error")}: ${q.get("error_description") ?? ""}`, false);
  const saved = await unsign(await signingKey(req.env, req.db), cookieValue(req.request, OAUTH_COOKIE));
  const [p, state, verifier] = (saved ?? "").split("~");
  if (!saved || p !== provider || state !== q.get("state") || !q.get("code")) return redirect("/settings", "That sign-in answer didn't match this request; try Connect again.", false);
  const cfg = await loadConfig(req.db);
  const client = oauthClient(cfg, provider);
  const form = new URLSearchParams({
    grant_type: "authorization_code", code: q.get("code")!, redirect_uri: redirectUri(req, provider), code_verifier: verifier, client_id: client.clientId,
  });
  if (client.clientSecret) form.set("client_secret", client.clientSecret);
  if (client.scope) form.set("scope", client.scope);
  const resp = await fetch(client.tokenUrl, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  const text = await resp.text();
  if (!resp.ok) return redirect("/settings", `Token exchange refused (HTTP ${resp.status}): ${text.slice(0, 200)}`, false);
  const body = parseJson<{ refresh_token?: string; access_token?: string; id_token?: string; scope?: string }>(text, {});
  if (!body.refresh_token) return redirect("/settings", "The provider sent no refresh token (Google: remove the app's access at myaccount.google.com/permissions and connect again).", false);
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
    `INSERT OR REPLACE INTO mail_tokens (provider, refresh_token, email, scope, access_token, expires_at, saved_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    [provider, body.refresh_token, email, body.scope ?? "", new Date().toISOString()]);
  await req.db.run("UPDATE stage_state SET hold_until = NULL, hold_reason = NULL WHERE stage = 'email'");
  const res = redirect("/settings", `Connected ${provider === "gmail" ? "Gmail" : "Outlook"}${email ? ` (${email})` : ""}.`);
  res.headers.append("Set-Cookie", `${OAUTH_COOKIE}=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return res;
}

export async function oauthDisconnect(req: Req, provider: Provider): Promise<Response> {
  await req.db.run("DELETE FROM mail_tokens WHERE provider = ?", [provider]);
  return redirect("/settings", `${provider === "gmail" ? "Gmail" : "Outlook"} disconnected.`);
}

