"""
DAVID settings: the file to edit for what the dashboard doesn't cover.

  Dashboard     the API keys, the AI model, the email settings: the Settings page writes them to the local
                SQLite database (app_settings / app_secrets, core/app_settings.py), which is read once, here.
                The database is the file DB_PATH (default data/david.db, core/sqlite.py).
  RATE_LIMITS   each provider's ceiling (concurrent requests, requests per minute)
  LOGGING       how much each log gets, and whether logs/main/main.log is echoed to the terminal
  AI            which AI model qualifies the leads and writes the emails (any LiteLLM provider)
  EMAIL         whether the email pool runs, whether it really sends, and through what (Telegram or a mailbox)

Every value is checked when this file is imported, so a typo stops the daemon before anything
starts, with a message saying what to fix. There is no credentials.env: the only environment variable the
daemon reads is DB_PATH (optional), because it has to find the database before it can read anything.
"""
from dataclasses import dataclass
from pathlib import Path

from core import app_settings
from core.config_models import (
    AIConfig,
    ApiLimit,
    ConfigError,
    EmailConfig,
    LLMProfile,
    LoggingConfig,
)

PROJECT_ROOT = Path(__file__).resolve().parent

# ── Dashboard settings ────────────────────────────────────────────────────────
# Read once, here; main.py restarts the daemon when the dashboard saves a change.

APP_SETTINGS = app_settings.load()


# ── Credentials ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Credentials:
    """The keys saved on the dashboard (app_secrets); empty = not set."""
    jina_api_key:        str = ""
    serper_api_key:      str = ""
    ai_provider_api_key: str = ""     # the AI provider's key (Workers AI unless the dashboard names another model)
    telegram_bot_token:  str = ""     # the bot that receives the written emails
    telegram_chat_id:    str = ""     # the chat it posts them to
    # EMAIL.delivery="gmail": a Google Cloud "Desktop app" OAuth client (then `python mail_setup.py connect gmail`)
    gmail_client_id:     str = ""
    gmail_client_secret: str = ""
    # EMAIL.delivery="outlook": a Microsoft Entra app (then `python mail_setup.py connect outlook`)
    outlook_client_id:   str = ""
    outlook_client_secret: str = ""   # only for a "Web" platform registration
    outlook_tenant:      str = "common"   # "consumers" = personal accounts only


credentials = Credentials(**APP_SETTINGS.credential_overrides())


# ── Rate limits ───────────────────────────────────────────────────────────────

# Each provider's ceiling for the whole daemon (core/limits.py). A pool that calls an API shares its limiter
# with every other pool that calls it.
RATE_LIMITS: dict[str, ApiLimit] = {
    "llm":      ApiLimit(concurrency=8, rpm=60),    # every AI role (one Workers AI account): tune to the account's limit
    "jina":     ApiLimit(concurrency=6, rpm=120),   # scrape + internal; a keyed Jina account allows far more
    "serper":   ApiLimit(concurrency=4, rpm=300),
    "linkedin": ApiLimit(concurrency=1, rpm=40),    # public company pages, no login: slow, or LinkedIn blocks the IP
    "telegram": ApiLimit(concurrency=1, rpm=20),    # one chat: Telegram allows about 20 messages a minute
    # EMAIL.delivery's mail provider: one email at a time, spaced out (a burst from a personal account looks
    # like spam). Daily caps: Gmail ~500, Outlook.com ~300; set EMAIL.max_sends_per_day well below.
    "gmail":    ApiLimit(concurrency=1, rpm=6),
    "outlook":  ApiLimit(concurrency=1, rpm=6),
}


# ── Logging ───────────────────────────────────────────────────────────────────

LOGGING = LoggingConfig(
    level="INFO",        # default for every log: DEBUG, INFO, WARNING, ERROR or CRITICAL
    levels={},           # per-log override: "main" or a pool name, e.g. {"sourcing": "DEBUG"}
    console=True,        # echo logs/main/main.log to the terminal (the per-pool logs are file-only)
)

# ── AI provider ───────────────────────────────────────────────────────────────
# Three roles (`qualify`: the scrape pool, is the lead a fit?; `email`: the email pool; `profile`: reads the
# resume), each a LLMProfile: its models in order of preference (when a model's quota is used up the next one
# answers until the first one's quota resets; when all are used up, that pool holds until the earliest reset).
# Default: Workers AI's Gemma, which needs the Cloudflare account ID and the AI key from the dashboard. The
# dashboard's Model field replaces it for every role with any LiteLLM model ("<provider>/<model>", e.g.
# "groq/openai/gpt-oss-120b", "openrouter/<org>/<model>", "openai/gpt-4o-mini"), using the same AI key.
# Full list: https://docs.litellm.ai/docs/providers. How fast they are called: RATE_LIMITS["llm"] above.
# Per profile there is also api_base, temperature, max_tokens, timeout, extra_params (e.g.
# {"reasoning_effort": "low"}), structured_output ("json_schema", "json_object" or "off") and
# quota_switch_after (see LLMProfile).

_account_id = str(APP_SETTINGS.value("cloudflare_account_id") or "").strip()
_chosen_model = str(APP_SETTINGS.value("ai_model") or "").strip()
_ai_key = credentials.ai_provider_api_key or None

# Why no AI client can be built (core/clients.get_llm raises it, so the AI pools don't start), or None.
AI_PROBLEM: str | None = None

if _chosen_model:
    _profile = LLMProfile(models=[_chosen_model], api_key=_ai_key)
else:
    # Workers AI through its OpenAI-compatible endpoint (LiteLLM's own `cloudflare/` provider uses the older
    # /run route, which doesn't carry our JSON-schema replies).
    _profile = LLMProfile(
        models=["openai/@cf/google/gemma-4-26b-a4b-it"],     # tried in this order; the next takes over when one's quota runs out
        api_base=f"https://api.cloudflare.com/client/v4/accounts/{_account_id}/ai/v1",
        api_key=_ai_key,
        timeout=120,                             # seconds per call before it counts as failed (and is retried)
        # Gemma 4 thinks by default, and the hidden reasoning is billed as output tokens. Off = ~12x fewer.
        extra_params={"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}},
    )
    if not _account_id:
        AI_PROBLEM = "set the Cloudflare account ID (or a Model) in the dashboard's Settings, under AI"
if AI_PROBLEM is None and not _ai_key:
    AI_PROBLEM = "set the AI provider key in the dashboard's Settings, under API keys"

AI = AIConfig(
    qualify=_profile,
    email=_profile,
    profile=_profile,                # reads the resume into the candidate profile (profile pool)
    qualify_batch=10,                # leads qualified per AI call; 1 = one call per lead
    email_batch=3,                   # leads' first email draft per AI call; 1 = one call per lead
)

# ── Email pool ────────────────────────────────────────────────────────────────
# It gates real outbound email, so it starts as a dry run: each email is written and saved as a draft,
# nothing is sent. Switch to mode="send" once the drafts look right (and consider max_sends_per_day).
# `delivery` is where "send" mode sends: "telegram" posts each application to your Telegram chat (with
# copy buttons, for you to send by hand); "gmail" / "outlook" email the company from that account
# (credentials above; for Gmail and Outlook run `python mail_setup.py connect <provider>` once).

EMAIL = EmailConfig(
    enabled=True,
    mode="dry_run",           # "dry_run" | "send"
    delivery="telegram",      # "telegram" | "gmail" | "outlook"
    max_sends_per_day=None,   # stop sending after this many emails today; None = no cap (start low: attachments
                              # from a new domain are spam-filtered more readily)
    attach_resume=True,       # attach the uploaded resume to every email (the pool waits until there is one)
    instructions="",          # your own rules for writing the emails (set on the dashboard's Settings page)
)
EMAIL = APP_SETTINGS.apply(EMAIL, app_settings.EMAIL_COLUMNS)
