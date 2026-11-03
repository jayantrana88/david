"""
The shapes that config.py is built from, and the checks that reject a bad value (pydantic models).

config.py is the file you edit; this module is what it is built with. Every model validates itself when
it is created, so a typo in config.py fails at the line that has it, with a message that says what to fix.
Kept out of config.py so main.py can catch `ConfigError` even when config.py itself is the thing that
failed to import.
"""
from __future__ import annotations

import logging
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator

Level = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ConfigError(ValueError):
    """config.py holds a value that can't be used. The message says which one and what to fix."""


def _explain(model: str, exc: ValidationError) -> str:
    """One line per problem: `AIConfig.qualify_batch: Input should be less than or equal to 30 (got 50)`."""
    lines = []
    for err in exc.errors():
        where = ".".join(str(part) for part in (model, *err["loc"]))
        got = f" (got {err['input']!r})" if err["type"] != "missing" else ""
        lines.append(f"{where}: {err['msg']}{got}")
    return "; ".join(lines)


class _Config(BaseModel):
    """Frozen, strict (no silent "10" -> 10 or True -> 1), and an unknown field name is an error."""
    model_config = ConfigDict(frozen=True, strict=True, extra="forbid")

    def __init__(self, **data: Any) -> None:
        try:
            super().__init__(**data)
        except ValidationError as exc:
            raise ConfigError(_explain(type(self).__name__, exc)) from None

    def updated(self, **fields: Any):
        """A copy with `fields` changed, validated again."""
        return type(self)(**{**dict(self), **fields})


def _upper(value: Any) -> Any:
    return value.strip().upper() if isinstance(value, str) else value


# ── Logging ───────────────────────────────────────────────────────────────────

class LoggingConfig(_Config):
    """
    level:   default log level (DEBUG, INFO, WARNING, ERROR or CRITICAL) for logs/main/main.log and every pool.
    levels:  per-log override keyed by name: "main" or a pool ("sourcing", "scrape", "internal",
             "email"), e.g. {"sourcing": "DEBUG"}.
    console: echo logs/main/main.log to the terminal. The per-pool logs are file-only.
    The LOG_LEVEL environment variable overrides both levels for a single run.
    """
    level: Level = "INFO"
    levels: dict[str, Level] = {}
    console: bool = True

    _level = field_validator("level", mode="before")(_upper)

    @field_validator("levels", mode="before")
    @classmethod
    def _levels(cls, value: Any) -> Any:
        return {k: _upper(v) for k, v in value.items()} if isinstance(value, dict) else value

    def level_for(self, name: str) -> int:
        """The numeric level for the log called `name` (its own override, else the default)."""
        return logging.getLevelName(self.levels.get(name, self.level))


# ── Rate limits ───────────────────────────────────────────────────────────────

class ApiLimit(_Config):
    concurrency: int = Field(ge=1)      # requests in flight at once
    rpm: int = Field(ge=1)              # requests per minute, evenly spaced


# ── AI provider ───────────────────────────────────────────────────────────────

class LLMProfile(_Config):
    """
    One AI role's provider: the model(s) that answer it, through LiteLLM. AIConfig holds one per role.

    models:       the LiteLLM model strings, "<provider>/<model>", in order of preference, e.g.
                  ["groq/openai/gpt-oss-120b", "groq/openai/gpt-oss-20b"]. A single string is fine too. The
                  first model whose quota isn't used up answers; when one runs out (a "per day" limit, or a
                  429 asking to wait longer than `quota_switch_after`), the next takes over until its quota
                  resets. Every model shares this profile's key and settings, so keep them on one provider.
    api_key:      the key itself (the dashboard's AI key). None = the variable LiteLLM expects for that
                  provider (GROQ_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ...), if the process has one.
    api_base:     override the provider's URL (a proxy, a self-hosted server). None = the provider's own.
    temperature:  sampling temperature, 0 to 2. None = the provider's default.
    max_tokens:   cap on the reply length. None = the provider's default.
    timeout:      seconds to wait for one reply before it counts as a failed attempt.
    extra_params: further keyword arguments handed to `litellm.acompletion` as they are,
                  e.g. {"reasoning_effort": "low"}, or {"mock_response": '{"qualified": true}'} to test offline.
    structured_output: how each reply's schema (prompts/schemas.py) is sent. "json_schema" = the full schema,
                  which LiteLLM translates for the provider (the default); "json_object" = only "reply in JSON",
                  for a provider that rejects schemas; "off" = nothing, for one that rejects both. The prompts
                  describe the JSON in words, so every mode works; the stricter ones just fail less often.
    quota_switch_after: seconds. A rate-limit answer asking us to wait longer than this means the model's
                  quota is used up: the next model in `models` is tried instead of waiting. A shorter wait (a
                  per-minute limit) is retried on the same model.
    How often it is called is set by RATE_LIMITS["llm"] in config.py.
    """
    models: list[Text] = Field(min_length=1)
    api_key: Text | None = None
    api_base: Text | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1)
    timeout: float = Field(default=120, gt=0)
    extra_params: dict[str, Any] = {}
    structured_output: Literal["json_schema", "json_object", "off"] = "json_schema"
    quota_switch_after: float = Field(default=60, gt=0)

    @field_validator("models", mode="before")
    @classmethod
    def _one_model(cls, value: Any) -> Any:
        return [value] if isinstance(value, str) else value


class AIConfig(_Config):
    """
    The AI: who qualifies the leads (scrape pool), who writes the emails (email pool), who reads the
    resume (profile pool), and how they batch.

    qualify:      the LLMProfile the scrape pool asks "is this company a fit for the candidate?" (and for a summary).
    email:        the LLMProfile the email pool has write the emails.
    profile:      the LLMProfile the profile pool has read the resume into the candidate profile.
    qualify_batch: how many leads the AI qualifies in ONE call (fewer tokens and requests), 1 to 30. 1 = one
                  call per lead. The scrape pool's round of leads is split into calls of this many.
    email_batch:  how many leads' first email draft the AI writes in ONE call, 1 to 10. 1 = one call per
                  lead. Only a lead's first attempt is ever batched; a rewrite (after its draft failed the
                  rule check) always goes out on its own, since its feedback is specific to that lead.
    """
    qualify: LLMProfile
    email: LLMProfile
    profile: LLMProfile
    qualify_batch: int = Field(default=1, ge=1, le=30)
    email_batch: int = Field(default=1, ge=1, le=10)


# ── Email pool ────────────────────────────────────────────────────────────────

class EmailConfig(_Config):
    """
    How the email pool behaves.

    enabled:           False = the email pool doesn't start.
    mode:              "dry_run" writes each email and saves it as a `draft` row for review, sending nothing;
                       "send" delivers each email through `delivery`.
    delivery:          where "send" mode delivers: "telegram" posts each application to the Telegram chat (with
                       copy buttons; nothing reaches the company), "gmail" / "outlook" email the
                       company from that account.
    max_sends_per_day: stop sending after this many emails were sent today (the count starts again at
                       midnight, and on every daemon start). None = no cap. Protects a new sending
                       chat from being flooded.
    attach_resume:     attach the candidate's uploaded resume to every email. True = the pool waits until a
                       resume is uploaded; False = text-only emails.
    instructions:      the user's own rules for writing the emails (tone, format, what to mention), added to
                       the prompt. "" = none. The built-in rules that writer.check_rules enforces still win.
    """
    enabled: bool = True
    mode: Literal["dry_run", "send"] = "dry_run"
    delivery: Literal["telegram", "gmail", "outlook"] = "telegram"
    max_sends_per_day: int | None = Field(default=None, ge=1)
    attach_resume: bool = True
    instructions: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] = ""
