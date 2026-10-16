-- What the library shows of a chant: `title` becomes its English opening words, `name` the
-- score's own name (often Latin), with its kind, book, source address and words for search.
ALTER TABLE chants ADD COLUMN name TEXT;
ALTER TABLE chants ADD COLUMN kind TEXT;
ALTER TABLE chants ADD COLUMN book TEXT;
ALTER TABLE chants ADD COLUMN url TEXT;
ALTER TABLE chants ADD COLUMN words TEXT;

-- The private chants (booklet-derived, seeded from cantor-content), served only to a known
-- caller. They have a table of their own so that no Worker older than this one, which reads
-- `chants` whole, can ever serve them.
CREATE TABLE private_chants (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  name TEXT,
  mode TEXT,
  kind TEXT,
  book TEXT,
  source TEXT,
  url TEXT,
  words TEXT,
  gabc TEXT NOT NULL
);
