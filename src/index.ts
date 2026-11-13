/**
 * DAVID as one Cloudflare Worker (free plan):
 *
 *   fetch       /api/* and /oauth/*: the dashboard's JSON API (src/api/), with an optional password (Settings page).
 *               Everything else is the React dashboard (web/), served from the static assets binding
 *   scheduled   the cron trigger, every minute: one tick that runs one stage a small step (src/runner.ts)
 *
 * Storage is one D1 database (migrations/, applied by the Worker itself: src/migrations.ts), the AI is Workers AI through the `AI` binding, and LinkedIn pages
 * are read by plain fetch, or through Browser Rendering (`BROWSER`) on a paid plan. See README.md.
 */
import { ensureMigrated } from "./migrations";
import { tick } from "./runner";
import { handle } from "./api/router";
import { workerHost } from "./api/worker";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // wrangler.jsonc sends only /api/* and /oauth/* here; this keeps any other address working if that changes
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/oauth/")) return env.ASSETS.fetch(request);
    try {
      await ensureMigrated(env.DB);
    } catch (e) {
      console.error("migration failed", e);
    }
    return handle(request, workerHost(env, ctx));
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(ensureMigrated(env.DB).then(() => tick(env)).then((result) => console.log(`tick: ${result}`), (e) => console.error("tick failed", e)));
  },
} satisfies ExportedHandler<Env>;
