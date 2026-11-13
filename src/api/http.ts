/**
 * What every API handler gets, and the JSON it answers with. The handlers in this folder run unchanged on the
 * Worker (over D1: worker/) and in the local dashboard server (over the daemon's SQLite file: web/server/): all they
 * know of the machine is the `Host` they are given.
 */
import type { Row } from "../codec";

/** The database as the handlers use it (D1 in the Worker, node:sqlite locally). */
export interface ApiDb {
  stmt(sql: string, params?: unknown[]): unknown;
  all<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** Run a write; returns how many rows it changed. */
  run(sql: string, params?: unknown[]): Promise<number>;
  /** Statements made with `stmt`: all land together, or none do. */
  batch(statements: unknown[]): Promise<unknown>;
}

export interface Req {
  host: Host;
  db: ApiDb;
  url: URL;
  request: Request;
}

export type Handler = (req: Req, ...params: string[]) => Promise<Response>;
/** `[method, path pattern, handler]`; the pattern's groups are the handler's string arguments. */
export type Route = [method: string, pattern: RegExp, handler: Handler];

/** A stage of the Worker's pipeline, for the Overview's Stages table. */
export interface StageRow {
  stage: string;
  state: "ready" | "idle" | "held";
  until: string | null;
  note: string | null;
  last_run_at: string | null;
}

/** How the password is hashed and checked (the Worker's cheap HMAC, or the local dashboard's scrypt). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
}

/** What differs between the Worker and the local server. */
export interface Host {
  /** True when this host runs the pipeline itself (the Worker): it has Logs, "Run now" and Stop. */
  worker: boolean;
  db: ApiDb;
  /** Only read for DASHBOARD_PASSWORD: the secret that, when set, is the password. */
  env: unknown;
  passwords: PasswordHasher;
  /** The largest resume the host can keep. */
  maxResumeBytes: number;
  /** A change the stages should see now: wake them (the Worker), nothing (the daemon polls). */
  wake(...stages: string[]): Promise<void>;
  /** Drop an item's retry mark so a stage offers it again (the Worker's `backoff` table). */
  forget(stage: string, id: string | number): Promise<void>;
  /** A task goes back in the queue: clear what the host keeps of its progress. */
  requeued(taskId: number): Promise<void>;
  /** The Overview's Worker-only parts. */
  overviewExtras(): Promise<{ stages?: StageRow[]; paused?: boolean }>;
  /** Keep a resume and return the `resume_path` the profile row points at; the host removes the one it replaces. */
  saveResume(file: { bytes: Uint8Array; filename: string; mime: string; sha: string; ext: string }): Promise<string>;
  readResume(): Promise<{ bytes: Uint8Array; mime: string; filename: string } | null>;
  /** The host's own endpoints: settings, and on the Worker logs, runs and the mailbox sign-in. */
  routes: Route[];
}

/** What an action answers: `ok`, a message to show, and `fieldErrors` to put under the inputs. */
export interface ActionResult {
  ok: boolean;
  message: string;
  fieldErrors?: Record<string, string>;
}

export const PAGE_SIZE = 25;

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

export const ok = (message: string): Response => json({ ok: true, message } satisfies ActionResult);
export const fail = (message: string, fieldErrors?: Record<string, string>): Response =>
  json({ ok: false, message, ...(fieldErrors ? { fieldErrors } : {}) } satisfies ActionResult);

/** The JSON body of a POST (an empty object when there is none, or it isn't an object). */
export async function readBody(req: Pick<Req, "request">): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A body field as trimmed text, cut to `max`. */
export const text = (body: Record<string, unknown>, key: string, max = 2000): string => String(body[key] ?? "").trim().slice(0, max);

/** A body field as true/false: a boolean, or the "on" a checkbox posts. */
export const flag = (body: Record<string, unknown>, key: string): boolean => body[key] === true || body[key] === "on" || body[key] === "1";

/** A number field: "" is null; otherwise it must be a number inside the limits (`error` is the message to show). */
export function numberField(raw: string, opts: { int?: boolean; min?: number; max?: number }): { value: number | null } | { error: string } {
  if (raw === "") return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: "Enter a number." };
  if (opts.int && !Number.isInteger(n)) return { error: "Use a whole number." };
  if (opts.min !== undefined && n < opts.min) return { error: `At least ${opts.min}.` };
  if (opts.max !== undefined && n > opts.max) return { error: `At most ${opts.max}.` };
  return { value: n };
}

/** A LIKE term with the characters that mean something to LIKE or the query removed. */
export const searchTerm = (q: string | null): string => (q ?? "").replace(/[,().*"\:%_]/g, " ").trim().slice(0, 100);

export const pageNumber = (url: URL) => Math.max(1, Number(url.searchParams.get("page")) || 1);

/** An error whose message is for the user (answered as { error } with this status). */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
