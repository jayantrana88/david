/** The dashboard's JSON API (src/api/): the password gate, validation, and the shapes web/src/lib/types.ts relies on. */
import { describe, expect, it } from "vitest";
import { hashPassword, sessionCookie } from "../src/api/auth";
import { handle } from "../src/api/router";
import { workerHost } from "../src/api/worker";
import { Db } from "../src/db";
import { fakeD1 } from "./fakes";

const ORIGIN = "https://david.example";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function setup() {
  const d1 = fakeD1();
  const env = { DB: d1 } as unknown as Env;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(
      new Request(ORIGIN + path, {
        method,
        headers: { Origin: ORIGIN, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      workerHost(env, ctx),
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { db: new Db(d1), call };
}

const TASK = { categories: "software company", locations: "Berlin", candidates: "5", max_employees: "50", metro_radius_km: "", target_role: "", opportunity_type: "" };

describe("session and the password gate", () => {
  it("is open until a password is stored", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/session")).json).toEqual({ locked: false, signedIn: true, worker: true });
    expect((await call("GET", "/api/tasks")).status).toBe(200);
  });

  it("answers 401 to every call without the session cookie once locked, and lets the cookie through", async () => {
    const { db, call } = setup();
    const hash = await hashPassword("correct horse");
    await db.run("INSERT INTO dashboard_lock (id, password_hash) VALUES (1, ?)", [hash]);
    expect((await call("GET", "/api/session")).json).toMatchObject({ locked: true, signedIn: false });
    expect((await call("GET", "/api/tasks")).status).toBe(401);
    expect((await call("POST", "/api/tasks", TASK)).status).toBe(401);

    const cookie = (await sessionCookie(`db:${hash}`)).split(";")[0];
    expect((await call("GET", "/api/tasks", undefined, { Cookie: cookie })).status).toBe(200);
    expect((await call("GET", "/api/session", undefined, { Cookie: cookie })).json).toMatchObject({ signedIn: true });
  });

  it("signs in with the right password only", async () => {
    const { db, call } = setup();
    await db.run("INSERT INTO dashboard_lock (id, password_hash) VALUES (1, ?)", [await hashPassword("correct horse")]);
    const wrong = await call("POST", "/api/login", { password: "wrong" });
    expect(wrong.json).toMatchObject({ ok: false });
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
    const right = await call("POST", "/api/login", { password: "correct horse" });
    expect(right.json).toMatchObject({ ok: true });
    expect(right.headers.get("Set-Cookie")).toContain("ja_session=");
  });

  it("refuses a POST from another origin", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/tasks", TASK, { Origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("tasks", () => {
  it("validates the form and reports each field", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/tasks", { ...TASK, categories: "", candidates: "0", max_employees: "abc" });
    expect(res.json.ok).toBe(false);
    expect(res.json.fieldErrors).toMatchObject({ categories: expect.any(String), candidates: "At least 1.", max_employees: "Enter a number." });
  });

  it("adds one task per category × location, lists them with a count per status, and re-queues / deletes by id", async () => {
    const { call } = setup();
    const created = await call("POST", "/api/tasks", { ...TASK, categories: "software company\ndesign agency", locations: "Berlin\nMunich", repeat_daily: true });
    expect(created.json).toMatchObject({ ok: true, message: "4 tasks added. They run one at a time, oldest first." });

    const list = (await call("GET", "/api/tasks?status=pending")).json;
    expect(list.total).toBe(4);
    expect(list.counts).toEqual([4, 0, 0, 0]); // pending, running, completed, failed
    expect(list.rows[0]).toMatchObject({ status: "pending", repeat_daily: true, candidates: 5, max_employees: 50 });
    expect(list.rows[0]).not.toHaveProperty("cursor");

    const id = list.rows[0].id;
    expect((await call("POST", `/api/tasks/${id}/requeue`)).json.ok).toBe(false); // only a finished task can be re-run
    expect((await call("POST", `/api/tasks/${id}/repeat`, { repeat: false })).json.ok).toBe(true);
    expect((await call("POST", `/api/tasks/${id}/update`, { ...TASK, category: "robotics", location: "Hamburg" })).json.ok).toBe(true);
    expect((await call("POST", `/api/tasks/${id}/delete`)).json.ok).toBe(true);
    expect((await call("GET", "/api/tasks")).json.total).toBe(3);
  });

  it("caps one submission at 50 searches", async () => {
    const { call } = setup();
    const many = Array.from({ length: 8 }, (_, i) => `c${i}`).join("\n");
    const res = await call("POST", "/api/tasks", { ...TASK, categories: many, locations: many });
    expect(res.json).toMatchObject({ ok: false, message: expect.stringContaining("at most 50") });
  });
});

describe("lists", () => {
  async function seeded() {
    const s = setup();
    await s.db.run("INSERT INTO websites (id, name, website_url, email) VALUES ('aa11', 'Acme Labs', 'https://acme.example', 'hi@acme.example'), ('bb22', 'Beta', 'https://beta.example', NULL)");
    await s.db.run("INSERT INTO website_scrapes (id, website_id, summary, is_qualified) VALUES ('cc33', 'aa11', 'Builds tools', 1), ('dd44', 'bb22', 'A studio', 0)");
    await s.db.run("INSERT INTO website_pages (id, scrape_id, page_name, page_url, content_json) VALUES ('ee55', 'cc33', 'About', 'https://acme.example/about', '{\"content\":\"We are Acme\"}'), ('ff66', 'cc33', 'Jobs', 'https://acme.example/jobs', NULL)");
    await s.db.run("INSERT INTO cold_emails (id, website_id, email_address, subject, body, status) VALUES ('1177', 'aa11', 'hi@acme.example', 'Hello', 'Hi', 'draft')");
    return s;
  }

  it("companies: nested rows, counts and the email filter", async () => {
    const { call } = await seeded();
    const all = (await call("GET", "/api/websites")).json;
    expect(all.total).toBe(2);
    expect(all.counts).toEqual({ all: 2, withEmail: 1 });
    expect((await call("GET", "/api/websites?email=without")).json.rows.map((r: { name: string }) => r.name)).toEqual(["Beta"]);
    expect((await call("GET", "/api/websites?q=acme")).json.total).toBe(1);
  });

  it("fit checks: true / false verdicts, the company nested, counts [qualified, not a fit, awaiting]", async () => {
    const { call } = await seeded();
    const res = (await call("GET", "/api/scrapes?verdict=qualified")).json;
    expect(res.counts).toEqual([1, 1, 0]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ is_qualified: true, websites: { name: "Acme Labs", website_url: "https://acme.example" } });
  });

  it("pages: has_content without the content, the content on request, and a re-read", async () => {
    const { call } = await seeded();
    const res = (await call("GET", "/api/pages?content=failed")).json;
    expect(res.counts).toEqual({ all: 2, failed: 1 });
    expect(res.rows[0]).toMatchObject({ page_name: "Jobs", has_content: false });
    expect(res.rows[0]).not.toHaveProperty("content_json");
    expect((await call("GET", "/api/pages/ee55/content")).json).toEqual({ content: { content: "We are Acme" } });
    expect((await call("POST", "/api/pages/reread", { scrape_id: "cc33" })).json.message).toContain("2 pages deleted");
  });

  it("applications: a draft can be retried, and the retry removes its row", async () => {
    const { call } = await seeded();
    const res = (await call("GET", "/api/emails")).json;
    expect(res.counts).toEqual([1, 0, 0, 0, 0, 0]); // draft, sending, sent, send_failed, rejected, generation_failed
    expect(res.rows[0]).toMatchObject({ status: "draft", websites: { name: "Acme Labs" } });
    expect((await call("POST", "/api/emails/1177/retry")).json.ok).toBe(true);
    expect((await call("GET", "/api/emails")).json.total).toBe(0);
  });

  it("a verdict override and a company edit", async () => {
    const { call } = await seeded();
    expect((await call("POST", "/api/scrapes/dd44/verdict", { verdict: true })).json.ok).toBe(true);
    expect((await call("GET", "/api/scrapes?verdict=qualified")).json.total).toBe(2);
    const bad = await call("POST", "/api/websites/bb22/update", { email: "not an address", phone_number: "", owner: "" });
    expect(bad.json.fieldErrors).toHaveProperty("email");
    expect((await call("POST", "/api/websites/bb22/update", { email: "a@b.co, c@d.co", phone_number: "", owner: "" })).json.ok).toBe(true);
  });

  it("overview: counts, the stages and what is left to set up", async () => {
    const { call } = await seeded();
    const res = (await call("GET", "/api/overview")).json;
    expect(res.n).toMatchObject({ websites: 2, qualified: 1, rejected: 1, pages: 2, failedPages: 1, emails: 1, email_draft: 1 });
    expect(res.stages.map((s: { stage: string }) => s.stage)).toEqual(["profile", "sourcing", "scrape", "internal", "email"]);
    expect(res.setup).toEqual({ profile: false, keys: false, task: false });
  });
});

describe("profile and settings", () => {
  it("saves the derived fields (validated) and marks the profile ready", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/profile")).json.profile).toBeNull();
    const bad = await call("POST", "/api/profile/fields", { opportunity_type: "either", experience_years: "99", linkedin_url: "nope" });
    expect(bad.json.fieldErrors).toMatchObject({ experience_years: expect.any(String), linkedin_url: "Use a full http(s):// link." });
    const good = await call("POST", "/api/profile/fields", { full_name: "Ada", skills: "ts, sql\nrust", target_roles: "Engineer", opportunity_type: "internship", experience_years: "2", linkedin_url: "https://linkedin.com/in/ada" });
    expect(good.json.ok).toBe(true);
    expect((await call("GET", "/api/profile")).json.profile).toMatchObject({ full_name: "Ada", skills: ["ts", "sql", "rust"], parse_status: "done", opportunity_type: "internship" });
  });

  it("saves settings with their limits, keeps keys write-only, and deletes drafts when going to send", async () => {
    const { db, call } = setup();
    expect((await call("POST", "/api/settings", { ai_qualify_batch: "99" })).json.fieldErrors).toHaveProperty("ai_qualify_batch");
    expect((await call("POST", "/api/settings", { ai_base_url: "http://insecure" })).json.fieldErrors).toHaveProperty("ai_base_url");

    await db.run("INSERT INTO websites (id, name, website_url) VALUES ('aa11', 'Acme', 'https://acme.example')");
    await db.run("INSERT INTO cold_emails (id, website_id, status) VALUES ('1177', 'aa11', 'draft')");
    const saved = await call("POST", "/api/settings", { email_mode: "send", email_enabled: true, ai_qualify_batch: "7" });
    expect(saved.json.message).toContain("drafts were deleted");
    expect((await call("GET", "/api/emails")).json.total).toBe(0);

    expect((await call("POST", "/api/settings/secret", { key: "serper_api_key", value: "sk-abcd1234" })).json.ok).toBe(true);
    const read = (await call("GET", "/api/settings")).json;
    expect(read.fields).toMatchObject({ email_mode: "send", ai_qualify_batch: 7 });
    expect(read.secrets.find((s: { key: string }) => s.key === "serper_api_key")).toEqual(expect.objectContaining({ set: true, last4: "1234" }));
    expect(JSON.stringify(read)).not.toContain("sk-abcd1234");
    expect((await call("POST", "/api/settings/secret", { key: "bogus", value: "x" })).json.ok).toBe(false);
  });

  it("sets, changes and removes the dashboard password", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/settings/password", { password: "short", confirm: "short" })).json.ok).toBe(false);
    expect((await call("POST", "/api/settings/password", { password: "long enough pw", confirm: "different pw" })).json.ok).toBe(false);
    const set = await call("POST", "/api/settings/password", { password: "long enough pw", confirm: "long enough pw" });
    expect(set.json.ok).toBe(true);
    const cookie = set.headers.get("Set-Cookie")!.split(";")[0];
    const authed = { Cookie: cookie };
    expect((await call("GET", "/api/settings", undefined, authed)).json.lock).toMatchObject({ locked: true, fromSecret: false });
    expect((await call("POST", "/api/settings/password/remove", { current: "wrong" }, authed)).json.ok).toBe(false);
    expect((await call("POST", "/api/settings/password/remove", { current: "long enough pw" }, authed)).json.ok).toBe(true);
    expect((await call("GET", "/api/session")).json.locked).toBe(false);
  });
});

describe("routing", () => {
  it("answers 404 JSON for an unknown API path", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/nope")).status).toBe(404);
  });
});
