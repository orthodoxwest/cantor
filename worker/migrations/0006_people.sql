-- The name a signed-in person gives, shown beside their comments on a take in place of who
-- Access says they are (their email is never shown).
CREATE TABLE people (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The writer's name as it was when they wrote the comment: renaming later changes none of it.
ALTER TABLE take_comments ADD COLUMN author_name TEXT;
