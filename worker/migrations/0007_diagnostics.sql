-- What /diagnostics found about a browser's audio, as its visitor chose to send it: the rows of
-- the table they saw, and the browser's user agent. Nothing names who sent it.
CREATE TABLE diagnostics (
  id INTEGER PRIMARY KEY,
  user_agent TEXT NOT NULL,
  -- The table as JSON: [label, value] pairs.
  report TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
