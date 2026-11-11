/**
 * The dashboard is on a public URL, so it is always locked: the password is the DASHBOARD_PASSWORD secret
 * (set after the deploy, not asked for by the button). Without it every page says how to set it (fail closed).
 * A session is a cookie `<expiry>.<HMAC(password, expiry)>`: changing the password signs everyone out.
 * POSTs must come from the dashboard's own origin (CSRF), on top of the SameSite=Lax cookie.
 */
import { base64url, base64urlDecode } from "../util";

export const COOKIE = "ja_session";
const MAX_AGE = 30 * 24 * 3600;
export const MIN_PASSWORD = 10;

export const passwordOf = (env: Env): string => String((env as unknown as { DASHBOARD_PASSWORD?: string }).DASHBOARD_PASSWORD ?? "");

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

/** The password typed matches (compared as HMACs, in constant time). */
export async function passwordMatches(env: Env, typed: string): Promise<boolean> {
  const password = passwordOf(env);
  if (password.length < MIN_PASSWORD) return false;
  return equal(await hmac("login", typed), await hmac("login", password));
}

export async function sessionCookie(env: Env): Promise<string> {
  const expiry = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  const sig = base64url(await hmac(passwordOf(env), `session:${expiry}`));
  return `${COOKIE}=${expiry}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`;
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function signedIn(env: Env, request: Request): Promise<boolean> {
  const password = passwordOf(env);
  const value = cookieValue(request, COOKIE);
  if (password.length < MIN_PASSWORD || !value) return false;
  const [expiry, sig] = value.split(".");
  if (!expiry || !sig || Number(expiry) < Date.now() / 1000) return false;
  try {
    return equal(base64urlDecode(sig), await hmac(password, `session:${expiry}`));
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
export async function sign(env: Env, value: string): Promise<string> {
  return `${value}.${base64url(await hmac(passwordOf(env), `signed:${value}`))}`;
}

export async function unsign(env: Env, signed: string | null): Promise<string | null> {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  try {
    return equal(base64urlDecode(signed.slice(i + 1)), await hmac(passwordOf(env), `signed:${value}`)) ? value : null;
  } catch {
    return null;
  }
}
