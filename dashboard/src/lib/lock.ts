import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { get, run } from "@/lib/db";

/**
 * The optional dashboard password. One row in `dashboard_lock` (a scrypt hash) = locked; no row = open.
 * A signed-in browser holds a cookie that is an HMAC keyed by that hash, so changing or removing the password
 * signs every browser out, and nothing but the hash is stored.
 */

export const LOCK_COOKIE = "david_unlock";
export const LOCK_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const MIN_PASSWORD_LENGTH = 6;

export function lockHash(): string | null {
  try {
    return get<{ password_hash: string }>("SELECT password_hash FROM dashboard_lock WHERE id = 1")?.password_hash ?? null;
  } catch {
    return null;
  }
}

export function sessionToken(hash: string): string {
  return createHmac("sha256", hash).update("david-session").digest("hex");
}

/** True when there is no lock, or the cookie is the current session token. */
export function isUnlocked(cookie: string | undefined): boolean {
  const hash = lockHash();
  if (!hash) return true;
  if (!cookie) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(sessionToken(hash));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const expected = Buffer.from(key, "hex");
  const actual = scryptSync(password, Buffer.from(salt, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function setPassword(password: string) {
  run(
    `INSERT INTO dashboard_lock (id, password_hash) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    [hashPassword(password)],
  );
}

export function removePassword() {
  run("DELETE FROM dashboard_lock WHERE id = 1");
}

// Guessing is slowed down: after 5 wrong passwords in a row, nothing is accepted for a minute (it doubles
// each further round, up to an hour). One person uses this dashboard, so the counter is for the whole server.
const g = globalThis as unknown as { __lockGuesses?: { fails: number; until: number } };
const guesses = () => (g.__lockGuesses ??= { fails: 0, until: 0 });

/** Seconds to wait before another guess is accepted (0 = go ahead). */
export function waitSeconds(): number {
  return Math.max(0, Math.ceil((guesses().until - Date.now()) / 1000));
}

export function recordGuess(ok: boolean) {
  const s = guesses();
  if (ok) {
    s.fails = 0;
    s.until = 0;
    return;
  }
  s.fails += 1;
  if (s.fails % 5 === 0) s.until = Date.now() + Math.min(60 * 60, 60 * 2 ** (s.fails / 5 - 1)) * 1000;
}
