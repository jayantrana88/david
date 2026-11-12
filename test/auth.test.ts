/** The optional dashboard password: open until one is set, then a salted hash in D1 (or the DASHBOARD_PASSWORD secret). */
import { describe, expect, it } from "vitest";
import { Db } from "../src/db";
import { hashPassword, lockKey, passwordMatches, sessionCookie, signedIn } from "../src/web/auth";
import { fakeD1 } from "./fakes";

const env = (password?: string) => ({ DASHBOARD_PASSWORD: password }) as unknown as Env;

describe("dashboard password", () => {
  it("is open until a password is stored", async () => {
    const db = new Db(fakeD1());
    expect(await lockKey(env(), db)).toBeNull();
  });

  it("locks once a hash is stored, and only the right password matches", async () => {
    const db = new Db(fakeD1());
    const hash = await hashPassword("correct horse");
    await db.run("INSERT INTO dashboard_lock (id, password_hash) VALUES (1, ?)", [hash]);
    expect(await lockKey(env(), db)).toBe(`db:${hash}`);
    expect(await passwordMatches(env(), db, "correct horse")).toBe(true);
    expect(await passwordMatches(env(), db, "wrong horse")).toBe(false);
    expect(hash).not.toContain("correct horse");
  });

  it("salts each hash differently", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("the secret wins over a stored hash", async () => {
    const db = new Db(fakeD1());
    await db.run("INSERT INTO dashboard_lock (id, password_hash) VALUES (1, ?)", [await hashPassword("stored one")]);
    expect(await lockKey(env("secret-password"), db)).toBe("env:secret-password");
    expect(await passwordMatches(env("secret-password"), db, "secret-password")).toBe(true);
    expect(await passwordMatches(env("secret-password"), db, "stored one")).toBe(false);
  });

  it("a session is valid only for the key it was signed with", async () => {
    const cookie = (await sessionCookie("db:one")).split(";")[0];
    const req = (key: string) => signedIn(key, new Request("https://x/", { headers: { Cookie: cookie } }));
    expect(await req("db:one")).toBe(true);
    expect(await req("db:two")).toBe(false);
  });
});
