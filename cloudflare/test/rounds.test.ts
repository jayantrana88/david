/**
 * Every stage, and whole ticks, against the real migration on SQLite with a fake AI and stubbed outside
 * services (the daemon's tests/test_rounds.py and test_queues.py, for the Worker).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Ctx, Logger } from "../src/core";
import { Db } from "../src/db";
import { tick } from "../src/runner";
import { configFrom } from "../src/settings";
import { runEmail } from "../src/stages/email";
import { runInternal } from "../src/stages/internal";
import { runProfile } from "../src/stages/profile";
import { runScrape } from "../src/stages/scrape";
import { runSourcing } from "../src/stages/sourcing";
import { fakeAI, fakeD1, json, stubFetch } from "./fakes";

const GOOD_BODY =
  "I came across your work on logistics dashboards for small retailers and it lines up closely with what I " +
  "have been building in my final year projects with Python and SQL.\n\n" +
  "Over the last year I cleaned and modelled sales data for a local cooperative, built weekly reports in " +
  "Power BI and automated the exports, which saved the team several hours every week.\n\n" +
  "I would love to help as a data analyst intern. My resume is attached and my profile is at " +
  "https://linkedin.com/in/asha if you would like more detail.";

let db: Db;
let env: Env;
let ai: ReturnType<typeof fakeAI>;
let answer: (prompt: string) => unknown;

function ctx(settings: Record<string, unknown> = {}, keys: Record<string, unknown> = {}): Ctx {
  return { env, db, cfg: configFrom(settings, { serper_api_key: "k", ...keys }), log: new Logger("test"), now: new Date() };
}

async function seedProfile(withResume = true) {
  await db.run("INSERT INTO resume_files (sha256, filename, mime, size, base64) VALUES ('abc', 'cv.pdf', 'application/pdf', 4, ?)", [btoa("%PDF")]);
  await db.run(`INSERT INTO candidate_profile (id, full_name, headline, target_roles, linkedin_url, parse_status, resume_sha256, resume_filename, resume_path)
                VALUES (1, 'Asha Rao', 'Data analyst', '["Data Analyst"]', 'https://linkedin.com/in/asha', 'done', ?, 'cv.pdf', 'abc')`, [withResume ? "abc" : null]);
}

async function seedWebsite(id = "w1", url = "https://acme.com") {
  await db.run("INSERT INTO websites (id, name, website_url, url_key, category, location) VALUES (?, 'Acme Labs', ?, 'acme.com', 'software company', 'Dublin')", [id, url]);
}

const jinaHome = () => json({
  code: 200,
  data: {
    title: "Acme Labs", description: "Dashboards for retailers", url: "https://acme.com/",
    content: "We build logistics dashboards. Contact hello@acme.com. [About](https://acme.com/about)",
    links: { About: "https://acme.com/about", Services: "https://acme.com/services", Privacy: "https://acme.com/privacy" },
  },
});
const jinaPage = (url: string) => json({ code: 200, data: { title: url, description: "", content: `Text of ${url}. Mail jobs@acme.com`, links: {} } });

beforeEach(() => {
  db = new Db(fakeD1());
  answer = () => {
    throw new Error("no AI answer set");
  };
  ai = fakeAI((p) => answer(p));
  env = { DB: db.d1, AI: ai, BROWSER: {} } as unknown as Env;
});
afterEach(() => vi.unstubAllGlobals());

describe("profile", () => {
  it("derives the profile from the resume and notes, and applies it only if unchanged", async () => {
    await db.run("INSERT INTO resume_files (sha256, filename, mime, size, base64) VALUES ('abc', 'cv.pdf', 'application/pdf', 4, ?)", [btoa("%PDF")]);
    await db.run("INSERT INTO candidate_profile (id, resume_sha256, resume_filename, career_notes, parse_status) VALUES (1, 'abc', 'cv.pdf', 'I want an internship', 'pending')");
    answer = () => ({ full_name: "Asha Rao", headline: "Data analyst", summary: "", skills: ["SQL"], experience_years: 0, education: "", target_roles: ["Data Analyst Intern"], opportunity_type: "internship", phone: "", linkedin_url: "", portfolio_url: "" });
    const r = await runProfile(ctx());
    expect(r.succeeded).toBe(1);
    const row = await db.get<Record<string, unknown>>("SELECT * FROM candidate_profile");
    expect(row).toMatchObject({ parse_status: "done", full_name: "Asha Rao", target_roles: ["Data Analyst Intern"], opportunity_type: "internship", resume_text: "Asha Rao. Data analyst. SQL, Python." });
    expect((await runProfile(ctx())).worked).toBe(false);
  });

  it("records an unusable reply as failed", async () => {
    await db.run("INSERT INTO candidate_profile (id, career_notes, parse_status) VALUES (1, 'notes', 'pending')");
    answer = () => "I can't";
    await runProfile(ctx());
    expect(await db.get("SELECT parse_status, parse_error FROM candidate_profile")).toMatchObject({ parse_status: "failed" });
  });
});

describe("scrape", () => {
  it("waits for the profile", async () => {
    await seedWebsite();
    expect((await runScrape(ctx())).worked).toBe(false);
  });

  it("reads the homepage, judges the fit in one batch, saves emails and main links", async () => {
    await seedProfile();
    await seedWebsite("w1", "https://acme.com");
    await seedWebsite("w2", "https://dead.example");
    stubFetch([[/r\.jina\.ai\/https:\/\/acme\.com$/, jinaHome], [/r\.jina\.ai\/https:\/\/dead/, () => new Response("bad", { status: 422 })]]);
    answer = () => ({ summary: "Makes dashboards.", qualified: true });
    const r = await runScrape(ctx());
    expect(r).toMatchObject({ worked: true, succeeded: 2 });
    const rows = await db.all<Record<string, unknown>>("SELECT website_id, is_qualified, summary, main_links FROM website_scrapes ORDER BY website_id");
    expect(rows[0]).toMatchObject({ website_id: "w1", is_qualified: true, summary: "Makes dashboards.", main_links: { About: "https://acme.com/about", Services: "https://acme.com/services" } });
    expect(rows[1]).toMatchObject({ website_id: "w2", is_qualified: false });
    expect(await db.get("SELECT email FROM websites WHERE id = 'w1'")).toEqual({ email: "hello@acme.com" });
    expect(ai.run).toHaveBeenCalledTimes(1);     // one company to judge: asked alone, not batched
    expect((await runScrape(ctx())).worked).toBe(false);
  });

  it("keeps the read when the AI is out of quota, holds, and later asks only the AI", async () => {
    await seedProfile();
    await seedWebsite();
    const calls = stubFetch([[/r\.jina\.ai/, jinaHome]]);
    answer = () => {
      throw new Error("4006: you have used up your daily free allocation of 10,000 neurons");
    };
    const r = await runScrape(ctx());
    expect(r.hold?.secs).toBeGreaterThan(60);
    expect(await db.get("SELECT is_qualified, homepage_text IS NOT NULL AS saved FROM website_scrapes")).toEqual({ is_qualified: null, saved: 1 });
    answer = () => ({ summary: "Dashboards.", qualified: false });
    await runScrape(ctx());
    expect(await db.get("SELECT is_qualified FROM website_scrapes")).toEqual({ is_qualified: false });
    expect(calls.filter((u) => u.includes("jina")).length).toBe(1);    // not read again
  });
});

describe("internal and email", () => {
  async function qualifiedLead() {
    await seedProfile();
    await seedWebsite();
    await db.run(`INSERT INTO website_scrapes (id, website_id, is_qualified, summary, main_links) VALUES ('s1', 'w1', 1, 'Dashboards.', ?)`,
      [JSON.stringify({ About: "https://acme.com/about", Team: "https://acme.com/team" })]);
  }

  it("reads the internal pages, adds their emails, then a placeholder is replaced on retry", async () => {
    await qualifiedLead();
    await db.run("UPDATE websites SET email = 'hello@acme.com' WHERE id = 'w1'");
    stubFetch([[/r\.jina\.ai/, () => new Response("down", { status: 500 })]]);
    await runInternal(ctx());
    expect(await db.all("SELECT page_name, content_json FROM website_pages")).toEqual([{ page_name: "Internal pages", content_json: null }]);
    await db.run("DELETE FROM backoff");
    vi.unstubAllGlobals();
    stubFetch([[/r\.jina\.ai\/https:\/\/(.*)/, (url) => jinaPage(url.replace("https://r.jina.ai/", ""))]]);
    const r = await runInternal(ctx());
    expect(r.note).toContain("2 page(s) saved");
    expect(await db.all("SELECT page_name FROM website_pages ORDER BY page_name")).toEqual([{ page_name: "About" }, { page_name: "Team" }]);
    expect(await db.get("SELECT email FROM websites")).toEqual({ email: "hello@acme.com, jobs@acme.com" });
  });

  async function readyForEmail() {
    await qualifiedLead();
    await db.run("UPDATE websites SET email = 'hello@acme.com' WHERE id = 'w1'");
    await db.run(`INSERT INTO website_pages (scrape_id, page_name, page_url, content_json) VALUES ('s1', 'About', 'https://acme.com/about', ?)`,
      [JSON.stringify({ title: "About", description: "", content: "x".repeat(5000) })]);
  }

  it("saves a dry-run draft, composed, with the resume's name", async () => {
    await readyForEmail();
    let prompt = "";
    answer = (p) => {
      prompt = p;
      return { subject: "Data analyst intern for Acme?", body: GOOD_BODY };
    };
    const r = await runEmail(ctx());
    expect(r.succeeded).toBe(1);
    const row = await db.get<Record<string, string>>("SELECT * FROM cold_emails");
    expect(row).toMatchObject({ status: "draft", email_address: "hello@acme.com", attachment_name: "cv.pdf", subject: "Data analyst intern for Acme?" });
    expect(row?.body.startsWith("Hi Acme Labs team,\n\nI came across")).toBe(true);
    expect(row?.body.endsWith("Best regards,\nAsha Rao\nhttps://linkedin.com/in/asha")).toBe(true);
    expect(prompt).toContain("- Asking about: Data Analyst (job or internship)");
    expect(prompt.length).toBeLessThan(12000);      // the page text was cut in SQL
    expect((await runEmail(ctx())).worked).toBe(false);
  });

  it("rewrites a draft that breaks the rules, and records generation_failed in send mode", async () => {
    await readyForEmail();
    answer = () => ({ subject: "Hi", body: "Too short — sorry." });
    stubFetch([[/api\.telegram\.org/, () => json({ ok: true, result: { message_id: 1 } })]]);
    const r = await runEmail(ctx({ email_mode: "send" }, { telegram_bot_token: "t", telegram_chat_id: "c" }));
    expect(r.failed).toBe(1);
    expect(ai.run).toHaveBeenCalledTimes(3);       // first draft + 2 rewrites
    expect(await db.get("SELECT status FROM cold_emails")).toEqual({ status: "generation_failed" });
  });

  it("sends through Telegram with copy buttons, and keeps one row per lead", async () => {
    await readyForEmail();
    await db.run("INSERT INTO cold_emails (website_id, status) VALUES ('w1', 'send_failed')");
    answer = () => ({ subject: "Data analyst intern for Acme?", body: GOOD_BODY });
    let posted: Record<string, unknown> = {};
    stubFetch([[/api\.telegram\.org\/bott\/sendMessage/, (_u, init) => {
      posted = JSON.parse(String(init?.body));
      return json({ ok: true, result: { message_id: 42 } });
    }]]);
    await runEmail(ctx({ email_mode: "send" }, { telegram_bot_token: "t", telegram_chat_id: "c" }));
    expect(await db.all("SELECT status, delivery, sent_at IS NOT NULL AS stamped FROM cold_emails")).toEqual([{ status: "sent", delivery: "telegram", stamped: 1 }]);
    expect(posted).toMatchObject({ chat_id: "c", parse_mode: "HTML" });
    expect(JSON.stringify(posted.reply_markup)).toContain("hello@acme.com");
  });

  it("leaves an unanswered Gmail send as 'sending', never retried", async () => {
    await readyForEmail();
    await db.run("INSERT INTO mail_tokens (provider, refresh_token, email, access_token, expires_at) VALUES ('gmail', 'r', 'asha@gmail.com', 'a', '2999-01-01T00:00:00.000Z')");
    answer = () => ({ subject: "Data analyst intern for Acme?", body: GOOD_BODY });
    stubFetch([[/gmail\.googleapis\.com/, () => {
      throw new TypeError("network connection lost");
    }]]);
    await runEmail(ctx({ email_mode: "send", email_delivery: "gmail" }, { gmail_client_id: "id", gmail_client_secret: "s" }));
    expect(await db.get("SELECT status FROM cold_emails")).toEqual({ status: "sending" });
    expect((await runEmail(ctx({ email_mode: "send", email_delivery: "gmail" }, { gmail_client_id: "id", gmail_client_secret: "s" }))).worked).toBe(false);
  });

  it("holds at the daily cap", async () => {
    await readyForEmail();
    await db.run("INSERT INTO cold_emails (website_id, status, sent_at) VALUES ('w1', 'sent', ?)", [new Date().toISOString()]);
    const r = await runEmail(ctx({ email_mode: "send", email_max_sends_per_day: 1 }, { telegram_bot_token: "t", telegram_chat_id: "c" }));
    expect(r.hold?.reason).toContain("max sends per day");
  });
});

describe("sourcing", () => {
  const COMPANY = (slug: string, size: string, site: string, city = "Dublin") => `<html><head><script type="application/ld+json">
{"@type":"Organization","name":"${slug}","sameAs":"${site}","address":{"addressCountry":"IE","addressLocality":"${city}"}}</script></head>
<body><dl><dt>Company size</dt><dd>${size}</dd><dt>Headquarters</dt><dd>${city}</dd></dl></body></html>`;

  function routes(pages: Record<string, string>) {
    return stubFetch([
      [/geocoding-api\.open-meteo\.com.*name=Dublin/, () => json({ results: [{ id: 1, name: "Dublin", latitude: 53.33, longitude: -6.25, feature_code: "PPLC", country_code: "IE", admin1: "Leinster", population: 1024027 }] })],
      [/geocoding-api\.open-meteo\.com/, () => json({})],
      [/google\.serper\.dev/, (_u, init) => {
        const page = JSON.parse(String(init?.body)).page;
        return json({ organic: page === 1 ? Object.keys(pages).map((slug) => ({ title: `${slug} | LinkedIn`, link: `https://ie.linkedin.com/company/${slug}` })) : [] });
      }],
      [/linkedin\.com\/company\/([a-z-]+)/, (url) => new Response(pages[/company\/([a-z-]+)/.exec(url)![1]], { status: 200 })],
      [/^https:\/\/(small|tiny)\.ie/, () => new Response("ok", { status: 200 })],
    ]);
  }

  it("works a task over several ticks and completes it, saving only companies that pass", async () => {
    routes({
      small: COMPANY("Small", "2-10 employees", "https://small.ie"),
      big: COMPANY("Big", "201-500 employees", "https://big.ie"),
      abroad: COMPANY("Abroad", "2-10 employees", "https://abroad.ie", "Cork"),
      tiny: COMPANY("Tiny", "11-50 employees", "tiny.ie"),
    });
    await db.run("INSERT INTO tasks (category, location, candidates, max_employees) VALUES ('software company', 'Dublin', 5, 50)");
    const settings = { linkedin_transport: "fetch", sourcing_per_tick: 2 };
    const first = await runSourcing(ctx(settings));
    expect(first.note).toContain("1/5 saved");
    expect(await db.get("SELECT status, leads_saved FROM tasks")).toEqual({ status: "running", leads_saved: 1 });
    expect((await runSourcing(ctx(settings))).note).toContain("2/5 saved");
    expect(await db.get("SELECT status FROM tasks")).toEqual({ status: "running" });   // page 2 not asked for yet
    await runSourcing(ctx(settings));
    const task = await db.get<Record<string, unknown>>("SELECT status, leads_saved, error FROM tasks");
    expect(task).toMatchObject({ status: "completed", leads_saved: 2 });
    expect(String(task?.error)).toContain("fewer leads than wanted: 2 of 5");
    expect(String(task?.error)).toContain("size: too big");
    expect(await db.all("SELECT website_url, url_key, employee_max FROM websites ORDER BY website_url")).toEqual([
      { website_url: "https://small.ie", url_key: "small.ie", employee_max: 10 },
      { website_url: "https://tiny.ie", url_key: "tiny.ie", employee_max: 50 },
    ]);
    expect(await db.get("SELECT COUNT(*) AS n FROM geo_cache")).toMatchObject({ n: expect.any(Number) });
  });

  it("holds on a LinkedIn block and fails the task after three in a row", async () => {
    stubFetch([
      [/open-meteo/, () => json({ results: [{ id: 1, name: "Dublin", latitude: 53.33, longitude: -6.25, feature_code: "PPLC", country_code: "IE", admin1: "Leinster", population: 1024027 }] })],
      [/serper/, () => json({ organic: [{ title: "A", link: "https://www.linkedin.com/company/a" }, { title: "B", link: "https://www.linkedin.com/company/b" }] })],
      [/linkedin\.com/, () => new Response("", { status: 999 })],
    ]);
    await db.run("INSERT INTO tasks (category, location) VALUES ('agency', 'Dublin')");
    const c = ctx({ linkedin_transport: "fetch" });
    for (let i = 0; i < 2; i++) await expect(runSourcing(c)).rejects.toThrow(/LinkedIn refused/);
    const r = await runSourcing(c);
    expect(r.note).toContain("failed: LinkedIn refused 3 pages in a row");
    expect(await db.get("SELECT status FROM tasks")).toEqual({ status: "failed" });
  });
});

describe("tick", () => {
  it("runs one stage per tick, marks the empty ones idle, and holds a stage that fails", async () => {
    await seedProfile();
    await seedWebsite();
    stubFetch([[/r\.jina\.ai/, jinaHome]]);
    answer = () => {
      throw new Error("10000: Authentication error");
    };
    const out = await tick(env);
    expect(out).toMatch(/^scrape: /);
    const states = await db.all<Record<string, unknown>>("SELECT stage, idle_until IS NOT NULL AS idle, hold_until IS NOT NULL AS held, lease_until FROM stage_state ORDER BY stage");
    expect(states.find((s) => s.stage === "scrape")).toMatchObject({ held: 1, idle: 0, lease_until: null });
    expect(states.find((s) => s.stage === "profile")).toMatchObject({ idle: 1 });
    expect(await tick(env)).toBe("nothing to do");     // scrape held, the rest idle
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM logs"))?.n).toBeGreaterThan(0);
  });
});
