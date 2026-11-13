import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult } from "@/lib/types";

/** A failed call: the HTTP status, and the message the API sent (or the network's). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ── signed out ──────────────────────────────────────────────────────────────────

let onSignedOut: () => void = () => {};
/** The app registers what to do when any call answers 401 (show the password screen). */
export function setSignedOutHandler(fn: () => void) {
  onSignedOut = fn;
}

// ── reloading what is on screen after a change ──────────────────────────────────

const listeners = new Set<() => void>();
/** Every `useApi` on screen fetches again (after an action changed something). */
export function invalidate() {
  for (const fn of listeners) fn();
}

// ── requests ────────────────────────────────────────────────────────────────────

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: "application/json" }, credentials: "same-origin" };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  }
  if (res.status === 401) onSignedOut();
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: the message below carries the text */
  }
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? (text.slice(0, 200) || `HTTP ${res.status}`);
    throw new ApiError(message, res.status);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
};

/** A form's fields as a plain object (the API reads JSON; a file goes as multipart instead). */
export function formObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form) if (typeof v === "string") out[k] = v;
  return out;
}

/** POST and hand back an ActionResult: a failure becomes `{ ok: false }`, a success reloads what is on screen. */
export async function act(path: string, body?: unknown): Promise<ActionResult> {
  try {
    const result = await api.post<ActionResult>(path, body);
    invalidate();
    return result;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Something went wrong" };
  }
}

/** `act` for a submitted form. */
export const actForm = (path: string, form: FormData, extra: Record<string, unknown> = {}) =>
  act(path, { ...formObject(form), ...extra });

// ── reading ─────────────────────────────────────────────────────────────────────

/**
 * GET `path` (null = don't fetch yet). The last answer stays on screen while a newer one loads. `every` seconds,
 * `refreshWhen(data)` decides whether to fetch again (a running task, a profile being read).
 */
export function useApi<D>(
  path: string | null,
  opts: { every?: number; refreshWhen?: (data: D) => boolean } = {},
): { data: D | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ path: string | null; data?: D; error: string | null }>({ path, error: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const latest = useRef(0);

  useEffect(() => {
    listeners.add(reload);
    return () => void listeners.delete(reload);
  }, [reload]);

  useEffect(() => {
    if (path === null) return;
    const mine = ++latest.current;
    api
      .get<D>(path)
      .then((data) => mine === latest.current && setState({ path, data, error: null }))
      .catch((e: Error) => mine === latest.current && setState((s) => ({ path, data: s.path === path ? s.data : undefined, error: e.message })));
  }, [path, tick]);

  const { every, refreshWhen } = opts;
  const data = state.path === path ? state.data : undefined;
  const refresh = every !== undefined && data !== undefined && (refreshWhen ? refreshWhen(data) : true);
  useEffect(() => {
    if (!refresh) return;
    const id = setInterval(() => document.visibilityState === "visible" && reload(), (every as number) * 1000);
    return () => clearInterval(id);
  }, [refresh, every, reload]);

  return { data, error: state.path === path ? state.error : null, loading: path !== null && data === undefined && !(state.path === path && state.error), reload };
}
