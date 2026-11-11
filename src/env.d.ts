// The secret the Deploy button asks for (.dev.vars.example); `wrangler types` only sees it with a .dev.vars file.
interface Env {
  DASHBOARD_PASSWORD?: string;
  // Only on a Workers Paid plan, once wrangler.jsonc binds it (the free plan can't: see there).
  BROWSER?: BrowserRun;
}
