/** The dashboard's writes on tasks, companies, fit checks, pages and applications. Each answers an ActionResult. */
import { fail, flag, numberField, ok, type Req, readBody, text } from "./http";

const MAX_TASKS_PER_SUBMIT = 50;

/** A delete the database refused over a foreign key is explained; anything else is shown as it is. */
const foreignKeyMessage = (e: unknown, explanation: string): string =>
  e instanceof Error && /FOREIGN KEY/i.test(e.message) ? explanation : `Could not delete: ${e instanceof Error ? e.message : e}`;
const OPPORTUNITIES = ["job", "internship", "either"];

// ── tasks ─────────────────────────────────────────────────────────────────────────

interface TaskFields {
  candidates: number;
  metro_radius_km: number | null;
  max_employees: number;
  target_role: string | null;
  opportunity_type: string | null;
  repeat_daily: boolean;
}

/** The task fields as the forms post them; the same limits as the `tasks` table's CHECKs. */
function readTaskFields(body: Record<string, unknown>): { fields: TaskFields } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const candidates = numberField(text(body, "candidates"), { int: true, min: 1, max: 200 });
  const radius = numberField(text(body, "metro_radius_km"), { min: 0 });
  const maxEmployees = numberField(text(body, "max_employees"), { int: true, min: 1, max: 100000 });
  if ("error" in candidates) errors.candidates = candidates.error;
  else if (candidates.value === null) errors.candidates = "Enter a number.";
  if ("error" in radius) errors.metro_radius_km = radius.error;
  if ("error" in maxEmployees) errors.max_employees = maxEmployees.error;
  else if (maxEmployees.value === null) errors.max_employees = "Enter a number.";
  const role = text(body, "target_role", 1000);
  if (role.length > 200) errors.target_role = "Keep it under 200 characters.";
  const kind = text(body, "opportunity_type");
  if (kind && !OPPORTUNITIES.includes(kind)) errors.opportunity_type = "Pick one of the options.";
  if (Object.keys(errors).length) return { errors };
  return {
    fields: {
      candidates: (candidates as { value: number }).value,
      metro_radius_km: (radius as { value: number | null }).value,
      max_employees: (maxEmployees as { value: number }).value,
      target_role: role || null,
      opportunity_type: kind || null,
      repeat_daily: flag(body, "repeat_daily"),
    },
  };
}

const lines = (v: string) => v.split(/[\n;]/).map((s) => s.trim()).filter(Boolean);

export async function createTasks(req: Req): Promise<Response> {
  const body = await readBody(req);
  const categories = lines(text(body, "categories", 20000));
  const locations = lines(text(body, "locations", 20000));
  const parsed = readTaskFields(body);
  const errors: Record<string, string> = "errors" in parsed ? parsed.errors : {};
  if (!categories.length) errors.categories = "Add at least one category.";
  if (!locations.length) errors.locations = "Add at least one location.";
  for (const [name, list] of [["categories", categories], ["locations", locations]] as const) {
    const bad = list.find((v) => v.length > 200);
    if (bad) errors[name] = `"${bad.slice(0, 30)}…" is too long (200 characters at most).`;
  }
  if (Object.keys(errors).length || !("fields" in parsed)) return fail("Check the highlighted fields.", errors);
  const total = categories.length * locations.length;
  if (total > MAX_TASKS_PER_SUBMIT) return fail(`That's ${total} searches; add at most ${MAX_TASKS_PER_SUBMIT} at a time.`);

  const f = parsed.fields;
  await req.db.batch(
    categories.flatMap((category) =>
      locations.map((location) =>
        req.db.stmt(
          `INSERT INTO tasks (source, category, location, candidates, max_employees, metro_radius_km, target_role, opportunity_type, repeat_daily)
           VALUES ('linkedin', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [category, location, f.candidates, f.max_employees, f.metro_radius_km, f.target_role, f.opportunity_type, f.repeat_daily],
        ),
      ),
    ),
  );
  await req.host.wake("sourcing");
  return ok(total === 1 ? "Task added. It starts within a minute." : `${total} tasks added. They run one at a time, oldest first.`);
}

export async function taskAction(req: Req, id: number, what: string): Promise<Response> {
  const db = req.db;
  if (what === "update") {
    const body = await readBody(req);
    const category = text(body, "category", 1000);
    const location = text(body, "location", 1000);
    const parsed = readTaskFields(body);
    const errors: Record<string, string> = "errors" in parsed ? parsed.errors : {};
    if (!category) errors.category = "Required.";
    else if (category.length > 200) errors.category = "At most 200 characters.";
    if (!location) errors.location = "Required.";
    else if (location.length > 200) errors.location = "At most 200 characters.";
    if (Object.keys(errors).length || !("fields" in parsed)) return fail("Check the highlighted fields.", errors);
    const f = parsed.fields;
    const n = await db.run(
      `UPDATE tasks SET category = ?, location = ?, candidates = ?, metro_radius_km = ?, max_employees = ?, target_role = ?, opportunity_type = ?, repeat_daily = ?
       WHERE id = ? AND status = 'pending'`,
      [category, location, f.candidates, f.metro_radius_km, f.max_employees, f.target_role, f.opportunity_type, f.repeat_daily, id],
    );
    return n ? ok(`Task #${id} updated.`) : fail(`Task #${id} has already started, so it can't be edited.`);
  }
  if (what === "requeue") {
    const n = await db.run("UPDATE tasks SET status = 'pending', error = NULL WHERE id = ? AND status IN ('completed', 'failed')", [id]);
    if (n) {
      await req.host.requeued(id);
      await req.host.wake("sourcing");
    }
    return n ? ok(`Task #${id} is queued again. Leads it already saved are skipped.`) : fail(`Task #${id} can't be re-run: only a completed or failed task can.`);
  }
  if (what === "stop") {
    if (!req.host.worker) return fail("A task can't be stopped from here: the daemon is running it.");
    const n = await db.run("UPDATE tasks SET status = 'failed', error = 'stopped from the dashboard', finished_at = ? WHERE id = ? AND status = 'running'", [new Date().toISOString(), id]);
    return n ? ok(`Task #${id} stopped.`) : fail(`Task #${id} isn't running.`);
  }
  if (what === "repeat") {
    const repeat = flag(await readBody(req), "repeat");
    const n = await db.run("UPDATE tasks SET repeat_daily = ? WHERE id = ?", [repeat, id]);
    return n ? ok(repeat ? `Task #${id} will run again every day.` : `Task #${id} won't repeat.`) : fail(`Task #${id} no longer exists.`);
  }
  if (what === "delete") {
    const n = await db.run("DELETE FROM tasks WHERE id = ? AND status <> 'running'", [id]);
    return n ? ok(`Task #${id} deleted.`) : fail(`Task #${id} is running, so it can't be deleted.`);
  }
  return fail("Unknown action");
}

// ── companies ─────────────────────────────────────────────────────────────────────

export async function websiteAction(req: Req, id: string, what: string): Promise<Response> {
  if (what === "delete") {
    try {
      const n = await req.db.run("DELETE FROM websites WHERE id = ?", [id]);
      return n ? ok("Lead deleted.") : fail("That lead no longer exists.");
    } catch (e) {
      return fail(foreignKeyMessage(e, "This lead still has checks, pages or emails that point at it, and the database won't delete it while they exist."));
    }
  }
  if (what === "update") {
    const body = await readBody(req);
    const errors: Record<string, string> = {};
    const email = text(body, "email", 1000);
    // several addresses are stored comma-separated; the email stage picks a usable one
    if (email.length > 500) errors.email = "At most 500 characters.";
    else if (email && !email.split(",").every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()))) errors.email = "Use valid addresses, separated by commas.";
    const phone = text(body, "phone_number", 1000);
    if (phone.length > 50) errors.phone_number = "At most 50 characters.";
    const owner = text(body, "owner", 1000);
    if (owner.length > 200) errors.owner = "At most 200 characters.";
    if (Object.keys(errors).length) return fail("Check the highlighted fields.", errors);
    const n = await req.db.run("UPDATE websites SET email = ?, phone_number = ?, owner = ? WHERE id = ?", [email || null, phone || null, owner || null, id]);
    if (!n) return fail("That lead no longer exists.");
    await req.host.forget("email", id);
    await req.host.wake("email");
    return ok("Lead updated.");
  }
  return fail("Unknown action");
}

// ── fit checks ────────────────────────────────────────────────────────────────────

export async function scrapeAction(req: Req, id: string, what: string): Promise<Response> {
  const row = await req.db.get<{ website_id: string }>("SELECT website_id FROM website_scrapes WHERE id = ?", [id]);
  if (!row) return fail("That check no longer exists.");
  if (what === "verdict") {
    const v = (await readBody(req)).verdict;
    const verdict = v === true || v === "1" ? true : v === false || v === "0" ? false : null;
    await req.db.run("UPDATE website_scrapes SET is_qualified = ? WHERE id = ?", [verdict, id]);
    await req.host.forget("scrape", row.website_id);
    await req.host.wake(verdict === null ? "scrape" : "internal");
    return ok(verdict === null ? "The AI judges this company again at the next scrape tick." : `Verdict set to ${verdict ? "qualified" : "not a fit"}.`);
  }
  if (what === "delete") {
    try {
      await req.db.run("DELETE FROM website_scrapes WHERE id = ?", [id]);
    } catch (e) {
      return fail(foreignKeyMessage(e, "This scrape still has pages. Delete its pages first (Pages → Read again), then the scrape."));
    }
    await req.host.forget("scrape", row.website_id);
    await req.host.wake("scrape");
    return ok("Scrape deleted. The scrape stage reads this website again.");
  }
  return fail("Unknown action");
}

// ── pages ─────────────────────────────────────────────────────────────────────────

export async function rereadPages(req: Req): Promise<Response> {
  const scrapeId = text(await readBody(req), "scrape_id", 100);
  const n = await req.db.run("DELETE FROM website_pages WHERE scrape_id = ?", [scrapeId]);
  await req.host.forget("internal", scrapeId);
  await req.host.wake("internal");
  return ok(`${n} page${n === 1 ? "" : "s"} deleted. The internal stage reads this company's pages again.`);
}

// ── applications ──────────────────────────────────────────────────────────────────

const RETRYABLE = ["draft", "rejected", "generation_failed", "send_failed"];

export async function retryEmail(req: Req, id: string): Promise<Response> {
  const row = await req.db.get<{ website_id: string }>(
    `DELETE FROM cold_emails WHERE id = ? AND status IN (${RETRYABLE.map(() => "?").join(", ")}) RETURNING website_id`,
    [id, ...RETRYABLE],
  );
  if (!row) return fail("This email can't be retried: it was sent, or is being sent.");
  await req.host.forget("email", row.website_id);
  await req.host.wake("email");
  return ok("Cleared. The email stage writes this company a new application.");
}
