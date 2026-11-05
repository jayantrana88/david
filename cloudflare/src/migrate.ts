/**
 * Applies the bundled D1 migrations from inside the Worker, so a deploy works whichever command built it
 * (the Deploy button's `npm run deploy`, the dashboard's plain `npx wrangler deploy`, a Git push). It keeps
 * wrangler's own bookkeeping table (`d1_migrations`), so `wrangler d1 migrations apply` and the Worker never
 * apply the same file twice.
 */

export interface Migration {
  name: string;
  sql: string;
}

// The same definition wrangler uses.
const TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** Splits a script on top-level semicolons (not inside quotes or comments), keeping `CREATE TRIGGER ... BEGIN ... END;` whole. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      cur += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 1;
      cur += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";") {
      const stmt = cur.trim();
      const openTrigger = /^CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(stmt) && !/\bEND$/i.test(stmt);
      if (openTrigger) {
        cur += c;
        continue;
      }
      if (stmt) out.push(stmt);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function appliedNames(db: D1Database): Promise<Set<string>> {
  const [, rows] = await db.batch<{ name: string }>([db.prepare(TABLE), db.prepare("SELECT name FROM d1_migrations")]);
  return new Set(rows.results.map((r) => r.name));
}

/** Runs every migration not yet recorded, in name order; returns the names it applied. */
export async function migrate(db: D1Database, migrations: Migration[]): Promise<string[]> {
  const applied = await appliedNames(db);
  const ran: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (applied.has(m.name)) continue;
    try {
      // One batch is one transaction: the schema change and its bookkeeping row land together.
      await db.batch([...splitSql(m.sql).map((s) => db.prepare(s)), db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(m.name)]);
      ran.push(m.name);
    } catch (e) {
      // Another isolate may have applied it at the same moment.
      if (!(await appliedNames(db)).has(m.name)) {
        throw new Error(`Database migration ${m.name} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    }
  }
  return ran;
}
