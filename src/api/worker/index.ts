/**
 * The Worker's side of the dashboard API: the `Host` the shared handlers (src/api/) run on. Data is D1; a change wakes
 * the stage that should see it (the stages idle between ticks); the resume lives in D1 as base64.
 */
import { itemKey, type Stage, STAGES, stageStates, wake } from "../../core";
import { Db } from "../../db";
import type { Provider } from "../../mail/oauth";
import { base64ToBytes, bytesToBase64 } from "../../util";
import { hmacHasher } from "../auth";
import type { Handler, Host, Route, StageRow } from "../http";
import { logs, runNow } from "./ops";
import * as settings from "./settings";
import type { WorkerReq } from "./types";

// D1 holds rows up to 2 MB, and the resume is stored as base64 (4/3 of its size)
const MAX_RESUME_BYTES = 1_400_000;

export function workerHost(env: Env, ctx: ExecutionContext): Host {
  const db = new Db(env.DB);
  // the Worker-only handlers see the bindings too
  const w = (fn: (req: WorkerReq, ...params: string[]) => Promise<Response>): Handler => (req, ...params) => fn({ ...req, env, ctx, db }, ...params);
  const provider = (p: string) => p as Provider;

  const routes: Route[] = [
    ["GET", /^\/api\/logs$/, w(logs)],
    ["POST", /^\/api\/run$/, w(runNow)],
    ["GET", /^\/api\/settings$/, w(settings.getSettings)],
    ["POST", /^\/api\/settings$/, w(settings.saveSettings)],
    ["POST", /^\/api\/settings\/secret$/, w(settings.saveSecret)],
    ["POST", /^\/api\/settings\/test-send$/, w(settings.testSend)],
    ["POST", /^\/api\/settings\/mailbox\/(gmail|outlook)\/disconnect$/, w((req, p) => settings.mailboxDisconnect(req, provider(p!)))],
    ["GET", /^\/oauth\/(gmail|outlook)\/start$/, w((req, p) => settings.oauthStart(req, provider(p!)))],
    ["GET", /^\/oauth\/(gmail|outlook)\/callback$/, w((req, p) => settings.oauthCallback(req, provider(p!)))],
  ];

  return {
    worker: true,
    db,
    env,
    passwords: hmacHasher,
    maxResumeBytes: MAX_RESUME_BYTES,
    routes,

    wake: (...stages) => wake(db, ...(stages as Stage[])),
    forget: async (stage, id) => void (await db.run("DELETE FROM backoff WHERE item = ?", [itemKey(stage as Stage, id)])),
    requeued: async (taskId) => void (await db.run("UPDATE tasks SET cursor = NULL WHERE id = ?", [taskId])),

    async overviewExtras() {
      const [states, cfg] = await Promise.all([stageStates(db), db.get<{ paused: boolean | null }>("SELECT paused FROM app_settings WHERE id = 1")]);
      const nowIso = new Date().toISOString();
      const stages: StageRow[] = STAGES.map((s) => {
        const st = states[s];
        const held = !!st.hold_until && st.hold_until > nowIso;
        const idle = !held && !!st.idle_until && st.idle_until > nowIso;
        return { stage: s, state: held ? "held" : idle ? "idle" : "ready", until: held ? st.hold_until : null, note: held ? st.hold_reason : st.last_note, last_run_at: st.last_run_at };
      });
      return { stages, paused: !!cfg?.paused };
    },

    async saveResume({ bytes, filename, mime, sha }) {
      const old = await db.get<{ resume_sha256: string | null }>("SELECT resume_sha256 FROM candidate_profile WHERE id = 1");
      await db.run("INSERT OR REPLACE INTO resume_files (sha256, filename, mime, size, base64) VALUES (?, ?, ?, ?, ?)", [sha, filename, mime, bytes.length, bytesToBase64(bytes)]);
      if (old?.resume_sha256 && old.resume_sha256 !== sha) await db.run("DELETE FROM resume_files WHERE sha256 = ?", [old.resume_sha256]);
      return sha;
    },

    async readResume() {
      const row = await db.get<{ filename: string; mime: string; base64: string }>(
        "SELECT f.filename, f.mime, f.base64 FROM candidate_profile p JOIN resume_files f ON f.sha256 = p.resume_sha256 WHERE p.id = 1",
      );
      return row ? { bytes: base64ToBytes(row.base64), mime: row.mime, filename: row.filename } : null;
    },
  };
}
