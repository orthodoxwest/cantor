-- A chant sung in a voice made from a cantor's, rendered off line from its GABC (cantor-content's
-- voice scripts): the GABC's SHA-256, so that a chant corrected since is not heard as it was; the
-- seconds a pulse and the semitones from the GABC's pitch it was sung at; and the second of its
-- sound at which the chant's first pulse falls. Its sound is in R2 at renderings/<slug>.flac.
-- Heard only by a signed-in caller, as Sung on the practice page.
CREATE TABLE renderings (
  slug TEXT PRIMARY KEY,
  gabc_sha256 TEXT NOT NULL,
  pulse REAL NOT NULL,
  transpose INTEGER NOT NULL,
  zero REAL NOT NULL
);
