/**
 * DAVID as one Cloudflare Worker (free plan):
 *
 *   fetch       the dashboard (src/web/), behind the DASHBOARD_PASSWORD secret
 *   scheduled   the cron trigger, every minute: one tick that runs one stage a small step (src/runner.ts)
 *
 * Storage is one D1 database (migrations/, applied by the Worker itself: src/migrations.ts), the AI is Workers AI through the `AI` binding, and LinkedIn pages
 * are read by plain fetch, or through Browser Rendering (`BROWSER`) on a paid plan. See README.md.
 */
import { ensureMigrated } from "./migrations";
import { tick } from "./runner";
import { handle } from "./web/router";

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureMigrated(env.DB);
    } catch (e) {
      console.error("migration failed", e);
    }
    return handle(request, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(ensureMigrated(env.DB).then(() => tick(env)).then((result) => console.log(`tick: ${result}`), (e) => console.error("tick failed", e)));
  },
} satisfies ExportedHandler<Env>;
