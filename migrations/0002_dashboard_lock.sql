-- The optional dashboard password, set from the Settings page. No row = the dashboard is open. The Worker never
-- stores the password itself, only a salted hash.
CREATE TABLE IF NOT EXISTS dashboard_lock (
    id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    password_hash  TEXT NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
