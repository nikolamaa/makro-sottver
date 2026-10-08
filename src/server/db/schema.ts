/**
 * SQLite schema (node:sqlite). Every column named `payload` holds an AES-256-GCM blob produced by
 * Cipher.encrypt/encryptJson; plaintext columns contain only ids, timestamps, counters and enums.
 *
 * AAD conventions (must match between writer and reader):
 *   categories        "categories:<id>"
 *   macro_versions    "macro_versions:<macro_id>:<version>"
 *   facts             "facts:<id>"
 *   settings          "settings:<key>"
 *   embeddings        "embeddings:<model>:<content_hmac>"
 *   events            "events:<uid>"
 *   sources           "sources:<id>"
 *   source_snapshots  "source_snapshots:<id>"
 *   fact_checks       "fact_checks:<id>"
 *   update_proposals  "update_proposals:<id>"
 *   meta 'key_check'  "meta:key_check"
 */

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  payload    BLOB NOT NULL                       -- enc {name, color}
);

CREATE TABLE macros (
  id              TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT,
  is_favorite     INTEGER NOT NULL DEFAULT 0,
  use_count       INTEGER NOT NULL DEFAULT 0,
  last_used_at    TEXT,
  verification    TEXT NOT NULL DEFAULT 'unverified'
                  CHECK (verification IN ('verified','unverified','outdated','conflict'))
);

CREATE TABLE macro_versions (
  macro_id      TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  change_source TEXT NOT NULL
                CHECK (change_source IN ('create','manual','import','revert','seed','accuracy_check','learning')),
  content_hmac  TEXT NOT NULL,                   -- HMAC of canonical MacroContent JSON
  payload       BLOB NOT NULL,                   -- enc {content: MacroContent, changeNote}
  PRIMARY KEY (macro_id, version)
);

CREATE TABLE sources (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL
                  CHECK (type IN ('intercom_help_center','web_page','google_doc','google_sheet','confluence_page','slack_canvas','manual')),
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  last_fetched_at TEXT,
  last_status     TEXT,
  payload         BLOB NOT NULL                  -- enc {name, url, config, credentialRef}
);

CREATE TABLE facts (
  id              TEXT PRIMARY KEY,
  macro_id        TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
  sort            INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'unchecked'
                  CHECK (status IN ('unchecked','verified','outdated','contradicted','unverifiable')),
  last_checked_at TEXT,
  source_id       TEXT REFERENCES sources(id) ON DELETE SET NULL,
  payload         BLOB NOT NULL                  -- enc {key, statement, value, sourceUrl, evidenceQuote}
);
CREATE INDEX idx_facts_macro ON facts(macro_id);

CREATE TABLE settings (
  key     TEXT PRIMARY KEY,                      -- 'app' | 'secret:<name>'
  payload BLOB NOT NULL                          -- enc JSON
);

CREATE TABLE embeddings (
  model        TEXT NOT NULL,
  content_hmac TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  payload      BLOB NOT NULL,                    -- enc Float32Array bytes (vectors can leak text, so encrypted too)
  PRIMARY KEY (model, content_hmac)
);

CREATE TABLE events (
  uid     TEXT PRIMARY KEY,
  ts      TEXT NOT NULL,
  type    TEXT NOT NULL,
  payload BLOB NOT NULL                          -- enc UsageEventInput (never customer text)
);
CREATE INDEX idx_events_ts ON events(ts);

CREATE TABLE llm_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  month         TEXT NOT NULL,                   -- 'YYYY-MM'
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL NOT NULL
);
CREATE INDEX idx_llm_usage_month ON llm_usage(month);

-- Phase 3: accuracy checks (tables exist from day one so the schema stays stable)
CREATE TABLE source_snapshots (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  fetched_at   TEXT NOT NULL,
  content_hmac TEXT NOT NULL,
  payload      BLOB NOT NULL                     -- enc {title, url, passages:[{heading, text, hmac}]}
);
CREATE INDEX idx_snapshots_source ON source_snapshots(source_id, fetched_at);

CREATE TABLE accuracy_runs (
  id          TEXT PRIMARY KEY,
  trigger     TEXT NOT NULL CHECK (trigger IN ('schedule','manual','startup')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','partial')),
  stats       TEXT                               -- JSON with counts only (no content)
);

CREATE TABLE fact_checks (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES accuracy_runs(id) ON DELETE CASCADE,
  fact_id    TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL CHECK (verdict IN ('verified','outdated','contradicted','unverifiable')),
  method     TEXT NOT NULL CHECK (method IN ('unchanged_source','deterministic','llm','manual')),
  checked_at TEXT NOT NULL,
  payload    BLOB NOT NULL                       -- enc {evidenceQuote, sourceUrl, proposedValue, rationale}
);
CREATE INDEX idx_fact_checks_fact ON fact_checks(fact_id, checked_at);

CREATE TABLE update_proposals (
  id           TEXT PRIMARY KEY,
  macro_id     TEXT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES accuracy_runs(id) ON DELETE SET NULL,
  base_version INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','auto_approved','superseded')),
  severity     TEXT NOT NULL CHECK (severity IN ('minor','major')),
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  payload      BLOB NOT NULL                     -- enc {newContent, diff, reasons, sourceLinks, factUpdates}
);
CREATE INDEX idx_proposals_status ON update_proposals(status);

CREATE TABLE jobs (
  name           TEXT PRIMARY KEY,               -- e.g. 'accuracy_check'
  interval_hours REAL NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at    TEXT,
  last_run_at    TEXT
);
`,
  },
];
