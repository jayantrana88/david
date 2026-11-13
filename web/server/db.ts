/** The daemon's SQLite file, opened for the local dashboard server (the same tables the Worker keeps in D1). */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { decode, encode, type Row } from "../../src/codec";
import type { ApiDb } from "../../src/api/http";

/** Columns added after the first schema (daemon/core/sqlite.py ADDED_COLUMNS): an older file gets them on open. */
const ADDED_COLUMNS: [table: string, column: string, declaration: string][] = [
  ["website_scrapes", "homepage_text", "TEXT"],
  ["app_settings", "email_delivery", "TEXT CHECK (email_delivery IS NULL OR email_delivery IN ('telegram', 'gmail', 'outlook'))"],
  ["cold_emails", "delivery", "TEXT"],
  ["app_settings", "ai_model", "TEXT"],
  ["app_settings", "cloudflare_account_id", "TEXT"],
  ["app_secrets", "telegram_bot_token", "TEXT"],
  ["app_secrets", "telegram_chat_id", "TEXT"],
  ["app_secrets", "gmail_client_id", "TEXT"],
  ["app_secrets", "gmail_client_secret", "TEXT"],
  ["app_secrets", "outlook_client_id", "TEXT"],
  ["app_secrets", "outlook_client_secret", "TEXT"],
  ["tasks", "repeat_daily", "INTEGER NOT NULL DEFAULT 0 CHECK (repeat_daily IN (0, 1))"],
  ["app_settings", "email_instructions", "TEXT"],
];

/** Open (and create) the database file: the schema is applied on every open, so either side may create it. */
export function openDatabase(file: string, schemaFile: string): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  conn.exec(fs.readFileSync(schemaFile, "utf8"));
  for (const [table, column, declaration] of ADDED_COLUMNS) {
    const have = (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    if (!have) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
  return conn;
}

/** The handlers' database over node:sqlite: the same calls the Worker makes on D1, answered at once. */
export class LocalDb implements ApiDb {
  constructor(readonly conn: DatabaseSync) {}

  stmt(sql: string, params: unknown[] = []): { sql: string; params: unknown[] } {
    return { sql, params };
  }

  private bind(params: unknown[]): SQLInputValue[] {
    return params.map((p) => encode(p) as SQLInputValue);
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (this.conn.prepare(sql).all(...this.bind(params)) as Row[]).map((r) => decode<T>(r));
  }

  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const row = this.conn.prepare(sql).get(...this.bind(params)) as Row | undefined;
    return row ? decode<T>(row) : undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<number> {
    return Number(this.conn.prepare(sql).run(...this.bind(params)).changes);
  }

  async batch(statements: unknown[]): Promise<void> {
    this.conn.exec("BEGIN IMMEDIATE");
    try {
      for (const { sql, params } of statements as { sql: string; params: unknown[] }[]) this.conn.prepare(sql).run(...this.bind(params));
      this.conn.exec("COMMIT");
    } catch (e) {
      this.conn.exec("ROLLBACK");
      throw e;
    }
  }
}
