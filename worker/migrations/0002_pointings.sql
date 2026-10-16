-- Psalms as the parish booklets point them. Private: rows come from the cantor-content
-- repository's seed script, applied by hand, never from this repository.
CREATE TABLE pointings (
  id TEXT PRIMARY KEY,
  -- Hebrew (BCP) psalm number, with a letter for the Vulgate's halves ("116b").
  psalm TEXT NOT NULL,
  -- The tone as the booklet prints it ("viii.1"), and the built-in tone it matches.
  label TEXT NOT NULL,
  tone TEXT,
  nearest TEXT,
  match TEXT NOT NULL DEFAULT 'none',
  section TEXT,
  -- JSON: [{ n, pointed, gloria? }].
  verses TEXT NOT NULL
);

CREATE INDEX pointings_by_psalm ON pointings(psalm);
