/**
 * The SQLite edge shared by D1 (db.ts) and the local database (web/server/db.ts): JSON columns are decoded and booleans
 * turned into true/false on read, objects and booleans encoded on write, the same as core/sqlite.py.
 */

export type Row = Record<string, unknown>;
export type Value = string | number | null | ArrayBuffer;

const JSON_COLUMNS = new Set(["main_links", "content_json", "skills", "target_roles", "cursor", "raw_json", "links"]);
const BOOL_COLUMNS = new Set(["is_qualified", "email_enabled", "email_attach_resume", "repeat_daily", "paused"]);

/** A parameter as SQLite stores it: booleans as 0/1, objects and arrays as JSON text. */
export function encode(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return v;
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "bigint") return Number(v);
  return v as string | number;
}

export function decode<T = Row>(row: Row): T {
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
  return out as T;
}

/** `INSERT INTO table (cols) VALUES (?, ...)` for one row (column names come from code, never from input). */
export function insertSql(table: string, row: Row, returning?: string): { sql: string; params: unknown[] } {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${returning ? ` RETURNING ${returning}` : ""}`;
  return { sql, params: cols.map((c) => row[c]) };
}

/** `col = ?, ...` and its values, for an UPDATE (column names come from code, never from input). */
export function setClause(fields: Row): { sql: string; params: unknown[] } {
  const cols = Object.keys(fields);
  return { sql: cols.map((c) => `${c} = ?`).join(", "), params: cols.map((c) => fields[c]) };
}
