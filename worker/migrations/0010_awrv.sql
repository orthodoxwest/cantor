-- Whether a chant is approved for use in the AWRV, whose services keep to a subset of the tones and
-- translations: 1 approved, 0 not, NULL not yet reviewed. The library filters by it.
ALTER TABLE chants ADD COLUMN awrv INTEGER;
ALTER TABLE private_chants ADD COLUMN awrv INTEGER;
