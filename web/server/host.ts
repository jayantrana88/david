/**
 * The local dashboard's `Host` (src/api/http.ts): the shared API handlers over the daemon's SQLite file. The daemon
 * polls its queues, so nothing needs waking; the resume is a file next to the database (`data/resumes/`); a stage
 * is never run from here (the daemon is its own process).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Host, PasswordHasher, Route } from "../../src/api/http";
import { LocalDb, openDatabase } from "./db";
import * as settings from "./settings";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

/** `<salt>:<scrypt>`: the format this dashboard has always stored, so an existing password keeps working. */
export const scryptHasher: PasswordHasher = {
  async hash(password) {
    const salt = randomBytes(16);
    return `${salt.toString("hex")}:${scryptSync(password, salt, 32).toString("hex")}`;
  },
  async verify(password, stored) {
    const [salt, key] = stored.split(":");
    if (!salt || !key) return false;
    const expected = Buffer.from(key, "hex");
    const actual = scryptSync(password, Buffer.from(salt, "hex"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  },
};

export function localHost(opts: { dbFile: string; schemaFile: string; env?: unknown; resumesDir?: string }): Host {
  const db = new LocalDb(openDatabase(opts.dbFile, opts.schemaFile));
  const resumes = opts.resumesDir ?? path.join(path.dirname(opts.dbFile), "resumes");
  const none = async () => {};

  const routes: Route[] = [
    ["GET", /^\/api\/settings$/, settings.getSettings],
    ["POST", /^\/api\/settings$/, settings.saveSettings],
    ["POST", /^\/api\/settings\/secret$/, settings.saveSecret],
  ];

  return {
    worker: false,
    db,
    env: opts.env ?? { DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD },
    passwords: scryptHasher,
    maxResumeBytes: MAX_RESUME_BYTES,
    routes,

    wake: none,
    forget: none,
    requeued: none,
    overviewExtras: async () => ({}),

    async saveResume({ bytes, filename: _filename, sha, ext }) {
      const name = `resume-${sha.slice(0, 16)}.${ext}`;
      const old = (await db.get<{ resume_path: string | null }>("SELECT resume_path FROM candidate_profile WHERE id = 1"))?.resume_path;
      fs.mkdirSync(resumes, { recursive: true });
      fs.writeFileSync(path.join(resumes, name), bytes);
      if (old && old !== name) {
        try {
          fs.rmSync(path.join(resumes, path.basename(old)), { force: true });
        } catch {
          /* an old file left behind is harmless */
        }
      }
      return name;
    },

    async readResume() {
      const row = await db.get<{ resume_path: string | null; resume_mime: string | null; resume_filename: string | null }>(
        "SELECT resume_path, resume_mime, resume_filename FROM candidate_profile WHERE id = 1",
      );
      if (!row?.resume_path) return null;
      try {
        const bytes = fs.readFileSync(path.join(resumes, path.basename(row.resume_path)));
        return { bytes, mime: row.resume_mime || "application/octet-stream", filename: row.resume_filename || row.resume_path };
      } catch {
        return null;
      }
    },
  };
}
