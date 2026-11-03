import "server-only";
import fs from "node:fs";
import path from "node:path";

/**
 * The local SQLite database the daemon shares (default ../data/job_applier.db, `DB_PATH` overrides it;
 * a relative path is relative to the repo root). Uses Node's built-in `node:sqlite`, loaded through
 * `process.getBuiltinModule` so the bundler never has to resolve it. The schema (../db/schema.sql) is
 * applied on first open, the same as the daemon does, so either side may create the file.
 */

type Value = string | number | bigint | null;
type Row = Record<string, unknown>;
interface Statement {
  all(...params: Value[]): Row[];
  get(...params: Value[]): Row | undefined;
  run(...params: Value[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

const REPO_ROOT = path.resolve(process.cwd(), "..");

export function dbPath(): string {
  const p = process.env.DB_PATH || "data/job_applier.db";
  return path.isAbsolute(p) ? p : path.join(/*turbopackIgnore: true*/ REPO_ROOT, p);
}

/** Where the uploaded resume files live: a `resumes` folder next to the database file. */
export function resumesDir(): string {
  return path.join(/*turbopackIgnore: true*/ path.dirname(dbPath()), "resumes");
}

const JSON_COLUMNS = new Set(["raw_json", "links", "main_links", "content_json", "skills", "target_roles"]);
const BOOL_COLUMNS = new Set(["is_qualified", "email_enabled"]);

const g = globalThis as unknown as { __jobApplierDb?: Database };

function open(): Database {
  const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): { DatabaseSync: new (p: string) => Database } })
    .getBuiltinModule("node:sqlite");
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  conn.exec(fs.readFileSync(path.join(/*turbopackIgnore: true*/ REPO_ROOT, "db", "schema.sql"), "utf8"));
  return conn;
}

/** One connection per server process (kept on globalThis so dev hot-reloads don't open more). */
function conn(): Database {
  return (g.__jobApplierDb ??= open());
}

/** A parameter as SQLite stores it: booleans as 0/1, objects and arrays as JSON text. */
function encode(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") return JSON.stringify(v);
  return v as Value;
}

function decode(row: Row): Row {
  const out: Row = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (v === null || v === undefined) continue;
    if (JSON_COLUMNS.has(k) && typeof v === "string") {
      try {
        out[k] = JSON.parse(v);
      } catch {
        /* not JSON: keep the text */
      }
    } else if (BOOL_COLUMNS.has(k)) {
      out[k] = Boolean(v);
    }
  }
  return out;
}

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return conn().prepare(sql).all(...params.map(encode)).map((r) => decode(r) as T);
}

export function get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  const row = conn().prepare(sql).get(...params.map(encode));
  return row ? (decode(row) as T) : undefined;
}

/** Run a write; returns how many rows it changed. */
export function run(sql: string, params: unknown[] = []): number {
  return Number(conn().prepare(sql).run(...params.map(encode)).changes);
}

/** `INSERT ... RETURNING *` for one or more rows; returns the rows as stored. */
export function insert<T = Row>(table: string, rows: Row | Row[]): T[] {
  const list = Array.isArray(rows) ? rows : [rows];
  return list.map((row) => {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING *`;
    return get<T>(sql, cols.map((c) => row[c]))!;
  });
}

/** `col = ?, ...` and its values, for an UPDATE (column names come from code, never from input). */
export function setClause(fields: Row): { sql: string; params: unknown[] } {
  const cols = Object.keys(fields);
  return { sql: cols.map((c) => `${c} = ?`).join(", "), params: cols.map((c) => fields[c]) };
}

/** The columns a table really has, so a form can't write one the schema lacks. */
export function columnsOf(table: string): Set<string> {
  return new Set(all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name));
}

/** All the statements in `fn` land together, or none do. */
export function transaction<T>(fn: () => T): T {
  conn().exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    conn().exec("COMMIT");
    return result;
  } catch (e) {
    conn().exec("ROLLBACK");
    throw e;
  }
}
