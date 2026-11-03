/**
 * The job applier as one Cloudflare Worker (free plan):
 *
 *   fetch       the dashboard (src/web/), behind the DASHBOARD_PASSWORD secret
 *   scheduled   the cron trigger, every minute: one tick that runs one stage a small step (src/runner.ts)
 *
 * Storage is one D1 database (migrations/), the AI is Workers AI through the `AI` binding, and LinkedIn pages
 * are read through Browser Rendering (`BROWSER`). See README.md.
 */
import { tick } from "./runner";
import { handle } from "./web/router";

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(tick(env).then((result) => console.log(`tick: ${result}`), (e) => console.error("tick failed", e)));
  },
} satisfies ExportedHandler<Env>;
