-- A private chant's aligned recording: its ribbon as `cantor recording` prints it (JSON), which
-- the practice page draws under the singer's trace after a take. Served only with the chant.
ALTER TABLE private_chants ADD COLUMN recording TEXT;
