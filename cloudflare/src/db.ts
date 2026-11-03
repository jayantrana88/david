/**
 * D1 access. Every query takes `?` params; JSON columns are decoded and booleans turned into true/false at
 * the edge, the same as core/sqlite.py and the local dashboard's lib/db.ts. Writes that must land together go
 * through `db.batch([...])`, which D1 runs as one transaction.
 */

export type Row = Record<string, unknown>;
type Value = string | number | null | ArrayBuffer;

const JSON_COLUMNS = new Set(["main_links", "content_json", "skills", "target_roles", "cursor"]);
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

export class Db {
  constructor(readonly d1: D1Database) {}

  stmt(sql: string, params: unknown[] = []): D1PreparedStatement {
    const s = this.d1.prepare(sql);
    return params.length ? s.bind(...params.map(encode)) : s;
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { results } = await this.stmt(sql, params).all<Row>();
    return results.map((r) => decode<T>(r));
  }

  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const row = await this.stmt(sql, params).first<Row>();
    return row ? decode<T>(row) : undefined;
  }

  /** Run a write; returns how many rows it changed. */
  async run(sql: string, params: unknown[] = []): Promise<number> {
    const res = await this.stmt(sql, params).run();
    return res.meta.changes ?? 0;
  }

  /** All the statements land together, or none do. */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    return statements.length ? this.d1.batch(statements) : [];
  }
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
