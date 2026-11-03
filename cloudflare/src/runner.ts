/**
 * One tick (the cron, every minute; or "Run now" on the dashboard): the Worker's main.py + core/worker.py.
 *
 * A free Worker gets 10 ms of CPU and 50 outside requests per invocation, so a tick runs ONE stage a small
 * step (a round of leads, a few LinkedIn pages): the profile stage first when it has work, then the others in
 * turn, starting from a different one each minute, skipping the held and the idle ones. Waiting on the network
 * doesn't count as CPU, so a tick may take a while; it just mustn't compute much.
 */
import { COOLDOWN_AFTER, COOLDOWN_SECS, type Ctx, IDLE_SECS, LeadFailed, leaseStage, Logger, saveStageState, type Stage, StageHold, type StageResult, stageStates, STAGES } from "./core";
import { Db } from "./db";
import { LLMUnavailable } from "./llm";
import { loadConfig } from "./settings";
import { runEmail } from "./stages/email";
import { runInternal } from "./stages/internal";
import { runProfile } from "./stages/profile";
import { runScrape } from "./stages/scrape";
import { runSourcing } from "./stages/sourcing";
import { errorText, isoIn, utcNow } from "./util";

const RUN: Record<Stage, (ctx: Ctx) => Promise<StageResult>> = {
  profile: runProfile, sourcing: runSourcing, scrape: runScrape, internal: runInternal, email: runEmail,
};
const LOG_RETENTION_SECS = 3 * 24 * 3600;
const LEASE_SECS = 15 * 60;       // a cron tick's longest run; a lease older than this was left by a crash

/** The stages in the order this tick looks at them: profile first, the rest rotated by the minute. */
export function tickOrder(now: Date): Stage[] {
  const rest = STAGES.filter((s) => s !== "profile");
  const k = Math.floor(now.getTime() / 60_000) % rest.length;
  return ["profile", ...rest.slice(k), ...rest.slice(0, k)];
}

/**
 * Run one tick. `only` runs that stage whatever its idle mark (a hold still applies unless `force`). Returns
 * what happened, for the dashboard's "Run now".
 */
export async function tick(env: Env, opts: { only?: Stage; force?: boolean } = {}): Promise<string> {
  const db = new Db(env.DB);
  const now = new Date();
  const cfg = await loadConfig(db);
  if (cfg.paused && !opts.only) return "paused (Settings)";
  const states = await stageStates(db);
  const nowIso = utcNow(now);
  const order = opts.only ? [opts.only] : tickOrder(now);
  if (!opts.only) await housekeeping(db, now);

  for (const stage of order) {
    const st = states[stage];
    if (st.hold_until && st.hold_until > nowIso && !opts.force) {
      if (opts.only) return `${stage} is held until ${st.hold_until}: ${st.hold_reason}`;
      continue;
    }
    if (st.idle_until && st.idle_until > nowIso && !opts.only) continue;

    if (!(await leaseStage(db, stage, LEASE_SECS, now))) {
      if (opts.only) return `${stage} is already running in another tick`;
      continue;
    }
    const log = new Logger(stage);
    const ctx: Ctx = { env, db, cfg, log, now };
    let result: StageResult;
    try {
      result = await RUN[stage](ctx);
    } catch (e) {
      if (e instanceof StageHold || e instanceof LLMUnavailable) {
        result = { worked: true, note: e.message, hold: { secs: e.holdSecs, reason: e.message } };
      } else {
        const message = e instanceof LeadFailed ? e.message : errorText(e);
        log.error(`tick failed: ${message}`);
        result = { worked: true, note: `error: ${message}`, failed: 1 };
      }
    }

    st.last_run_at = nowIso;
    st.last_note = result.note.slice(0, 500);
    if (!result.worked) {
      st.idle_until = isoIn(IDLE_SECS, now);
    } else {
      st.idle_until = null;
      if (result.hold) {
        st.hold_until = isoIn(result.hold.secs, now);
        st.hold_reason = result.hold.reason.slice(0, 500);
        log.warn(`holding for ${Math.round(result.hold.secs / 60)} min: ${result.hold.reason}`);
      } else if (result.failed && !result.succeeded) {
        st.fail_streak += 1;
        if (st.fail_streak >= COOLDOWN_AFTER) {
          st.hold_until = isoIn(COOLDOWN_SECS, now);
          st.hold_reason = `${st.fail_streak} ticks in a row where everything failed (an outside service may be down)`;
          st.fail_streak = 0;
          log.warn(`cooling down for ${COOLDOWN_SECS / 60} min: ${st.hold_reason}`);
        }
      } else {
        st.fail_streak = 0;
        st.hold_until = null;
        st.hold_reason = null;
      }
    }
    await saveStageState(db, st);
    await log.flush(db);
    if (result.worked) return `${stage}: ${result.note}`;
    if (opts.only) return `${stage}: nothing to do (${result.note})`;
  }
  return "nothing to do";
}

/** Once an hour: drop old log lines and expired backoffs. */
async function housekeeping(db: Db, now: Date) {
  if (now.getUTCMinutes() !== 0) return;
  await db.batch([
    db.stmt("DELETE FROM logs WHERE at < ?", [isoIn(-LOG_RETENTION_SECS, now)]),
    db.stmt("DELETE FROM backoff WHERE retry_at < ?", [utcNow(now)]),
  ]);
}
