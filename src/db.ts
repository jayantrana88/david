/**
 * D1 access. Every query takes `?` params; JSON columns are decoded and booleans turned into true/false at
 * the edge (codec.ts). Writes that must land together go through `db.batch([...])`, which D1 runs as one transaction.
 */
import { decode, encode, type Row } from "./codec";

export { decode, encode, insertSql, setClause, type Row } from "./codec";

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
