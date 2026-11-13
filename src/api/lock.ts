/** The optional dashboard password: set, change and remove (shared by the Worker and the local server). */
import { envPassword, lockKey, MIN_PASSWORD, passwordMatches, sessionCookie } from "./auth";
import { fail, json, ok, type Req, readBody } from "./http";

/** Sets or changes the dashboard password. The browser that changed it stays signed in. */
export async function savePassword(req: Req): Promise<Response> {
  const { host, db } = req;
  if (envPassword(host.env)) return fail("The password is set by the DASHBOARD_PASSWORD secret; change it where that is set.");
  const body = await readBody(req);
  const password = String(body.password ?? "");
  if (password.length < MIN_PASSWORD) return fail(`Use at least ${MIN_PASSWORD} characters.`, { password: `At least ${MIN_PASSWORD} characters.` });
  if (password.length > 200) return fail("At most 200 characters.", { password: "Too long." });
  if (password !== String(body.confirm ?? "")) return fail("The two passwords don't match.", { confirm: "Doesn't match." });
  if ((await lockKey(host.env, db)) !== null && !(await passwordMatches(host.env, db, String(body.current ?? ""), host.passwords))) {
    return fail("The current password is wrong.", { current: "Wrong password." });
  }
  const hash = await host.passwords.hash(password);
  await db.run(
    "INSERT INTO dashboard_lock (id, password_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    [hash],
  );
  return json({ ok: true, message: "Password saved." }, 200, { "Set-Cookie": await sessionCookie(`db:${hash}`, req.url.protocol === "https:") });
}

/** Removes the password: the dashboard is open again. */
export async function removePassword(req: Req): Promise<Response> {
  const { host, db } = req;
  if (envPassword(host.env)) return fail("The password is set by the DASHBOARD_PASSWORD secret; remove it where that is set.");
  if (!(await passwordMatches(host.env, db, String((await readBody(req)).current ?? ""), host.passwords))) return fail("The current password is wrong.");
  await db.run("DELETE FROM dashboard_lock WHERE id = 1");
  return ok("Password removed. The dashboard is open.");
}
