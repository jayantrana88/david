-- schema.sql — every table DAVID needs, in the local SQLite database (data/david.db).
-- Applied automatically, by the daemon (core/sqlite.py) and the dashboard (dashboard/src/lib/db.ts),
-- each time they open the file: every statement is IF NOT EXISTS / OR IGNORE, so it is safe to re-run.
-- CREATE TABLE IF NOT EXISTS never changes a table that already exists: a column added or removed later is
-- also listed in core/sqlite.py (ADDED_COLUMNS / DROPPED_COLUMNS), which brings an older file up to date.
-- Per the project rules there is no reaper and no attempt-counter column anywhere.
--
-- SQLite types used for what Postgres had:
--   ids          TEXT, a random 32-hex-char id (tasks: INTEGER autoincrement)
--   booleans     INTEGER 0 / 1 (NULL where "not decided" means something)
--   timestamps   TEXT, ISO-8601 UTC with milliseconds: 2026-10-23T09:15:02.123Z (sorts as text)
--   jsonb / [ ]  TEXT holding JSON (decoded by clients/db and the dashboard's data layer)
--   single-row   id INTEGER PRIMARY KEY CHECK (id = 1)

-- ── 1. tasks: the sourcing pool's work queue, filled from the dashboard ─────────
CREATE TABLE IF NOT EXISTS tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL DEFAULT 'linkedin' CHECK (source IN ('linkedin')),
    category         TEXT NOT NULL,                       -- kind of company, e.g. 'software company'
    location         TEXT NOT NULL,
    candidates       INTEGER NOT NULL DEFAULT 10 CHECK (candidates BETWEEN 1 AND 1000),   -- leads to save
    metro_radius_km  REAL CHECK (metro_radius_km IS NULL OR metro_radius_km > 0),
    max_employees    INTEGER NOT NULL DEFAULT 50 CHECK (max_employees BETWEEN 1 AND 100000),
    target_role      TEXT CHECK (target_role IS NULL OR length(target_role) <= 200),  -- NULL = the profile's roles
    opportunity_type TEXT CHECK (opportunity_type IS NULL OR opportunity_type IN ('job', 'internship', 'either')),
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    repeat_daily     INTEGER NOT NULL DEFAULT 0 CHECK (repeat_daily IN (0, 1)),   -- 1 = queued again 24 h after it finishes
    leads_saved     INTEGER NOT NULL DEFAULT 0,          -- progress counter only
    error            TEXT,
    started_at       TEXT,
    finished_at      TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS tasks_status_created_idx ON tasks (status, created_at);

-- updated_at changes on every update that doesn't set it itself: the sourcing Worker keys its in-memory
-- "done" set on "<id>@<updated_at>", so a re-queued task is not skipped, and save_profile only applies its
-- result while candidate_profile.updated_at is unchanged. (An UPDATE ... RETURNING reports the value from
-- before this trigger ran.)
CREATE TRIGGER IF NOT EXISTS tasks_touch AFTER UPDATE ON tasks
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ── 2. websites: one row per company (a "lead") ─────────────────────────────────
CREATE TABLE IF NOT EXISTS websites (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name             TEXT,
    website_url      TEXT NOT NULL,
    email            TEXT,                -- comma-separated addresses, homepage first (the email pool needs it)
    phone_number     TEXT,
    category         TEXT,
    location         TEXT,
    owner            TEXT,
    source           TEXT,                -- 'linkedin'
    employee_size    TEXT,                -- LinkedIn's size band, e.g. '11-50 employees'
    employee_max     INTEGER,             -- upper end of that band
    industry         TEXT,
    linkedin_url     TEXT,
    target_role      TEXT,                -- the task's override; NULL = the profile's roles
    opportunity_type TEXT,                -- the task's override; NULL = the profile's
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- No unique index on website_url on purpose: dedupe is in memory (the daemon maps a unique violation to
-- DUPLICATE if you add one, but nothing here requires it).
CREATE INDEX IF NOT EXISTS websites_website_url_idx ON websites (website_url);
CREATE INDEX IF NOT EXISTS websites_created_idx ON websites (created_at);

CREATE TRIGGER IF NOT EXISTS websites_touch AFTER UPDATE ON websites
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE websites SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ── 3. website_scrapes: the homepage read + the AI's fit verdict ────────────────
CREATE TABLE IF NOT EXISTS website_scrapes (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    website_id    TEXT NOT NULL REFERENCES websites (id) ON DELETE CASCADE,
    homepage_text TEXT,                  -- the homepage text the AI judged (re-used when it is asked again)
    raw_json      TEXT,                  -- JSON: Jina's whole reply, only on rows saved before homepage_text
    links         TEXT,                  -- JSON: Jina's link summary, only on rows saved before homepage_text
    main_links    TEXT,                  -- JSON: {link text: url}, the pages the internal pool reads
    summary       TEXT,                  -- what the company does and why it fits the candidate
    is_qualified  INTEGER CHECK (is_qualified IN (0, 1)),   -- 1 / 0 / NULL = the AI hasn't answered yet (retried)
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

-- ── 4. website_pages: up to 5 internal pages per qualified lead ─────────────────
CREATE TABLE IF NOT EXISTS website_pages (
    id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    scrape_id     TEXT NOT NULL REFERENCES website_scrapes (id) ON DELETE CASCADE,
    page_name     TEXT,
    page_url      TEXT,
    content_json  TEXT,                  -- JSON; NULL = a placeholder left by a failed read (retried)
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS website_pages_scrape_idx ON website_pages (scrape_id);

-- ── 5. cold_emails: one row per lead (the application) ──────────────────────────
-- status is the tracking mechanism the email pool's queue reads (workers/load.py::uncontacted_leads):
-- draft / sending / sent / rejected / generation_failed all exclude the lead; only send_failed is offered again.
CREATE TABLE IF NOT EXISTS cold_emails (
    id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    website_id       TEXT NOT NULL REFERENCES websites (id) ON DELETE CASCADE,
    email_address    TEXT,
    subject          TEXT,
    body             TEXT,
    attachment_name  TEXT,               -- the resume file that went with it
    delivery         TEXT,               -- how it was sent: 'telegram' (to your chat) / 'gmail' / 'outlook'
    status           TEXT NOT NULL DEFAULT 'sending'
                     CHECK (status IN ('draft', 'sending', 'sent', 'send_failed', 'rejected', 'generation_failed')),
    sent_at          TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS cold_emails_website_idx ON cold_emails (website_id);
CREATE INDEX IF NOT EXISTS cold_emails_status_idx ON cold_emails (status);

-- ── 6. candidate_profile: one row, the person applying ──────────────────────────
CREATE TABLE IF NOT EXISTS candidate_profile (
    id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    -- the resume file (data/resumes/<resume_path>) and its extracted text
    resume_path       TEXT,
    resume_filename   TEXT,
    resume_mime       TEXT,
    resume_sha256     TEXT,
    resume_text       TEXT,
    career_notes      TEXT,
    -- derived by the profile pool, editable on the dashboard
    full_name         TEXT,
    headline          TEXT,
    summary           TEXT,
    skills            TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
    experience_years  REAL,
    education         TEXT,
    target_roles      TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
    opportunity_type  TEXT NOT NULL DEFAULT 'either' CHECK (opportunity_type IN ('job', 'internship', 'either')),
    phone             TEXT,
    linkedin_url      TEXT,
    portfolio_url     TEXT,
    -- the profile pool's queue: the dashboard sets 'pending' on upload / "re-derive"
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

-- ── 7. app_settings / app_secrets: single-row dashboard settings ─
CREATE TABLE IF NOT EXISTS app_settings (
    id                        INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    version                   INTEGER NOT NULL DEFAULT 1,
    sender_name               TEXT,
    ai_model                  TEXT,
    cloudflare_account_id     TEXT,
    ai_qualify_batch          INTEGER,
    ai_email_batch            INTEGER,
    email_enabled             INTEGER CHECK (email_enabled IN (0, 1)),
    email_mode                TEXT CHECK (email_mode IS NULL OR email_mode IN ('dry_run', 'send')),
    email_delivery            TEXT CHECK (email_delivery IS NULL OR email_delivery IN ('telegram', 'gmail', 'outlook')),
    email_max_sends_per_day   INTEGER,
    email_instructions        TEXT,           -- the user's own rules for writing the applications
    -- written back by the daemon so the dashboard can show "restart required"
    applied_version           INTEGER,
    applied_at                TEXT,
    applied_mode              TEXT,
    apply_error               TEXT,
    updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS app_secrets (
    id                   INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    jina_api_key         TEXT,
    serper_api_key       TEXT,
    ai_api_key           TEXT,           -- the AI provider's key (Workers AI by default)
    telegram_bot_token   TEXT,           -- EMAIL.delivery telegram: the bot and the chat it posts to
    telegram_chat_id     TEXT,
    gmail_client_id      TEXT,           -- EMAIL.delivery gmail / outlook: the OAuth client
    gmail_client_secret  TEXT,
    outlook_client_id    TEXT,
    outlook_client_secret TEXT,
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The optional dashboard password (a scrypt hash). No row = the dashboard is open. The daemon never reads it.
CREATE TABLE IF NOT EXISTS dashboard_lock (
    id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    password_hash  TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO app_settings (id) VALUES (1);
INSERT OR IGNORE INTO app_secrets  (id) VALUES (1);

