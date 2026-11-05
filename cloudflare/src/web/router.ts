/** The dashboard's routes. Every page needs the session cookie; every POST must come from this origin. */
import { Db } from "../db";
import { clearCookie, MIN_PASSWORD, passwordMatches, passwordOf, sameOrigin, sessionCookie, signedIn } from "./auth";
import { type Req, redirect } from "./common";
import { bare, html } from "./html";
import * as pages from "./pages";
import * as profile from "./profile";
import * as settings from "./settings";

type Handler = (req: Req, ...params: string[]) => Promise<Response>;
const ROUTES: [method: string, pattern: RegExp, handler: Handler][] = [
  ["GET", /^\/$/, pages.overview],
  ["POST", /^\/run$/, pages.runNow],
  ["GET", /^\/tasks$/, pages.tasks],
  ["POST", /^\/tasks$/, pages.createTasks],
  ["POST", /^\/tasks\/(\d+)\/(requeue|stop|repeat|delete)$/, (req, id, what) => pages.taskAction(req, Number(id), what)],
  ["GET", /^\/websites$/, pages.websites],
  ["POST", /^\/websites\/([0-9a-f]+)\/(delete|email)$/, pages.websiteAction],
  ["GET", /^\/scrapes$/, pages.scrapes],
  ["POST", /^\/scrapes\/([0-9a-f]+)\/(verdict|delete)$/, pages.scrapeAction],
  ["GET", /^\/pages$/, pages.pages],
  ["POST", /^\/pages\/reread$/, pages.rereadPages],
  ["GET", /^\/emails$/, pages.emails],
  ["POST", /^\/emails\/([0-9a-f]+)\/retry$/, pages.retryEmail],
  ["GET", /^\/logs$/, pages.logs],
  ["GET", /^\/profile$/, profile.profilePage],
  ["GET", /^\/profile\/resume$/, profile.downloadResume],
  ["POST", /^\/profile\/resume$/, profile.uploadResume],
  ["POST", /^\/profile\/notes$/, profile.saveNotes],
  ["POST", /^\/profile\/fields$/, profile.saveFields],
  ["GET", /^\/settings$/, settings.settingsPage],
  ["POST", /^\/settings$/, settings.saveSettings],
  ["POST", /^\/settings\/secret$/, settings.saveSecret],
  ["POST", /^\/settings\/test-send$/, settings.testSend],
  ["GET", /^\/oauth\/(gmail|outlook)\/start$/, (req, p) => settings.oauthStart(req, p as "gmail" | "outlook")],
  ["GET", /^\/oauth\/(gmail|outlook)\/callback$/, (req, p) => settings.oauthCallback(req, p as "gmail" | "outlook")],
  ["POST", /^\/oauth\/(gmail|outlook)\/disconnect$/, (req, p) => settings.oauthDisconnect(req, p as "gmail" | "outlook")],
];

function loginPage(error = "", status = 200): Response {
  return bare("Sign in", html`<h1>DAVID</h1>
${error ? html`<div class="flash bad">${error}</div>` : ""}
<form method="post" action="/login" class="panel"><label>Dashboard password</label>
<input name="password" type="password" autocomplete="current-password" required autofocus>
<p><button class="primary">Sign in</button></p></form>`, status);
}

function setupPage(): Response {
  return bare("Set a password", html`<h1>One more step</h1><div class="panel">
<p>The dashboard is on a public URL, so it needs a password. Set the <code>DASHBOARD_PASSWORD</code> secret (at least ${MIN_PASSWORD} characters):</p>
<ul><li>Cloudflare dashboard → Workers &amp; Pages → this Worker → Settings → Variables and Secrets → Add → type Secret, or</li>
<li><code>npx wrangler secret put DASHBOARD_PASSWORD</code> in the project folder.</li></ul>
<p>Then reload this page.</p></div>`, 503);
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (passwordOf(env).length < MIN_PASSWORD) return setupPage();
  if (request.method === "POST" && !sameOrigin(request)) return new Response("Cross-origin request refused", { status: 403 });

  if (url.pathname === "/login") {
    if (request.method !== "POST") return loginPage();
    const form = await request.formData();
    if (!(await passwordMatches(env, String(form.get("password") ?? "")))) return loginPage("Wrong password.", 401);
    return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": await sessionCookie(env) } });
  }
  if (url.pathname === "/logout" && request.method === "POST") {
    return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": clearCookie } });
  }
  if (!(await signedIn(env, request))) {
    return request.method === "GET" ? new Response(null, { status: 303, headers: { Location: "/login" } }) : new Response("Signed out", { status: 401 });
  }

  const req: Req = { env, db: new Db(env.DB), url, request, ctx };
  for (const [method, pattern, handler] of ROUTES) {
    if (method !== request.method) continue;
    const m = pattern.exec(url.pathname);
    if (m) {
      try {
        return await handler(req, ...m.slice(1));
      } catch (e) {
        console.error(e);
        const message = e instanceof Error ? e.message : String(e);
        if (/no such table/i.test(message)) {
          return bare("Database not set up", html`<h1>Database not set up</h1><div class="panel">The D1 tables could not be created. The Worker applies its migrations itself on the first request; check the Worker's logs for \"migration failed\".</div>`, 500);
        }
        return method === "GET"
          ? bare("Error", html`<h1>Something went wrong</h1><div class="panel"><pre>${message}</pre><a href="/">Back</a></div>`, 500)
          : redirect(url.pathname.split("/").slice(0, 2).join("/") || "/", message, false);
      }
    }
  }
  return new Response("Not found", { status: 404 });
}
