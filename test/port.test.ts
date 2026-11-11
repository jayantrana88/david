/**
 * The Worker's pure logic, against the same cases as the daemon's tests (tests/test_rules.py,
 * test_parsing.py, test_delivery.py) and expected values computed by running the Python functions on the same
 * inputs, so the TypeScript port answers exactly like the original. No network, no bindings.
 */
import { describe, expect, it } from "vitest";
import { CandidateProfile } from "../src/candidate";
import { extractEmails, pageText, selectMainLinks } from "../src/jina";
import { askInBatches, duration, LLMUnavailable, quotaWait, replyText } from "../src/llm";
import { buildMessage } from "../src/mail/mail";
import { chunkText, copyKeyboard, formatMessage } from "../src/mail/telegram";
import { parseEmailDrafts, parseJsonObject, parseProfile, parseVerdict, parseVerdicts } from "../src/prompts";
import { tickOrder } from "../src/runner";
import { type City, citiesFrom, type CityLookup, matches, resolvePlace, resolveTarget } from "../src/sourcing/geo";
import { checkLocation, classifyStatus, cleanName, companiesFrom, employeeUpperBound, isParked, normalizeWebsite, parseCompanyPage } from "../src/sourcing/linkedin";
import { checkRules, compose, greeting, pickEmail } from "../src/stages/writer";
import { base64ToBytes, normalizeUrl, norm, secsUntilUtcMidnight } from "../src/util";

const PROFILE = CandidateProfile.fromRow({
  full_name: "Asha Rao", phone: "+91 99999 00000", linkedin_url: "https://linkedin.com/in/asha", target_roles: ["Data Analyst"], parse_status: "done",
});

const GOOD_BODY =
  "I came across your work on logistics dashboards for small retailers and it lines up closely with what I " +
  "have been building in my final year projects with Python and SQL.\n\n" +
  "Over the last year I cleaned and modelled sales data for a local cooperative, built weekly reports in " +
  "Power BI and automated the exports, which saved the team several hours every week.\n\n" +
  "I would love to help as a data analyst intern. My resume is attached and my profile is at " +
  "https://linkedin.com/in/asha if you would like more detail.";

describe("email rules (test_rules.py)", () => {
  const issues = (o: { subject?: string; body?: string; attached?: boolean } = {}) =>
    checkRules({ subject: o.subject ?? "Data analyst internship enquiry", body: o.body ?? GOOD_BODY }, PROFILE.links(), o.attached ?? true);

  it("passes a good draft", () => expect(issues()).toEqual([]));

  it("reports each rule", () => {
    expect(issues({ body: "Hi team,\n\n" + GOOD_BODY }).some((i) => i.includes("greeting"))).toBe(true);
    expect(issues({ body: GOOD_BODY.replace("closely with", "closely — with") }).some((i) => i.includes("dash"))).toBe(true);
    expect(issues({ body: GOOD_BODY + " See https://example.org too." }).some((i) => i.includes("link"))).toBe(true);
    expect(issues({ body: "Too short. My resume is attached." }).some((i) => i.includes("words"))).toBe(true);
    expect(issues({ body: GOOD_BODY + "\n- one point" }).some((i) => i.includes("bullet"))).toBe(true);
    expect(issues({ body: GOOD_BODY.replace("My resume is attached and my", "My") }).some((i) => i.includes("resume"))).toBe(true);
    expect(issues({ body: GOOD_BODY.replace("My resume is attached and my", "My"), attached: false })).toEqual([]);
    expect(issues({ subject: "Hi" }).some((i) => i.includes("subject"))).toBe(true);
  });

  it("composes greeting and signature", () => {
    const text = compose("Acme Labs | Product Studio", "Body text.", PROFILE);
    expect(text.startsWith("Hi Acme Labs team,\n\nBody text.\n\nBest regards,\nAsha Rao")).toBe(true);
    expect(text).toContain("+91 99999 00000");
    expect(text).toContain("https://linkedin.com/in/asha");
    expect(greeting("")).toBe("Hi there,");
  });

  it("picks a usable address", () => {
    expect(pickEmail("noreply@acme.com, logo@2x.png, hello@acme.com")).toBe("hello@acme.com");
    expect(pickEmail("someone@sentry.io")).toBeNull();
    expect(pickEmail(null)).toBeNull();
  });

  it("describes the candidate and what they ask about", () => {
    expect(PROFILE.seeking(null, "internship")).toBe("Data Analyst (internship)");
    expect(PROFILE.seeking("Backend Developer", null)).toBe("Backend Developer (job or internship)");
    expect(PROFILE.brief()).toContain("- Roles wanted: Data Analyst");
    expect(PROFILE.ready).toBe(true);
  });
});

describe("reading replies (test_parsing.py)", () => {
  it("tolerates fences and thinking", () => {
    expect(parseVerdict('<think>hmm</think>```json\n{"summary": "Makes apps.", "qualified": true}\n```')).toEqual({ qualified: true, summary: "Makes apps." });
    expect(parseVerdict('{"qualified": "yes"}')).toBeNull();
    expect(parseVerdict("no json here")).toBeNull();
    expect(parseJsonObject("[1, 2]")).toBeNull();
  });

  it("drops unclear batch verdicts", () => {
    const reply = `{"results": [
      {"number": 1, "qualified": true, "summary": "A"},
      {"number": 2, "qualified": "maybe"},
      {"number": 3, "qualified": false}, {"number": 3, "qualified": true},
      {"number": 9, "qualified": true},
      {"number": "4", "qualified": false}
    ]}`;
    expect([...parseVerdicts(reply, 4)]).toEqual([[1, { qualified: true, summary: "A" }], [4, { qualified: false, summary: null }]]);
  });

  it("needs subject and body in batch drafts", () => {
    const reply = `{"emails": [{"number": 1, "subject": "S1", "body": "B1"}, {"number": 2, "subject": "", "body": "B2"}, {"number": 3, "subject": "S3", "body": "B3"}]}`;
    expect([...parseEmailDrafts(reply, 3)]).toEqual([[1, ["S1", "B1"]], [3, ["S3", "B3"]]]);
  });

  it("cleans the profile", () => {
    const out = parseProfile(`{"full_name": " Asha ", "headline": "CS student", "skills": ["SQL", "", "Python"],
      "target_roles": ["A", "B", "C", "D"], "experience_years": "1.5", "opportunity_type": "Internship"}`)!;
    expect(out.full_name).toBe("Asha");
    expect(out.skills).toEqual(["SQL", "Python"]);
    expect(out.target_roles).toEqual(["A", "B", "C"]);
    expect(out.experience_years).toBe(1.5);
    expect(out.opportunity_type).toBe("internship");
    expect(parseProfile('{"full_name": "No role"}')).toBeNull();
  });
});

describe("Jina parsing (same answers as apis/jina_parsing.py, link_selection.py)", () => {
  it("selects the main internal pages", () => {
    const links = {
      "About us": "https://acme.com/about", Blog: "https://acme.com/blog", Post: "https://acme.com/blog/hello-world",
      Privacy: "https://acme.com/privacy", Home: "https://acme.com/", Pricing: "https://www.acme.com/pricing?x=1",
      Team: "/team", "Other site": "https://other.com/about", Services: "https://acme.com/services/", PDF: "https://acme.com/a.pdf",
      Contact: "https://acme.com/contact", Accountants: "https://acme.com/accountants",
    };
    expect(selectMainLinks([links, { Work: "https://acme.com/work" }], ["acme.com", "https://www.acme.com/"], 5)).toEqual({
      Team: "https://acme.com/team", Services: "https://acme.com/services", Pricing: "https://www.acme.com/pricing",
      Work: "https://acme.com/work", Blog: "https://acme.com/blog",
    });
  });

  it("extracts emails and page text", () => {
    expect(extractEmails({ Mail: "mailto:info%40acme.com" }, "Write to Sales@Acme.com. or logo@2x.png, hello@acme.co.uk.", null))
      .toEqual(["info@acme.com", "sales@acme.com", "hello@acme.co.uk"]);
    expect(pageText({ title: "Acme", description: " Tools  ", content: "See [our docs](https://x) and ![img](y)\n\nok" }, 50)).toBe("Acme Tools See our docs and img ok");
  });

  it("normalizes URLs for dedupe", () => {
    expect(normalizeUrl("HTTPS://www.Acme.com/Path/?q=1#x")).toBe("acme.com/path");
  });
});

describe("LinkedIn source (same answers as stages/sourcing/linkedin/)", () => {
  it("normalizes listed websites", () => {
    const cases: [string, [string | null, string]][] = [
      ["acme.com", ["https://acme.com", "ok"]],
      ["http://www.Acme.com/index.html", ["http://www.acme.com", "ok"]],
      ["https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Facme%2Eio%2Fhome&urlhash=x", ["https://acme.io/home", "ok"]],
      ["mailto:a@b.com", [null, "not a web URL"]],
      ["facebook.com/acme", [null, "not a company site (facebook.com)"]],
      ["https://acme.com/en/ External link", ["https://acme.com/en", "ok"]],
      ["user@acme.com", [null, "contains userinfo"]],
      ["acme", [null, "invalid host 'acme'"]],
    ];
    for (const [raw, expected] of cases) expect(normalizeWebsite(raw), raw).toEqual(expected);
  });

  it("reads the size band's upper bound", () => {
    expect(["11-50 employees", "1 employee", "10,001+ employees", "2-10", "", "Self-employed"].map(employeeUpperBound)).toEqual([50, 1, 1e9, 10, null, null]);
  });

  it("parses a company page", () => {
    const html = `<html><head><script type="application/ld+json">{"@context":"http://schema.org","@type":"Organization","name":"Acme &amp; Co","sameAs":"https://acme.io","description":"We are a studio based in Dublin, Ireland. The team is great.","address":{"@type":"PostalAddress","addressCountry":"IE","addressLocality":"Dublin","addressRegion":"Leinster"},"numberOfEmployees":{"value":12}}</script></head>
<body><dl><dt> Website </dt><dd><a href="x">https://acme.io</a> External link</dd><dt>Industry</dt><dd>Software Development</dd><dt>Company size</dt><dd>11-50 employees</dd><dt>Headquarters</dt><dd>Dublin, Leinster</dd></dl>
<p>Acme is hiring a backend engineer in Dublin, Ireland. Apply now</p></body></html>`;
    expect(parseCompanyPage(html)).toEqual({
      name: "Acme & Co",   // the daemon keeps "&amp;" here; the port decodes it
      website: "https://acme.io", industry: "Software Development", size: "11-50 employees", headquarters: "Dublin, Leinster",
      country: "IE", locality: "Dublin", region: "Leinster", about_places: ["Dublin, Ireland"], hiring_places: ["Dublin, Ireland"],
    });
  });

  it("reads search results", () => {
    const seen = new Set<string>(["known"]);
    const out = companiesFrom([
      { title: "Acme Labs | LinkedIn", link: "https://www.linkedin.com/company/acme-labs/about" },
      { title: "Known", link: "https://in.linkedin.com/company/known" },
      { title: "A person", link: "https://www.linkedin.com/in/someone" },
      { title: "Acme again", link: "https://uk.linkedin.com/company/Acme-Labs" },
    ], seen);
    expect(out).toEqual([{ slug: "acme-labs", linkedin_url: "https://www.linkedin.com/company/acme-labs", name: "Acme Labs" }]);
    expect(cleanName("Beta - LinkedIn")).toBe("Beta");
  });

  it("classifies site checks", () => {
    expect(classifyStatus(200)).toEqual(["ok", true]);
    expect(classifyStatus(999)).toEqual(["blocked", true]);
    expect(classifyStatus(404)).toEqual(["not_found", false]);
    expect(isParked("https://www.hugedomains.com/domain_profile.cfm?d=acme.com")).toBe(true);
  });
});

describe("geo (geo.py over a fake city lookup)", () => {
  const CITIES: City[] = [
    { id: 1, name: "Dublin", country: "IE", admin1: "Leinster", lat: 53.333, lon: -6.249, population: 1_024_027 },
    { id: 2, name: "Dublin", country: "US", admin1: "Ohio", lat: 40.099, lon: -83.114, population: 49_328 },
    { id: 3, name: "Manchester", country: "GB", admin1: "England", lat: 53.481, lon: -2.237, population: 395_515 },
    { id: 4, name: "Salford", country: "GB", admin1: "England", lat: 53.488, lon: -2.291, population: 134_000 },
    { id: 5, name: "Paris", country: "FR", admin1: "Île-de-France", lat: 48.853, lon: 2.349, population: 2_138_551 },
    { id: 6, name: "Paris", country: "US", admin1: "Texas", lat: 33.661, lon: -95.555, population: 25_171 },
    { id: 7, name: "Berlin", country: "DE", admin1: "Berlin", lat: 52.524, lon: 13.411, population: 3_426_354 },
  ];
  const lookup: CityLookup = async (name, country) => CITIES.filter((c) => norm(c.name) === norm(name) && (!country || c.country === country));

  it("resolves targets", async () => {
    expect((await resolveTarget(lookup, "Germany"))).toMatchObject({ scope: "country", country: "DE" });
    expect((await resolveTarget(lookup, "Bavaria"))).toMatchObject({ scope: "region", country: "DE", names: ["bayern"] });
    expect((await resolveTarget(lookup, "Texas"))).toMatchObject({ scope: "region", country: "US", names: ["texas", "tx"] });
    expect((await resolveTarget(lookup, "Berlin"))).toMatchObject({ scope: "city", country: "DE" });
    expect((await resolveTarget(lookup, "Paris, TX"))).toMatchObject({ scope: "city", country: "US", city: { id: 6 } });
    expect((await resolveTarget(lookup, "Dublin"))).toMatchObject({ scope: "city", country: "IE" });
    expect(await resolveTarget(lookup, "Chicago, Toronto")).toBeNull();
    expect(await resolveTarget(lookup, "Nowhereville")).toBeNull();
  });

  it("matches places, with a metro radius", async () => {
    const manchester = (await resolveTarget(lookup, "Manchester"))!;
    const salford = await resolvePlace(lookup, "Salford, England", "GB");
    expect(matches(salford, manchester, 0)).toBe(false);
    expect(matches(salford, manchester, 30)).toBe(true);
    expect(matches(await resolvePlace(lookup, "Paris", "FR"), manchester, 30)).toBe(false);
    expect(matches(await resolvePlace(lookup, ""), manchester, 30)).toBeNull();
    expect(matches(await resolvePlace(lookup, "Austin, TX"), (await resolveTarget(lookup, "Texas"))!)).toBe(true);
  });

  it("checks a company's location, strongest evidence first", async () => {
    const dublin = (await resolveTarget(lookup, "Dublin"))!;
    const li = { name: "Acme", website: null, industry: null, size: null, headquarters: "Dublin, Leinster", country: "IE", locality: "Dublin", region: "Leinster", about_places: [], hiring_places: [] };
    expect((await checkLocation(lookup, dublin, li, "Acme", 30))[0]).toBe(true);
    expect((await checkLocation(lookup, dublin, { ...li, headquarters: "Dublin, Ohio", country: "US", locality: "Dublin", region: "Ohio" }, "Acme", 30))[0]).toBe(false);
    const none = { ...li, headquarters: null, country: null, locality: null, region: null };
    expect(await checkLocation(lookup, dublin, { ...none, hiring_places: ["Dublin, Ireland"] }, "Acme", 30)).toEqual([true, "job-posts", "Dublin, Ireland"]);
    expect(await checkLocation(lookup, dublin, none, "Dublin Design Co", 30)).toEqual([true, "name", "Dublin Design Co"]);
    expect(await checkLocation(lookup, dublin, none, "Acme", 30)).toEqual([false, "none", "no location info on page"]);
  });

  it("reads Open-Meteo answers without prefix matches", () => {
    const r = (name: string, population: number) => ({ id: 1, name, latitude: 0, longitude: 0, feature_code: "PPLA", country_code: "in", population });
    expect(citiesFrom("Bangalore", [r("Bengaluru", 8_443_675)]).map((c) => c.name)).toEqual(["Bengaluru"]);
    expect(citiesFrom("Mumba", [r("Mumbai", 12_691_836)])).toEqual([]);
    expect(citiesFrom("Pune", [r("Pune", 3_124_458), r("Punel", 1000)]).map((c) => c.country)).toEqual(["IN"]);
  });
});

describe("delivery (test_delivery.py)", () => {
  const body = "Para one is here. ".repeat(10) + "\n\n" + "Second paragraph words go on. ".repeat(12) + "\nlast line";

  it("cuts copy pieces like the daemon and pastes them back", () => {
    const pieces = chunkText(body, 256);
    expect(pieces.join("")).toBe(body);
    expect(pieces.every((p) => p.length <= 256)).toBe(true);
    expect(pieces.map((p) => p.length)).toEqual([182, 240, 130]);    // the Python chunk_text's pieces
    const kb = copyKeyboard("jane@acme.com", "Subject", body);
    expect(kb.inline_keyboard.flat().map((b) => b.text)).toEqual(["📋 To", "📋 Subject", "📋 Body 1/3", "📋 Body 2/3", "📋 Body 3/3"]);
  });

  it("escapes the HTML message and falls back when too long", () => {
    const msg = formatMessage("a@b.co", "<Hi>", "x & y", [{ filename: "cv.pdf", mime: "application/pdf", base64: "" }])!;
    expect(msg).toContain("<code>&lt;Hi&gt;</code>");
    expect(msg).toContain("<pre>x &amp; y</pre>");
    expect(msg).toContain("cv.pdf");
    expect(formatMessage("a@b.co", "S", "x".repeat(5000), null)).toBeNull();
  });

  it("builds a MIME message with the sender name and the resume", () => {
    const pdf = btoa("%PDF-1.4 fake");
    const mime = buildMessage("jane@acme.com", "Intern for Acme? ✨", "Hello\nthere", [{ filename: "Asha CV.pdf", mime: "application/pdf", base64: pdf }], "asha@gmail.com", "Asha Rao", "BOUNDARY");
    expect(mime).toContain('From: "Asha Rao" <asha@gmail.com>');
    expect(mime).toContain("To: jane@acme.com");
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?.+\?=/);
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="BOUNDARY"');
    expect(mime).toContain('Content-Disposition: attachment; filename="Asha CV.pdf"');
    expect(mime).toContain(pdf);
    const textB64 = mime.split("Content-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n")[0];
    expect(new TextDecoder().decode(base64ToBytes(textB64))).toBe("Hello\r\nthere");
  });
});

describe("AI client helpers", () => {
  it("reads quota answers", () => {
    const now = new Date("2026-11-03T22:00:00Z");
    expect(quotaWait("4006: you have used up your daily free allocation of 10,000 neurons", null, now)).toBe(secsUntilUtcMidnight(now));
    expect(quotaWait("Rate limit reached ... (TPD): Limit 100000. Please try again in 7m12.5s", null)).toBeCloseTo(432.5);
    expect(quotaWait("Rate limit reached for requests per minute. Please try again in 2s", null)).toBeNull();
    expect(quotaWait("slow down", 600)).toBe(600);
    expect(duration("1h2m")).toBe(3720);
  });

  it("finds the reply text in every shape", () => {
    expect(replyText({ response: '{"a":1}' })).toBe('{"a":1}');
    expect(replyText({ response: { a: 1 } })).toBe('{"a":1}');
    expect(replyText({ choices: [{ message: { content: "hi" } }] })).toBe("hi");
  });

  it("asks what a batch leaves out on its own, never guessing", async () => {
    const asked: number[] = [];
    const out = await askInBatches([1, 2, 3, 4, 5], 2,
      async (chunk) => new Map(chunk[0] === 1 ? [[1, "b1"]] : chunk[0] === 3 ? [[1, "b3"], [2, "b4"]] : []),
      async (item) => {
        asked.push(item);
        return `one${item}`;
      });
    expect(out).toEqual(["b1", "one2", "b3", "b4", "one5"]);
    expect(asked.sort()).toEqual([2, 5]);
  });

  it("gives an LLMUnavailable to every item of its chunk", async () => {
    const down = new LLMUnavailable("quota", 60);
    const out = await askInBatches([1, 2], 2, async () => { throw down; }, async () => "never");
    expect(out).toEqual([down, down]);
  });
});

describe("runner", () => {
  it("looks at profile first, then rotates the rest by the minute", () => {
    expect(tickOrder(new Date(0))).toEqual(["profile", "sourcing", "scrape", "internal", "email"]);
    expect(tickOrder(new Date(60_000))).toEqual(["profile", "scrape", "internal", "email", "sourcing"]);
  });
});
