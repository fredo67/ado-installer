-- ADO Installer — install log only. No tokens, no auth state, ever.
CREATE TABLE IF NOT EXISTS installs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain      TEXT    NOT NULL,
  registrar   TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_installs_domain ON installs (domain);
