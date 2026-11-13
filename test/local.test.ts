/** The local dashboard server's host: the same API handlers over the daemon's SQLite schema (daemon/db/schema.sql). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handle } from "../src/api/router";
import { localHost, scryptHasher } from "../web/server/host";

const ORIGIN = "http://127.0.0.1:3000";
const SCHEMA = path.join(__dirname, "..", "daemon", "db", "schema.sql");

function setup(env: unknown = {}) {
  const resumesDir = fs.mkdtempSync(path.join(os.tmpdir(), "david-resumes-"));
  const host = localHost({ dbFile: ":memory:", schemaFile: SCHEMA, resumesDir, env });
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const isForm = body instanceof FormData;
    const res = await handle(
      new Request(ORIGIN + route, {
        method,
        headers: { Origin: ORIGIN, ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      }),
      host,
    );
    const type = res.headers.get("Content-Type") ?? "";
    const isJson = type.includes("json");
    return { status: res.status, json: isJson ? await res.json() : null, bytes: isJson ? null : new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  };
  return { host, call, resumesDir };
}

const TASK = { categories: "software company", locations: "Berlin", candidates: "5", max_employees: "50", metro_radius_km: "", target_role: "", opportunity_type: "" };

describe("local dashboard host", () => {
  it("says it is not the Worker, and has no stages", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/session")).json).toEqual({ locked: false, signedIn: true, worker: false });
    const overview = (await call("GET", "/api/overview")).json;
    expect(overview.stages).toBeUndefined();
    expect(overview.n.websites).toBe(0);
  });

  it("creates, lists, edits and deletes tasks in the daemon's table; stopping one is the daemon's job", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/tasks", { ...TASK, categories: "a\nb", repeat_daily: true })).json.ok).toBe(true);
    const list = (await call("GET", "/api/tasks")).json;
    expect(list.total).toBe(2);
    expect(list.rows[0]).toMatchObject({ status: "pending", repeat_daily: true, candidates: 5 });
    const id = list.rows[0].id;
    expect((await call("POST", `/api/tasks/${id}/update`, { ...TASK, category: "robotics", location: "Hamburg" })).json.ok).toBe(true);
    expect((await call("POST", `/api/tasks/${id}/stop`)).json.ok).toBe(false);
    expect((await call("POST", `/api/tasks/${id}/delete`)).json.ok).toBe(true);
    expect((await call("GET", "/api/tasks")).json.total).toBe(1);
  });

  it("lists companies, fit checks, pages and applications over the same rows", async () => {
    const { host, call } = setup();
    const { db } = host;
    await db.run("INSERT INTO websites (id, name, website_url, email) VALUES ('aa11', 'Acme Labs', 'https://acme.example', 'hi@acme.example'), ('bb22', 'Beta', 'https://beta.example', NULL)");
    await db.run("INSERT INTO website_scrapes (id, website_id, summary, is_qualified) VALUES ('cc33', 'aa11', 'Builds tools', 1), ('dd44', 'bb22', 'A studio', 0)");
    await db.run(
      "INSERT INTO website_pages (id, scrape_id, page_name, page_url, content_json) VALUES ('ee55', 'cc33', 'About', 'https://acme.example/about', ?), ('ff66', 'cc33', 'Jobs', 'https://acme.example/jobs', NULL)",
      [JSON.stringify({ content: "We are Acme" })],
    );
    await db.run("INSERT INTO cold_emails (id, website_id, email_address, subject, body, status, delivery) VALUES ('1177', 'aa11', 'hi@acme.example', 'Hello', 'Hi', 'draft', 'telegram')");

    expect((await call("GET", "/api/websites")).json.counts).toEqual({ all: 2, withEmail: 1 });
    expect((await call("GET", "/api/scrapes?verdict=qualified")).json.rows[0]).toMatchObject({ is_qualified: true, websites: { name: "Acme Labs" } });
    expect((await call("GET", "/api/pages?content=failed")).json.rows[0]).toMatchObject({ page_name: "Jobs", has_content: false });
    expect((await call("GET", "/api/pages/ee55/content")).json).toEqual({ content: { content: "We are Acme" } });
    expect((await call("GET", "/api/emails")).json.rows[0]).toMatchObject({ status: "draft", delivery: "telegram" });
    expect((await call("GET", "/api/websites/aa11/progress")).json.scrapes[0].website_pages).toEqual([{ count: 2 }]);

    expect((await call("POST", "/api/scrapes/dd44/verdict", { verdict: null })).json.ok).toBe(true);
    expect((await call("GET", "/api/scrapes?verdict=pending")).json.total).toBe(1);
    expect((await call("POST", "/api/emails/1177/retry")).json.ok).toBe(true);
    expect((await call("POST", "/api/websites/bb22/delete")).json.ok).toBe(true); // its scrape goes with it (ON DELETE CASCADE)
    expect((await call("GET", "/api/scrapes")).json.total).toBe(1);
  });

  it("keeps the resume as a file beside the database and serves it back", async () => {
    const { call, resumesDir } = setup();
    const form = new FormData();
    form.set("resume", new File([new Uint8Array([37, 80, 68, 70, 45])], "cv.pdf", { type: "application/pdf" }));
    expect((await call("POST", "/api/profile/resume", form)).json.ok).toBe(true);
    const profile = (await call("GET", "/api/profile")).json;
    expect(profile.maxResumeMb).toBeCloseTo(5.24, 1);
    expect(profile.profile).toMatchObject({ resume_filename: "cv.pdf", parse_status: "pending" });
    expect(fs.readdirSync(resumesDir)).toEqual([expect.stringMatching(/^resume-[0-9a-f]{16}\.pdf$/)]);
    const file = await call("GET", "/api/profile/resume");
    expect(file.headers.get("Content-Type")).toBe("application/pdf");
    expect([...file.bytes!]).toEqual([37, 80, 68, 70, 45]);

    const notPdf = new FormData();
    notPdf.set("resume", new File(["x"], "cv.txt"));
    expect((await call("POST", "/api/profile/resume", notPdf)).json.ok).toBe(false);
  });

  it("saves settings the daemon reads (and bumps their version), without deleting drafts itself", async () => {
    const { host, call } = setup();
    await host.db.run("INSERT INTO websites (id, name, website_url) VALUES ('aa11', 'Acme', 'https://acme.example')");
    await host.db.run("INSERT INTO cold_emails (id, website_id, status) VALUES ('1177', 'aa11', 'draft')");
    const before = (await call("GET", "/api/settings")).json;
    expect(before).toMatchObject({ host: "local", fields: { email_mode: "dry_run", email_delivery: "telegram", email_enabled: true } });

    expect((await call("POST", "/api/settings", { email_max_sends_per_day: "0" })).json.fieldErrors).toHaveProperty("email_max_sends_per_day");
    const saved = await call("POST", "/api/settings", {
      ai_model: "groq/llama",
      email_mode: "send",
      email_delivery: "gmail",
      email_enabled: true,
      email_max_sends_per_day: "20",
      email_instructions: "Be brief.",
    });
    expect(saved.json.ok).toBe(true);
    const after = (await call("GET", "/api/settings")).json;
    expect(after.fields).toMatchObject({ ai_model: "groq/llama", email_mode: "send", email_delivery: "gmail", email_max_sends_per_day: 20, email_instructions: "Be brief." });
    expect(after.meta.version).toBe(before.meta.version + 1);
    expect((await call("GET", "/api/emails")).json.total).toBe(1); // the daemon clears the drafts when it starts in send mode

    expect((await call("POST", "/api/settings/secret", { key: "serper_api_key", value: "abcd1234" })).json.ok).toBe(true);
    const keys = (await call("GET", "/api/settings")).json;
    expect(keys.secrets.find((s: { key: string }) => s.key === "serper_api_key")).toMatchObject({ set: true, last4: "1234" });
    expect(keys.meta.version).toBe(after.meta.version + 1);
    expect(JSON.stringify(keys)).not.toContain("abcd1234");
  });

  it("locks with a scrypt hash (the format this dashboard always stored) and signs in", async () => {
    const { host, call } = setup();
    expect((await call("POST", "/api/settings/password", { password: "long enough pw", confirm: "long enough pw" })).json.ok).toBe(true);
    const row = await host.db.get<{ password_hash: string }>("SELECT password_hash FROM dashboard_lock WHERE id = 1");
    expect(await scryptHasher.verify("long enough pw", row!.password_hash)).toBe(true);
    expect((await call("GET", "/api/tasks")).status).toBe(401);
    expect((await call("POST", "/api/login", { password: "nope" })).json.ok).toBe(false);
    const login = await call("POST", "/api/login", { password: "long enough pw" });
    expect(login.json.ok).toBe(true);
    const cookie = login.headers.get("Set-Cookie")!;
    expect(cookie).not.toContain("Secure"); // plain http on 127.0.0.1
    expect((await call("GET", "/api/tasks", undefined, { Cookie: cookie.split(";")[0] })).status).toBe(200);
  });

  it("an old password (hashed by the Next.js dashboard) still works", async () => {
    const { host, call } = setup();
    await host.db.run("INSERT INTO dashboard_lock (id, password_hash) VALUES (1, ?)", [await scryptHasher.hash("old password")]);
    expect((await call("POST", "/api/login", { password: "old password" })).json.ok).toBe(true);
  });

  it("the DASHBOARD_PASSWORD environment variable locks it too", async () => {
    const { call } = setup({ DASHBOARD_PASSWORD: "from the environment" });
    expect((await call("GET", "/api/session")).json).toMatchObject({ locked: true, signedIn: false });
    expect((await call("POST", "/api/login", { password: "from the environment" })).json.ok).toBe(true);
  });

  it("has no Worker-only endpoints", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/logs")).status).toBe(404);
    expect((await call("POST", "/api/run", { stage: "email" })).status).toBe(404);
    expect((await call("GET", "/oauth/gmail/start")).status).toBe(404);
  });
});
