/**
 * Test doubles: a D1Database over Node's built-in SQLite (D1 is SQLite, so the real migration and every
 * query run unchanged), a fake Workers AI, and a fetch router for the outside services.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

type Statement = { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): { changes: number | bigint } };
type Sqlite = { exec(sql: string): void; prepare(sql: string): Statement };

const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): { DatabaseSync: new (p: string) => Sqlite } }).getBuiltinModule("node:sqlite");

class FakeStatement {
  constructor(private db: Sqlite, readonly sql: string, private params: unknown[] = []) {}
  bind(...params: unknown[]) {
    return new FakeStatement(this.db, this.sql, params);
  }
  private returnsRows() {
    return /^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql);
  }
  exec() {
    const stmt = this.db.prepare(this.sql);
    if (this.returnsRows()) {
      const rows = stmt.all(...this.params) as Record<string, unknown>[];
      return { results: rows, meta: { changes: /^\s*(select|with)\b/i.test(this.sql) ? 0 : rows.length }, success: true };
    }
    const info = stmt.run(...this.params);
    return { results: [], meta: { changes: Number(info.changes) }, success: true };
  }
  async all() {
    return this.exec();
  }
  async first() {
    return (this.exec().results[0] as Record<string, unknown> | undefined) ?? null;
  }
  async run() {
    return this.exec();
  }
}

export function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of ["0001_init.sql", "0002_dashboard_lock.sql"]) db.exec(readFileSync(join(__dirname, "..", "migrations", file), "utf8"));
  return {
    prepare: (sql: string) => new FakeStatement(db, sql),
    batch: async (statements: FakeStatement[]) => {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}

/** A Workers AI whose `run` answers with `reply(prompt)` (a string, an object, or throws). */
export function fakeAI(reply: (prompt: string) => unknown) {
  const run = vi.fn(async (_model: string, input: { messages: { content: string }[] }) => {
    const answer = reply(input.messages[0].content);
    return { response: answer };
  });
  const toMarkdown = vi.fn(async () => ({ id: "1", name: "cv.pdf", mimeType: "application/pdf", format: "markdown", tokens: 1, data: "Asha Rao. Data analyst. SQL, Python." }));
  return { run, toMarkdown };
}

export type Route = [match: RegExp, answer: (url: string, init?: RequestInit) => Response | Promise<Response>];

/** Stub the global fetch with `routes` (first match wins); anything else is a test failure. */
export function stubFetch(routes: Route[]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    for (const [re, answer] of routes) if (re.test(url)) return answer(url, init);
    throw new Error(`unexpected fetch ${url}`);
  }));
  return calls;
}

export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
