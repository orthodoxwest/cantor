-- What the library shows of a chant: `title` becomes its English opening words, `name` the
-- score's own name (often Latin), with its kind, book, source address and words for search.
-- `private` rows (booklet-derived, seeded from cantor-content) are served only to a known caller.
ALTER TABLE chants ADD COLUMN name TEXT;
ALTER TABLE chants ADD COLUMN kind TEXT;
ALTER TABLE chants ADD COLUMN book TEXT;
ALTER TABLE chants ADD COLUMN url TEXT;
ALTER TABLE chants ADD COLUMN words TEXT;
ALTER TABLE chants ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
