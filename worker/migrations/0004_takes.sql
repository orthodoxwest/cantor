-- A take a singer sent: the row names it and its owner; the take's audio and its judged result
-- (as the core computed it when it was sung, with the score it was judged against) are in R2
-- under `takes/<id>.wav` and `takes/<id>.json`. The id is the capability: anyone holding it may
-- hear the take, so it is random (192 bits) and nothing lists takes to a reader. The table of
-- 0001 was never written; it is replaced, its chant reference with it, since a take may be of a
-- private chant.
DROP TABLE IF EXISTS takes;

CREATE TABLE takes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chant_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  seconds REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX takes_by_user ON takes(user_id, created_at);
