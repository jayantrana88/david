/**
 * What every stage shares: the tick's context, the outcomes an item can end with, and the stage bookkeeping
 * that the daemon keeps in memory but a Worker (which forgets everything between ticks) keeps in D1:
 *
 *   stage_state.hold_until   the stage is held (an AI quota, a rejected key, LinkedIn blocking, a cooldown)
 *   stage_state.idle_until   the stage found nothing to do; looked at again then, or sooner when woken
 *   backoff                  an item to leave alone until a time (the daemon's `_retry_at`; no counters)
 */
import type { Db } from "./db";
import type { Config } from "./settings";
import { isoIn, utcNow } from "./util";

export const STAGES = ["profile", "sourcing", "scrape", "internal", "email"] as const;
export type Stage = (typeof STAGES)[number];

export const FAILURE_BACKOFF_SECS = 3600;     // a failed item is offered again after this (core/worker.py)
export const SKIP_BACKOFF_SECS = 24 * 3600;   // a skipped item (e.g. no usable address) is left alone this long
export const PERMANENT_BACKOFF_SECS = 30 * 24 * 3600;   // "failed for good" (cleared by the dashboard's retry)
export const IDLE_SECS = 600;                 // an empty queue is looked at again after this, unless woken
export const COOLDOWN_SECS = 600;             // after COOLDOWN_AFTER ticks in a row where everything failed
export const COOLDOWN_AFTER = 3;

type Level = "debug" | "info" | "warning" | "error";

/** Log lines of one tick, written to the `logs` table in one batch at the end (and to the Workers console). */
export class Logger {
  lines: { stage: string; level: Level; message: string }[] = [];
  constructor(public stage: string) {}
  log(message: string, level: Level = "info") {
    this.lines.push({ stage: this.stage, level, message: message.slice(0, 2000) });
    (level === "error" ? console.error : level === "warning" ? console.warn : console.log)(`[${this.stage}] ${message}`);
  }
  warn(message: string) {
    this.log(message, "warning");
  }
  error(message: string) {
    this.log(message, "error");
  }
  async flush(db: Db) {
    const lines = this.lines.filter((l) => l.level !== "debug");
    this.lines = [];
    if (!lines.length) return;
    await db.batch(lines.map((l) => db.stmt("INSERT INTO logs (stage, level, message) VALUES (?, ?, ?)", [l.stage, l.level, l.message])));
  }
}

export interface Ctx {
  env: Env;
  db: Db;
  cfg: Config;
  log: Logger;
  now: Date;
}

/** An item failed; offered again after FAILURE_BACKOFF_SECS, or never (`permanent`) when its row says so. */
export class LeadFailed extends Error {
  constructor(message: string, readonly permanent = false) {
    super(message);
    this.name = "LeadFailed";
  }
}

/** An item that can't be worked on (no usable address...): left alone for SKIP_BACKOFF_SECS, not a failure. */
export class LeadSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadSkipped";
  }
}

/** The whole stage must wait: an AI quota, a rejected key, LinkedIn or Browser Rendering limits... */
export class StageHold extends Error {
  constructor(message: string, readonly holdSecs: number) {
    super(message);
    this.name = "StageHold";
  }
}

/** What a stage's tick reports to the runner. `worked` = it had something to do (else it goes idle). */
export interface StageResult {
  worked: boolean;
  note: string;
  failed?: number;       // items that failed this tick
  succeeded?: number;    // items that went through
  hold?: { secs: number; reason: string };
}

export const idle = (note: string): StageResult => ({ worked: false, note });

/** `backoff.item` key: stages share ids (a website id is in scrape's and email's queue). */
export const itemKey = (stage: Stage, id: string | number) => `${stage}:${id}`;

/** SQL condition (with one `?` for now) that leaves out items in backoff; `idExpr` is the item's id column. */
export const notBackedOff = (stage: Stage, idExpr: string) =>
  `NOT EXISTS (SELECT 1 FROM backoff b WHERE b.item = '${stage}:' || ${idExpr} AND b.retry_at > ?)`;

export async function backOff(db: Db, stage: Stage, id: string | number, secs: number, reason: string, now = new Date()) {
  await db.run("INSERT OR REPLACE INTO backoff (item, retry_at, reason) VALUES (?, ?, ?)", [itemKey(stage, id), isoIn(secs, now), reason.slice(0, 500)]);
}

/** Record how one item ended (core/worker.py's outcomes): null = success. Returns "ok" | "skipped" | "failed". */
export async function recordOutcome(ctx: Ctx, stage: Stage, id: string | number, label: string, outcome: unknown): Promise<"ok" | "skipped" | "failed"> {
  if (outcome === null || outcome === undefined) return "ok";
  if (outcome instanceof LeadSkipped) {
    ctx.log.log(`${label}: skipped (${outcome.message})`);
    await backOff(ctx.db, stage, id, SKIP_BACKOFF_SECS, `skipped: ${outcome.message}`, ctx.now);
    return "skipped";
  }
  const message = outcome instanceof Error ? outcome.message : String(outcome);
  if (outcome instanceof LeadFailed && outcome.permanent) {
    // usually the item's row now says so (and leaves the queue); the backoff covers the cases where none was
    // written (a dry run's draft that never passed the rules), which the daemon only forgets at a restart
    ctx.log.warn(`${label}: failed for good (${message})`);
    await backOff(ctx.db, stage, id, PERMANENT_BACKOFF_SECS, `failed for good: ${message}`, ctx.now);
    return "failed";
  }
  ctx.log.warn(`${label}: failed (${message}); offered again in ${FAILURE_BACKOFF_SECS / 60} min`);
  await backOff(ctx.db, stage, id, FAILURE_BACKOFF_SECS, message, ctx.now);
  return "failed";
}

/** Clear the stages' idle marks, so the next tick looks at their queues at once (their upstream wrote work). */
export async function wake(db: Db, ...stages: Stage[]) {
  if (!stages.length) return;
  await db.run(`UPDATE stage_state SET idle_until = NULL WHERE stage IN (${stages.map(() => "?").join(", ")})`, stages);
}

export interface StageState {
  stage: Stage;
  hold_until: string | null;
  hold_reason: string | null;
  idle_until: string | null;
  fail_streak: number;
  last_run_at: string | null;
  last_note: string | null;
}

export async function stageStates(db: Db): Promise<Record<Stage, StageState>> {
  const rows = await db.all<StageState>("SELECT * FROM stage_state");
  const out = {} as Record<Stage, StageState>;
  for (const stage of STAGES) {
    out[stage] = rows.find((r) => r.stage === stage) ?? {
      stage, hold_until: null, hold_reason: null, idle_until: null, fail_streak: 0, last_run_at: null, last_note: null,
    };
  }
  return out;
}

/** Take the stage for one tick (ticks overlap when one runs past the minute). False = another tick has it. */
export async function leaseStage(db: Db, stage: Stage, secs: number, now = new Date()): Promise<boolean> {
  const changed = await db.run(
    "UPDATE stage_state SET lease_until = ? WHERE stage = ? AND (lease_until IS NULL OR lease_until < ?)",
    [isoIn(secs, now), stage, now.toISOString()]);
  return changed > 0;
}

/** Save how the tick went and let go of the stage. */
export async function saveStageState(db: Db, s: StageState) {
  await db.run(
    `INSERT INTO stage_state (stage, hold_until, hold_reason, idle_until, fail_streak, last_run_at, last_note, lease_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (stage) DO UPDATE SET hold_until = excluded.hold_until, hold_reason = excluded.hold_reason,
       idle_until = excluded.idle_until, fail_streak = excluded.fail_streak, last_run_at = excluded.last_run_at,
       last_note = excluded.last_note, lease_until = NULL`,
    [s.stage, s.hold_until, s.hold_reason, s.idle_until, s.fail_streak, s.last_run_at, s.last_note],
  );
}

