CREATE TABLE chants (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  mode TEXT,
  source TEXT,
  gabc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE takes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chant_slug TEXT NOT NULL REFERENCES chants(slug),
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  duration_s REAL,
  report_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX takes_by_user ON takes(user_id, created_at);
