/** What every dashboard handler gets, plus the redirect-with-a-message helper. */
import type { Db } from "../db";

export interface Req {
  env: Env;
  db: Db;
  url: URL;
  request: Request;
  ctx: ExecutionContext;
}

/** 303 back to `path` with a flash message (?msg=&ok=). */
export function redirect(path: string, msg?: string, ok = true): Response {
  const u = new URL(path, "https://x");
  if (msg) {
    u.searchParams.set("msg", msg.slice(0, 300));
    u.searchParams.set("ok", ok ? "1" : "0");
  }
  return new Response(null, { status: 303, headers: { Location: u.pathname + u.search } });
}

export function flashOf(url: URL): { ok: boolean; msg: string } | null {
  const msg = url.searchParams.get("msg");
  return msg ? { ok: url.searchParams.get("ok") !== "0", msg } : null;
}

export const formText = (form: FormData, key: string, max = 2000): string => String(form.get(key) ?? "").trim().slice(0, max);

/** A LIKE term with the characters that mean something to LIKE removed. */
export const searchTerm = (q: string | null): string => (q ?? "").replace(/[%_\\]/g, " ").trim().slice(0, 100);

export const pageNumber = (url: URL) => Math.max(1, Number(url.searchParams.get("page")) || 1);
