/**
 * Gmail (Gmail API) and Outlook (Microsoft Graph) delivery: email the company from your own mailbox, resume
 * attached (apis/gmail.py, apis/outlook.py, apis/mail.py's OAuthMailer). You sign in once from the dashboard
 * (Settings → Email → Connect); the refresh token and the current access token live in D1 (`mail_tokens`).
 *
 * `send` retries only what can't have gone through (a 401 once with a fresh token, 429 / 5xx). A fetch that
 * throws once the request was sent (a timeout, a dropped connection) is UNCERTAIN: never retried, so a company
 * never gets the same email twice.
 */
import type { Db } from "../db";
import type { Config } from "../settings";
import { isoIn, sleep } from "../util";
import { type Attachment, buildMessage, type Mailer, type SendResult } from "./mail";

export type Provider = "gmail" | "outlook";

export const GMAIL = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  sendUrl: "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media",
  scopes: "https://www.googleapis.com/auth/gmail.send openid email",
};
export const OUTLOOK = {
  loginUrl: (tenant: string, endpoint: "authorize" | "token") => `https://login.microsoftonline.com/${tenant || "common"}/oauth2/v2.0/${endpoint}`,
  sendUrl: "https://graph.microsoft.com/v1.0/me/sendMail",
  meUrl: "https://graph.microsoft.com/v1.0/me",
  scopes: "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read",
};
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** The client (id, secret) and token endpoint for a provider, or an error naming what is missing. */
export function oauthClient(cfg: Config, provider: Provider) {
  const k = cfg.keys;
  if (provider === "gmail") {
    if (!k.gmailClientId || !k.gmailClientSecret) throw new Error("Gmail delivery needs the Gmail client ID and secret (Settings → API keys)");
    return { clientId: k.gmailClientId, clientSecret: k.gmailClientSecret, tokenUrl: GMAIL.tokenUrl, scope: "" };
  }
  if (!k.outlookClientId) throw new Error("Outlook delivery needs the Outlook client ID (Settings → API keys)");
  return { clientId: k.outlookClientId, clientSecret: k.outlookClientSecret, tokenUrl: OUTLOOK.loginUrl(k.outlookTenant, "token"), scope: OUTLOOK.scopes };
}

interface TokenRow {
  refresh_token: string;
  email: string | null;
  access_token: string | null;
  expires_at: string | null;
}

class SignedOut extends Error {}

class OAuthToken {
  constructor(private db: Db, private cfg: Config, readonly provider: Provider, private row: TokenRow) {}

  get email() {
    return this.row.email ?? "";
  }

  invalidate() {
    this.row.access_token = null;
  }

  /** A valid access token, refreshed (and saved) when it is about to expire. Throws SignedOut or a network error. */
  async get(): Promise<string> {
    if (this.row.access_token && this.row.expires_at && this.row.expires_at > new Date().toISOString()) return this.row.access_token;
    const client = oauthClient(this.cfg, this.provider);
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.row.refresh_token, client_id: client.clientId });
    if (client.clientSecret) form.set("client_secret", client.clientSecret);
    if (client.scope) form.set("scope", client.scope);
    const resp = await fetch(client.tokenUrl, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    const text = await resp.text();
    if (resp.status !== 200) {
      throw new SignedOut(`${this.provider}: token refresh refused (HTTP ${resp.status}: ${text.slice(0, 200)}); connect it again on the Settings page`);
    }
    const body = JSON.parse(text) as { access_token: string; expires_in?: number; refresh_token?: string };
    this.row.access_token = body.access_token;
    this.row.expires_at = isoIn(Number(body.expires_in ?? 3600) - 120);
    if (body.refresh_token) this.row.refresh_token = body.refresh_token;   // Microsoft rotates it
    await this.db.run("UPDATE mail_tokens SET refresh_token = ?, access_token = ?, expires_at = ? WHERE provider = ?",
      [this.row.refresh_token, this.row.access_token, this.row.expires_at, this.provider]);
    return this.row.access_token;
  }
}

export async function loadToken(db: Db, provider: Provider): Promise<TokenRow | undefined> {
  return db.get<TokenRow>("SELECT refresh_token, email, access_token, expires_at FROM mail_tokens WHERE provider = ?", [provider]);
}

export async function makeOAuthMailer(db: Db, cfg: Config, provider: Provider): Promise<Mailer> {
  oauthClient(cfg, provider);
  const row = await loadToken(db, provider);
  if (!row) throw new Error(`${provider}: not connected; use Settings → Email → Connect ${provider === "gmail" ? "Gmail" : "Outlook"}`);
  return new OAuthMailer(new OAuthToken(db, cfg, provider, row));
}

class OAuthMailer implements Mailer {
  constructor(private token: OAuthToken) {}

  async send(to: string, subject: string, text: string, attachments: Attachment[] | null, fromName: string): Promise<SendResult> {
    let resp: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let access: string;
      try {
        access = await this.token.get();
      } catch (e) {
        if (e instanceof SignedOut || attempt === 3) return ["send_failed", e instanceof Error ? e.message : String(e)];
        await sleep(2000 * attempt);
        continue;
      }
      try {
        resp = await this.request(access, to, subject, text, attachments, fromName);
      } catch (e) {
        // the request may have reached the provider: never retried
        return ["uncertain", e instanceof Error ? `${e.name}: ${e.message}` : String(e)];
      }
      if (resp.status === 401 && attempt < 3) {
        this.token.invalidate();
        continue;
      }
      if (RETRYABLE.has(resp.status) && attempt < 3) {
        const ra = Number(resp.headers.get("retry-after"));
        await sleep(Math.min(30, Math.max(2 * 2 ** (attempt - 1), Number.isFinite(ra) ? ra : 0)) * 1000);
        continue;
      }
      break;
    }
    return resp ? this.outcome(resp) : ["send_failed", "no answer"];
  }

  private request(access: string, to: string, subject: string, text: string, attachments: Attachment[] | null, fromName: string) {
    const signal = AbortSignal.timeout(60_000);
    if (this.token.provider === "gmail") {
      return fetch(GMAIL.sendUrl, {
        method: "POST", signal,
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "message/rfc822" },
        body: buildMessage(to, subject, text, attachments, this.token.email, fromName),
      });
    }
    // Graph takes the attachment inline: the whole request must stay under 4 MB
    const message = {
      subject,
      body: { contentType: "Text", content: text },
      toRecipients: [{ emailAddress: { address: to } }],
      attachments: (attachments ?? []).map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.filename, contentType: a.mime, contentBytes: a.base64 })),
    };
    return fetch(OUTLOOK.sendUrl, {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
  }

  private async outcome(resp: Response): Promise<SendResult> {
    const text = await resp.text();
    if (this.token.provider === "gmail" && resp.status === 200) {
      try {
        return ["sent", String(JSON.parse(text).id ?? "")];
      } catch {
        return ["sent", ""];
      }
    }
    if (this.token.provider === "outlook" && resp.status === 202) return ["sent", resp.headers.get("request-id") ?? ""];
    const detail = `HTTP ${resp.status}: ${text.slice(0, 300)}`;
    const lower = text.toLowerCase();
    if (resp.status === 400 && (lower.includes("invalid to header") || lower.includes("errorinvalidrecipients"))) return ["rejected", detail];
    return ["send_failed", detail];
  }
}
