/**
 * The settings every tick runs with: the dashboard's app_settings + app_secrets rows over the defaults below
 * (the Worker's config.py). Read once per tick, so a change on the dashboard applies at the next tick, with
 * nothing to restart.
 */
import type { Db } from "./db";

export const DEFAULT_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export type Delivery = "telegram" | "gmail" | "outlook";

export interface Config {
  ai: {
    model: string;               // a Workers AI model (@cf/...), or a model of `baseUrl`'s provider
    baseUrl: string;             // "" = Workers AI through the AI binding (free: 10,000 neurons a day)
    apiKey: string;              // for baseUrl only
    qualifyBatch: number;        // leads judged per AI call (and per scrape tick); 1 = one call per lead
    emailBatch: number;          // leads' first drafts per AI call (and per email tick)
  };
  email: {
    enabled: boolean;
    mode: "dry_run" | "send";    // dry_run: every application is saved as a draft, nothing is sent
    delivery: Delivery;
    maxSendsPerDay: number | null;
    attachResume: boolean;
    instructions: string;
    senderName: string;
  };
  sourcing: {
    transport: "browser" | "fetch";   // how LinkedIn company pages are read
    perTick: number;                   // LinkedIn pages read per tick
  };
  keys: {
    jina: string;                // optional: Jina Reader works without a key at 20 requests a minute
    serper: string;
    telegramBotToken: string;
    telegramChatId: string;
    gmailClientId: string;
    gmailClientSecret: string;
    outlookClientId: string;
    outlookClientSecret: string;
    outlookTenant: string;
  };
  paused: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown, dflt: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt;
const bool = (v: unknown, dflt: boolean): boolean => (v === null || v === undefined ? dflt : Boolean(v));

export async function loadConfig(db: Db): Promise<Config> {
  const [s = {}, k = {}] = await Promise.all([
    db.get<Record<string, unknown>>("SELECT * FROM app_settings WHERE id = 1"),
    db.get<Record<string, unknown>>("SELECT * FROM app_secrets WHERE id = 1"),
  ]);
  return configFrom(s, k);
}

export function configFrom(s: Record<string, unknown>, k: Record<string, unknown>): Config {
  const baseUrl = str(s.ai_base_url).replace(/\/+$/, "");
  return {
    ai: {
      model: str(s.ai_model) || DEFAULT_AI_MODEL,
      baseUrl,
      apiKey: str(k.ai_api_key),
      qualifyBatch: int(s.ai_qualify_batch, 10, 1, 30),
      emailBatch: int(s.ai_email_batch, 3, 1, 10),
    },
    email: {
      enabled: bool(s.email_enabled, true),
      mode: s.email_mode === "send" ? "send" : "dry_run",
      delivery: s.email_delivery === "gmail" || s.email_delivery === "outlook" ? s.email_delivery : "telegram",
      maxSendsPerDay: typeof s.email_max_sends_per_day === "number" && s.email_max_sends_per_day > 0 ? s.email_max_sends_per_day : null,
      attachResume: bool(s.email_attach_resume, true),
      instructions: str(s.email_instructions),
      senderName: str(s.sender_name),
    },
    sourcing: {
      transport: s.linkedin_transport === "browser" ? "browser" : "fetch",
      perTick: int(s.sourcing_per_tick, 4, 1, 10),
    },
    keys: {
      jina: str(k.jina_api_key),
      serper: str(k.serper_api_key),
      telegramBotToken: str(k.telegram_bot_token),
      telegramChatId: str(k.telegram_chat_id),
      gmailClientId: str(k.gmail_client_id),
      gmailClientSecret: str(k.gmail_client_secret),
      outlookClientId: str(k.outlook_client_id),
      outlookClientSecret: str(k.outlook_client_secret),
      outlookTenant: str(s.outlook_tenant) || "common",
    },
    paused: bool(s.paused, false),
  };
}
