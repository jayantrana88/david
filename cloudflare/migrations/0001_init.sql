-- The job applier's D1 database. The same tables as the local SQLite file (../db/schema.sql), plus what a
-- Worker needs because it keeps nothing in memory between ticks (marked "Worker only"):
--   tasks.cursor          a running task's progress, so a search goes on where the last tick stopped
--   websites.url_key      the normalized website URL, for dedupe (the daemon keeps that set in memory)
--   resume_files          the uploaded resume itself (base64), instead of data/resumes/
--   stage_state           per stage: held until / idle until / what it did last
--   backoff               items to leave alone until a time (the daemon's in-memory `_retry_at`); no counters
--   mail_tokens           Gmail / Outlook sign-ins (data/mail_tokens/ in the daemon)
--   geo_cache             Open-Meteo geocoding answers (the daemon bundles the gazetteer instead)
--   logs                  recent log lines, shown on the dashboard
-- Per the project rules there is no reaper and no attempt-counter column on any lead table.
-- Ids are random 32-hex-char text (tasks: INTEGER), timestamps ISO-8601 UTC text, booleans 0/1, JSON as text.

CREATE TABLE IF NOT EXISTS tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL DEFAULT 'linkedin' CHECK (source IN ('linkedin')),
    category         TEXT NOT NULL,
    location         TEXT NOT NULL,
    candidates       INTEGER NOT NULL DEFAULT 10 CHECK (candidates BETWEEN 1 AND 1000),
    metro_radius_km  REAL CHECK (metro_radius_km IS NULL OR metro_radius_km >= 0),
    max_employees    INTEGER NOT NULL DEFAULT 50 CHECK (max_employees BETWEEN 1 AND 100000),
    target_role      TEXT CHECK (target_role IS NULL OR length(target_role) <= 200),
    opportunity_type TEXT CHECK (opportunity_type IS NULL OR opportunity_type IN ('job', 'internship', 'either')),
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    repeat_daily     INTEGER NOT NULL DEFAULT 0 CHECK (repeat_daily IN (0, 1)),
    leads_saved      INTEGER NOT NULL DEFAULT 0,
    cursor           TEXT,                                  -- Worker only: JSON progress of the running search
    error            TEXT,
    started_at       TEXT,
    finished_at      TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS tasks_status_created_idx ON tasks (status, created_at);

CREATE TRIGGER IF NOT EXISTS tasks_touch AFTER UPDATE ON tasks
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS websites (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name             TEXT,
    website_url      TEXT NOT NULL,
    url_key          TEXT,                                  -- Worker only: normalizeUrl(website_url)
    email            TEXT,
    phone_number     TEXT,
    category         TEXT,
    location         TEXT,
    owner            TEXT,
    source           TEXT,
    employee_size    TEXT,
    employee_max     INTEGER,
    industry         TEXT,
    linkedin_url     TEXT,
    target_role      TEXT,
    opportunity_type TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS websites_url_key_idx ON websites (url_key);
CREATE INDEX IF NOT EXISTS websites_created_idx ON websites (created_at);

CREATE TRIGGER IF NOT EXISTS websites_touch AFTER UPDATE ON websites
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE websites SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS website_scrapes (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    website_id    TEXT NOT NULL REFERENCES websites (id) ON DELETE CASCADE,
    homepage_text TEXT,
    main_links    TEXT,                  -- JSON: {link text: url}
    summary       TEXT,
    is_qualified  INTEGER CHECK (is_qualified IN (0, 1)),   -- NULL = the AI hasn't answered yet (asked again)
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS website_scrapes_website_idx ON website_scrapes (website_id);
CREATE INDEX IF NOT EXISTS website_scrapes_qualified_idx ON website_scrapes (is_qualified);

CREATE TRIGGER IF NOT EXISTS website_scrapes_touch AFTER UPDATE ON website_scrapes
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE website_scrapes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS website_pages (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    scrape_id     TEXT NOT NULL REFERENCES website_scrapes (id) ON DELETE CASCADE,
    page_name     TEXT,
    page_url      TEXT,
    content_json  TEXT,                  -- NULL = placeholder of a failed read (read again)
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS website_pages_scrape_idx ON website_pages (scrape_id);

CREATE TABLE IF NOT EXISTS cold_emails (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    website_id       TEXT NOT NULL REFERENCES websites (id) ON DELETE CASCADE,
    email_address    TEXT,
    subject          TEXT,
    body             TEXT,
    attachment_name  TEXT,
    delivery         TEXT,
    status           TEXT NOT NULL DEFAULT 'sending'
                     CHECK (status IN ('draft', 'sending', 'sent', 'send_failed', 'rejected', 'generation_failed')),
    sent_at          TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS cold_emails_website_idx ON cold_emails (website_id);
CREATE INDEX IF NOT EXISTS cold_emails_status_idx ON cold_emails (status);

CREATE TABLE IF NOT EXISTS candidate_profile (
    id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    resume_path       TEXT,                                 -- the resume_files row (its sha256)
    resume_filename   TEXT,
    resume_mime       TEXT,
    resume_sha256     TEXT,
    resume_text       TEXT,
    career_notes      TEXT,
    full_name         TEXT,
    headline          TEXT,
    summary           TEXT,
    skills            TEXT NOT NULL DEFAULT '[]',
    experience_years  REAL,
    education         TEXT,
    target_roles      TEXT NOT NULL DEFAULT '[]',
    opportunity_type  TEXT NOT NULL DEFAULT 'either' CHECK (opportunity_type IN ('job', 'internship', 'either')),
    phone             TEXT,
    linkedin_url      TEXT,
    portfolio_url     TEXT,
    parse_status      TEXT CHECK (parse_status IN ('pending', 'done', 'failed')),
    parse_error       TEXT,
    parsed_at         TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER IF NOT EXISTS candidate_profile_touch AFTER UPDATE ON candidate_profile
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE candidate_profile SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- Worker only: the resume file. Base64 text (D1 rows hold up to 2 MB): the mail providers want base64 anyway.
CREATE TABLE IF NOT EXISTS resume_files (
    sha256      TEXT PRIMARY KEY,
    filename    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    base64      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Settings: NULL = the default (src/settings.ts). Applied on the next tick; nothing to restart.
CREATE TABLE IF NOT EXISTS app_settings (
    id                        INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    sender_name               TEXT,
    ai_model                  TEXT,         -- a Workers AI model (@cf/...), or a model of ai_base_url's provider
    ai_base_url               TEXT,         -- Worker only: an OpenAI-compatible endpoint (with ai_api_key)
    ai_qualify_batch          INTEGER,
    ai_email_batch            INTEGER,
    email_enabled             INTEGER CHECK (email_enabled IN (0, 1)),
    email_mode                TEXT CHECK (email_mode IS NULL OR email_mode IN ('dry_run', 'send')),
    email_delivery            TEXT CHECK (email_delivery IS NULL OR email_delivery IN ('telegram', 'gmail', 'outlook')),
    email_max_sends_per_day   INTEGER,
    email_attach_resume       INTEGER CHECK (email_attach_resume IN (0, 1)),
    email_instructions        TEXT,
    linkedin_transport        TEXT CHECK (linkedin_transport IS NULL OR linkedin_transport IN ('browser', 'fetch')),
    sourcing_per_tick         INTEGER,      -- Worker only: LinkedIn pages read per tick
    outlook_tenant            TEXT,
    paused                    INTEGER CHECK (paused IN (0, 1)),   -- Worker only: 1 = the ticks do nothing
    version                   INTEGER NOT NULL DEFAULT 1,
    updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS app_secrets (
    id                    INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    jina_api_key          TEXT,
    serper_api_key        TEXT,
    ai_api_key            TEXT,             -- only for ai_base_url (Workers AI needs no key)
    telegram_bot_token    TEXT,
    telegram_chat_id      TEXT,
    gmail_client_id       TEXT,
    gmail_client_secret   TEXT,
    outlook_client_id     TEXT,
    outlook_client_secret TEXT,
    updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO app_settings (id) VALUES (1);
INSERT OR IGNORE INTO app_secrets  (id) VALUES (1);

-- Worker only ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS stage_state (
    stage        TEXT PRIMARY KEY,
    hold_until   TEXT,                      -- held (an AI quota, a rejected key, LinkedIn blocking...) until then
    hold_reason  TEXT,
    idle_until   TEXT,                      -- had nothing to do: not looked at again until then (or woken)
    fail_streak  INTEGER NOT NULL DEFAULT 0, -- ticks in a row where every item failed (the stage's cooldown)
    lease_until  TEXT,                      -- a tick is running this stage until then (ticks can overlap)
    last_run_at  TEXT,
    last_note    TEXT
);
INSERT OR IGNORE INTO stage_state (stage) VALUES ('profile'), ('sourcing'), ('scrape'), ('internal'), ('email');

CREATE TABLE IF NOT EXISTS backoff (
    item      TEXT PRIMARY KEY,             -- "<stage>:<id>"
    retry_at  TEXT NOT NULL,
    reason    TEXT
);
CREATE INDEX IF NOT EXISTS backoff_retry_idx ON backoff (retry_at);

CREATE TABLE IF NOT EXISTS mail_tokens (
    provider       TEXT PRIMARY KEY CHECK (provider IN ('gmail', 'outlook')),
    refresh_token  TEXT NOT NULL,
    email          TEXT,
    scope          TEXT,
    access_token   TEXT,
    expires_at     TEXT,
    saved_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS geo_cache (
    query       TEXT PRIMARY KEY,
    result      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    stage     TEXT NOT NULL,
    level     TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warning', 'error')),
    message   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_at_idx ON logs (at);
