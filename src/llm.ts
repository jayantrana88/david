/**
 * The one door to the AI (core/llm.py). Two providers:
 *
 *   Workers AI   the `AI` binding, no key (default: Gemma 4 26B, thinking off). The free plan has 10,000
 *                neurons a day; used up = LLMQuotaExhausted until midnight UTC.
 *   any OpenAI-compatible endpoint (Settings: AI base URL + key + model), e.g. Groq or OpenRouter.
 *
 * `chat(prompt, schema)` sends the reply's JSON schema (prompts.ts) as `response_format`; a provider that
 * rejects it is asked again without one (the prompts describe the shape in words too). Errors:
 *   LLMAuthError        the key / account was refused (the stage holds 15 min)
 *   LLMQuotaExhausted   the quota is used up (the stage holds until the reset)
 *   anything else       a failed call: the caller skips the item (retried after the backoff)
 */
import type { Config } from "./settings";
import { secsUntilUtcMidnight, sleep } from "./util";

export const AUTH_HOLD_SECS = 900;
const WITHDRAWN_HOLD_SECS = 900;
const UNKNOWN_RESET_SECS = 3600;
const MAX_QUOTA_WAIT = 24 * 3600;
const QUOTA_SWITCH_AFTER = 90;     // a 429 asking to wait longer than this counts as "quota used up"

const PER_DAY_RE = /\b(?:TPD|RPD)\b|per[ -]day|free-models-per-day|daily free allocation|\b4006\b|\b3036\b/i;
const TRY_AGAIN_RE = /try again in\s+([\d.hms]+)/i;
const WITHDRAWN_RE = /decommissioned|model_not_found|model .{0,80} does not exist|no endpoints found|no such model|\b5007\b/i;
const AUTH_RE = /\b10000\b|authentication error|not entitled|unauthorized|invalid api key/i;
const SCHEMA_REJECTED_RE = /response_format|json_schema|schema|structured|\b5006\b|invalid input|unknown (?:field|parameter)|chat_template_kwargs/i;

export class LLMUnavailable extends Error {
  constructor(message: string, readonly holdSecs: number = AUTH_HOLD_SECS) {
    super(message);
    this.name = "LLMUnavailable";
  }
}
export class LLMAuthError extends LLMUnavailable {
  constructor(message: string) {
    super(message, AUTH_HOLD_SECS);
    this.name = "LLMAuthError";
  }
}
export class LLMQuotaExhausted extends LLMUnavailable {
  constructor(message: string, holdSecs: number) {
    super(message, holdSecs);
    this.name = "LLMQuotaExhausted";
  }
}

/** A reply's JSON schema, OpenAI-style (name + schema object). */
export interface Schema {
  name: string;
  schema: Record<string, unknown>;
}

export interface LLM {
  /** One single-turn prompt -> the reply text. `attempts` = tries for a transient failure (default 2). */
  chat(prompt: string, schema?: Schema, attempts?: number): Promise<string>;
}

/** Seconds in a Groq-style duration such as "7m12.5s", "1h2m", "2.36s" or "343ms". */
export function duration(text: string): number | null {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length) return null;
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 };
  return parts.reduce((sum, [, n, u]) => sum + Number(n) * unit[u], 0);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter: number | null) {
    super(message);
    this.name = `HTTP ${status}`;
  }
}

/** Seconds a quota-type error says to wait, or null when it is a per-minute limit (retried on the spot). */
export function quotaWait(message: string, retryAfter: number | null, now = new Date()): number | null {
  let wait = retryAfter;
  const m = TRY_AGAIN_RE.exec(message);
  if (wait === null && m) wait = duration(m[1]);
  if (PER_DAY_RE.test(message)) {
    if (wait === null) wait = /\b4006\b|neurons|daily free allocation/i.test(message) ? secsUntilUtcMidnight(now) : UNKNOWN_RESET_SECS;
    return Math.min(MAX_QUOTA_WAIT, Math.max(60, wait));
  }
  if (wait !== null && wait > QUOTA_SWITCH_AFTER) return Math.min(MAX_QUOTA_WAIT, wait);
  return null;
}

/** The reply text out of whatever shape the provider answered in. */
export function replyText(out: unknown): string {
  if (typeof out === "string") return out;
  if (!out || typeof out !== "object") return "";
  const o = out as Record<string, unknown>;
  const choices = o.choices as { message?: { content?: unknown } }[] | undefined;
  const content = choices?.[0]?.message?.content ?? o.response ?? o.result;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if ("response" in (content as object)) return replyText(content);
    return JSON.stringify(content);    // JSON mode: Workers AI hands back the parsed object
  }
  return "";
}

export function makeLLM(env: Env, cfg: Config): LLM {
  return new LLMClient(env, cfg);
}

class LLMClient implements LLM {
  private structured = true;    // stepped down to false when the provider rejects schemas
  private extras = true;        // Workers AI: chat_template_kwargs (thinking off); dropped if rejected

  constructor(private env: Env, private cfg: Config) {}

  private get label() {
    return this.cfg.ai.baseUrl ? `${this.cfg.ai.model} (${new URL(this.cfg.ai.baseUrl).host})` : `Workers AI ${this.cfg.ai.model}`;
  }

  async chat(prompt: string, schema?: Schema, attempts = 2): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        const text = (await this.once(prompt, this.structured ? schema : undefined)).trim();
        if (!text) throw new Error(`${this.label} returned an empty reply`);
        return text;
      } catch (e) {
        const err = this.classify(e);
        if (err instanceof LLMUnavailable) throw err;
        const message = e instanceof Error ? e.message : String(e);
        const canDropExtras = this.extras && !this.cfg.ai.baseUrl;
        if ((canDropExtras || (this.structured && schema)) && SCHEMA_REJECTED_RE.test(message) && !(e instanceof HttpError && e.status >= 500)) {
          // step down (core/llm.py's structured_output) without spending an attempt: first the extras, then the schema
          if (canDropExtras) this.extras = false;
          else this.structured = false;
          attempt--;
          continue;
        }
        if (attempt >= attempts || !this.transient(e)) throw err;
        await sleep(Math.min(20_000, (e instanceof HttpError && e.retryAfter ? e.retryAfter : 3) * 1000));
      }
    }
  }

  private async once(prompt: string, schema?: Schema): Promise<string> {
    const messages = [{ role: "user", content: prompt }];
    const { model, baseUrl, apiKey } = this.cfg.ai;
    if (!baseUrl) {
      const input: Record<string, unknown> = { messages, max_tokens: 4096, temperature: 0.4 };
      if (schema) input.response_format = { type: "json_schema", json_schema: schema.schema };
      // Gemma 4 thinks by default, and the hidden reasoning is billed: off = far fewer neurons
      if (this.extras) input.chat_template_kwargs = { enable_thinking: false };
      const out = await this.env.AI.run(model as never, input as never);
      return replyText(out);
    }
    const body: Record<string, unknown> = { model, messages, temperature: 0.4, max_tokens: 4096 };
    if (schema) body.response_format = { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } };
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      const ra = Number(resp.headers.get("retry-after"));
      throw new HttpError(resp.status, `${this.label}: HTTP ${resp.status}: ${text.slice(0, 400)}`, Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    try {
      return replyText(JSON.parse(text));
    } catch {
      return text;
    }
  }

  /** An LLMUnavailable for errors that should hold the stage, else the error as it came. */
  private classify(e: unknown): unknown {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof HttpError ? e.status : null;
    if (status === 401 || status === 403 || (status === null && AUTH_RE.test(message))) {
      return new LLMAuthError(`${this.label}: the provider refused our credentials (${message.slice(0, 200)}); check Settings → AI`);
    }
    if (status === 429 || status === null) {
      const wait = quotaWait(message, e instanceof HttpError ? e.retryAfter : null);
      if (wait !== null) return new LLMQuotaExhausted(`${this.label}: out of quota (${message.slice(0, 200)})`, wait);
    }
    if (status === 404 || WITHDRAWN_RE.test(message)) {
      return new LLMUnavailable(`${this.label}: the provider doesn't have this model (${message.slice(0, 200)}); check Settings → AI`, WITHDRAWN_HOLD_SECS);
    }
    return e;
  }

  private transient(e: unknown): boolean {
    if (e instanceof HttpError) return e.status === 429 || e.status >= 500;
    const message = e instanceof Error ? `${e.name} ${e.message}` : String(e);
    return /timeout|timed out|network|capacity|\b3040\b|\b3043\b|internal|overloaded|temporarily|fetch failed|AbortError/i.test(message);
  }
}

// ── several questions in one call (core/llm.py::ask_in_batches) ───────────────

/** Settle every promise, each to its value or its error. */
export async function settle<T>(promises: Promise<T>[]): Promise<(T | Error)[]> {
  const results = await Promise.allSettled(promises);
  return results.map((r) => (r.status === "fulfilled" ? r.value : r.reason instanceof Error ? r.reason : new Error(String(r.reason))));
}

/**
 * One answer (or the error to report) per item, in order. Never throws. Items go out `size` at a time, one
 * AI call per chunk: `askBatch(chunk)` returns {1-based position: answer} for what its reply answered
 * clearly. Every item a chunk leaves out is asked alone with `askOne(item, attempts)`, never guessed; after a
 * chunk call that failed outright, with attempts=1. An LLMUnavailable from a chunk call is every one of its
 * items' answer.
 */
export async function askInBatches<T, R>(
  items: T[],
  size: number,
  askBatch: (chunk: T[]) => Promise<Map<number, R>>,
  askOne: (item: T, attempts?: number) => Promise<R>,
  log?: (message: string) => void,
): Promise<(R | Error)[]> {
  if (size <= 1) return settle(items.map((item) => askOne(item)));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  const answered = await Promise.all(chunks.map((chunk) => askChunk(chunk, askBatch, askOne, log)));
  return answered.flat();
}

async function askChunk<T, R>(
  chunk: T[],
  askBatch: (chunk: T[]) => Promise<Map<number, R>>,
  askOne: (item: T, attempts?: number) => Promise<R>,
  log?: (message: string) => void,
): Promise<(R | Error)[]> {
  if (chunk.length === 1) return settle([askOne(chunk[0])]);
  let answers = new Map<number, R>();
  let attempts: number | undefined;
  try {
    answers = await askBatch(chunk);
  } catch (e) {
    if (e instanceof LLMUnavailable) return chunk.map(() => e);
    attempts = 1;
    log?.(`batch of ${chunk.length} failed (${e instanceof Error ? e.message.slice(0, 200) : e}); asking each on its own`);
  }
  if (attempts === undefined && answers.size < chunk.length) {
    log?.(`batch of ${chunk.length}: ${answers.size} usable answer(s); asking the other ${chunk.length - answers.size} on their own`);
  }
  const missing = chunk.map((_, i) => i).filter((i) => !answers.has(i + 1));
  const alone = await settle(missing.map((i) => askOne(chunk[i], attempts)));
  const byIndex = new Map(missing.map((i, j) => [i, alone[j]]));
  return chunk.map((_, i) => (answers.has(i + 1) ? (answers.get(i + 1) as R) : (byIndex.get(i) as R | Error)));
}
