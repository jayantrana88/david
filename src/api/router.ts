/**
 * The dashboard's JSON API (`/api/*`), served by the Worker and by the local dashboard server alike; the host adds
 * its own routes (settings; on the Worker also logs, runs and the Gmail / Outlook sign-in). Everything else is the
 * React app in web/. With a password set, every call needs the session cookie (401 otherwise) and every POST must
 * come from this origin.
 */
import { clearCookie, lockKey, passwordMatches, sameOrigin, sessionCookie, signedIn } from "./auth";
import * as actions from "./actions";
import * as data from "./data";
import { fail, type Handler, HttpError, type Host, json, ok, type Req, readBody, type Route } from "./http";
import * as lock from "./lock";
import * as profile from "./profile";

const ROUTES: Route[] = [
  ["GET", /^\/api\/overview$/, data.overview],

  ["GET", /^\/api\/tasks$/, data.tasks],
  ["POST", /^\/api\/tasks$/, actions.createTasks],
  ["POST", /^\/api\/tasks\/(\d+)\/(update|requeue|stop|repeat|delete)$/, (req, id, what) => actions.taskAction(req, Number(id), what)],

  ["GET", /^\/api\/websites$/, data.websites],
  ["GET", /^\/api\/websites\/([0-9a-f]+)\/progress$/, data.websiteProgress],
  ["POST", /^\/api\/websites\/([0-9a-f]+)\/(update|delete)$/, actions.websiteAction],

  ["GET", /^\/api\/scrapes$/, data.scrapes],
  ["POST", /^\/api\/scrapes\/([0-9a-f]+)\/(verdict|delete)$/, actions.scrapeAction],

  ["GET", /^\/api\/pages$/, data.pages],
  ["GET", /^\/api\/pages\/([0-9a-f]+)\/content$/, data.pageContent],
  ["POST", /^\/api\/pages\/reread$/, actions.rereadPages],

  ["GET", /^\/api\/emails$/, data.emails],
  ["POST", /^\/api\/emails\/([0-9a-f]+)\/retry$/, actions.retryEmail],

  ["GET", /^\/api\/profile$/, profile.getProfile],
  ["GET", /^\/api\/profile\/resume$/, profile.downloadResume],
  ["POST", /^\/api\/profile\/resume$/, profile.uploadResume],
  ["POST", /^\/api\/profile\/notes$/, profile.saveNotes],
  ["POST", /^\/api\/profile\/fields$/, profile.saveFields],

  ["POST", /^\/api\/settings\/password$/, lock.savePassword],
  ["POST", /^\/api\/settings\/password\/remove$/, lock.removePassword],
];

export async function handle(request: Request, host: Host): Promise<Response> {
  const url = new URL(request.url);
  const { db, env } = host;
  const secure = url.protocol === "https:";
  const key = await lockKey(env, db);
  if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) return json({ error: "Cross-origin request refused" }, 403);

  // who am I: the app asks before it draws anything
  if (url.pathname === "/api/session" && request.method === "GET") {
    return json({ locked: key !== null, signedIn: key === null || (await signedIn(key, request)), worker: host.worker });
  }
  if (url.pathname === "/api/login" && request.method === "POST") {
    if (key === null) return ok("The dashboard has no password.");
    const typed = String((await readBody({ request })).password ?? "");
    if (!(await passwordMatches(env, db, typed, host.passwords))) return fail("Wrong password.");
    return json({ ok: true, message: "Signed in." }, 200, { "Set-Cookie": await sessionCookie(key, secure) });
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    return json({ ok: true, message: "Locked." }, 200, key === null ? {} : { "Set-Cookie": clearCookie(secure) });
  }

  // No password set: the dashboard is open (Settings → Dashboard password).
  if (key !== null && !(await signedIn(key, request))) {
    return url.pathname.startsWith("/oauth/") ? new Response(null, { status: 303, headers: { Location: "/" } }) : json({ error: "Signed out" }, 401);
  }

  const req: Req = { host, db, url, request };
  for (const [method, pattern, handler] of [...ROUTES, ...host.routes] as [string, RegExp, Handler][]) {
    if (method !== request.method) continue;
    const m = pattern.exec(url.pathname);
    if (!m) continue;
    try {
      return await handler(req, ...m.slice(1));
    } catch (e) {
      console.error(e);
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const message = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(message)) {
        return json({ error: "The database tables are missing. The Worker creates them on its first request (check its logs for \"migration failed\"); the local server creates them when it opens the file." }, 500);
      }
      return json({ error: message }, 500);
    }
  }
  return json({ error: "Not found" }, 404);
}
