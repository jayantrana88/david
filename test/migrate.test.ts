import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitSql } from "../src/migrate";

describe("splitSql", () => {
  it("splits on top-level semicolons and ignores quotes and comments", () => {
    expect(splitSql("CREATE TABLE a (x TEXT DEFAULT ';'); -- c;\nINSERT INTO a VALUES ('y'); /* ; */ SELECT 1")).toEqual([
      "CREATE TABLE a (x TEXT DEFAULT ';')",
      "INSERT INTO a VALUES ('y')",
      "SELECT 1",
    ]);
  });

  it("keeps a trigger whole", () => {
    const sql = "CREATE TRIGGER t AFTER UPDATE ON a\nBEGIN\n  UPDATE a SET x = 1;\nEND;\nSELECT 2;";
    const parts = splitSql(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^CREATE TRIGGER[\s\S]*END$/);
  });

  it("splits the real schema into whole statements", () => {
    const parts = splitSql(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
    expect(parts.length).toBeGreaterThan(10);
    expect(parts.filter((p) => /^CREATE TRIGGER/i.test(p)).every((p) => /END$/i.test(p))).toBe(true);
  });
});
