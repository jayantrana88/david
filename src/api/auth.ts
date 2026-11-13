/**
 * The optional dashboard password. It is set from the Settings page and stored as a salted hash in
 * `dashboard_lock` (no row = the dashboard is open). The DASHBOARD_PASSWORD secret, when someone sets it, wins and
 * can't be changed from the page. The "lock key" is what a session is signed with: changing or removing the
 * password signs everyone out.
 * A session is a cookie `<expiry>.<HMAC(lock key, expiry)>`.
 * POSTs must come from the dashboard's own origin (CSRF), on top of the SameSite=Lax cookie.
 */
import { base64url, base64urlDecode } from "../util";
import type { ApiDb, PasswordHasher } from "./http";

export const COOKIE = "ja_session";
const MAX_AGE = 30 * 24 * 3600;
export const MIN_PASSWORD = 8;

export const passwordOf = (env: unknown): string => String((env as { DASHBOARD_PASSWORD?: string } | null)?.DASHBOARD_PASSWORD ?? "");

/** The password from the secret, when someone set one (it can't be changed from the Settings page). */
export const envPassword = (env: unknown): string | null => (passwordOf(env).length >= MIN_PASSWORD ? passwordOf(env) : null);

/** What sessions are signed with, or null when the dashboard is open. */
export async function lockKey(env: unknown, db: ApiDb): Promise<string | null> {
  const fromEnv = envPassword(env);
  if (fromEnv) return `env:${fromEnv}`;
  const row = await db.get<{ password_hash: string }>("SELECT password_hash FROM dashboard_lock WHERE id = 1");
  return row ? `db:${row.password_hash}` : null;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** `<salt>:<HMAC-SHA256(salt, password)>`. Cheap on purpose: a free Worker has 10 ms of CPU per request. */
export async function hashPassword(password: string): Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `${salt}:${hex(await hmac(salt, password))}`;
}

async function verifyHmac(typed: string, stored: string): Promise<boolean> {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  return equal(await hmac("login", hex(await hmac(salt, typed))), await hmac("login", expected));
}

/** The Worker's hasher; the local server brings its own (its stored hashes are scrypt). */
export const hmacHasher: PasswordHasher = { hash: hashPassword, verify: verifyHmac };

/** The typed password matches the lock (the secret, or the stored hash), in constant time. */
export async function passwordMatches(env: unknown, db: ApiDb, typed: string, hasher: PasswordHasher = hmacHasher): Promise<boolean> {
  const fromEnv = envPassword(env);
  if (fromEnv) return equal(await hmac("login", typed), await hmac("login", fromEnv));
  const row = await db.get<{ password_hash: string }>("SELECT password_hash FROM dashboard_lock WHERE id = 1");
  return row ? hasher.verify(typed, row.password_hash) : false;
}

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

/** The session cookie; `Secure` unless this is plain http (the local server on 127.0.0.1). */
export async function sessionCookie(key: string, secure = true): Promise<string> {
  const expiry = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  const sig = base64url(await hmac(key, `session:${expiry}`));
  return `${COOKIE}=${expiry}.${sig}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export const clearCookie = (secure = true) => `${COOKIE}=; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=0`;

export async function signedIn(key: string, request: Request): Promise<boolean> {
  const value = cookieValue(request, COOKIE);
  if (!value) return false;
  const [expiry, sig] = value.split(".");
  if (!expiry || !sig || Number(expiry) < Date.now() / 1000) return false;
  try {
    return equal(base64urlDecode(sig), await hmac(key, `session:${expiry}`));
  } catch {
    return false;
  }
}

/** A POST that came from this dashboard (Origin, or Sec-Fetch-Site when a browser leaves Origin out). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  const site = request.headers.get("Sec-Fetch-Site");
  return site === "same-origin" || site === "none";
}

/** Sign a short-lived value (the OAuth state + PKCE verifier cookie). */
export async function sign(key: string, value: string): Promise<string> {
  return `${value}.${base64url(await hmac(key, `signed:${value}`))}`;
}

/** The key for short-lived signed values: the lock key, or a fixed one while the dashboard is open (nobody to impersonate). */
export async function signingKey(env: unknown, db: ApiDb): Promise<string> {
  return (await lockKey(env, db)) ?? "open";
}

export async function unsign(key: string, signed: string | null): Promise<string | null> {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  try {
    return equal(base64urlDecode(signed.slice(i + 1)), await hmac(key, `signed:${value}`)) ? value : null;
  } catch {
    return null;
  }
}
