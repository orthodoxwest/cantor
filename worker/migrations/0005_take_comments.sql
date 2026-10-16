-- Comments on a sent take, each on one note of its score. Whoever holds the take's link may
-- write one; `by_singer` is 1 only when the Worker knew the writer as the take's owner, and
-- `author_id` names a writer it knew at all.
CREATE TABLE take_comments (
  id INTEGER PRIMARY KEY,
  take_id TEXT NOT NULL REFERENCES takes(id),
  -- The note's index in the score's timeline.
  note INTEGER NOT NULL,
  body TEXT NOT NULL,
  by_singer INTEGER NOT NULL,
  author_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX take_comments_by_take ON take_comments(take_id, id);

-- How many notes a take was judged on, so a comment names one of them (null for a take sent
-- before this was kept).
ALTER TABLE takes ADD COLUMN notes INTEGER;
