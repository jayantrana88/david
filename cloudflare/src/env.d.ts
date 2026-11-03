// The secret the Deploy button asks for (.dev.vars.example); `wrangler types` only sees it with a .dev.vars file.
interface Env {
  DASHBOARD_PASSWORD?: string;
}
