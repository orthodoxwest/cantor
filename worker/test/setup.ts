// Runs before each test file: the schema, then three chants (one private) and two made-up
// pointings to read back.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const insert = env.DB.prepare(
  "INSERT OR IGNORE INTO chants (slug, title, name, mode, kind, source, words, private, gabc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
await env.DB.batch([
  insert.bind("ubi-caritas", "Where charity and love are", "Ubi caritas", "6", "antiphon", "test", "Where charity", 0, "name:Ubi caritas;\n%%\n(c4) WHere(f) cha(gh)ri(hg)ty(h) (::)"),
  insert.bind("crux-fidelis", "Faithful Cross", "Crux fidelis", "1", "hymn", "test", "Faithful Cross", 0, "name:Crux fidelis;\n%%\n(c4) FAith(d)ful(e) Cross,(gh) (::)"),
  insert.bind("meinrad-test", "Booklet antiphon", "Test", "ii", "antiphon", "booklet", "Booklet", 1, "name:Test;\n%%\n(c4) BOok(f) (::)"),
]);

const pointing = env.DB.prepare(
  "INSERT OR IGNORE INTO pointings (id, psalm, label, tone, nearest, match, section, verses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
await env.DB.batch([
  pointing.bind("test/1", "116a", "viii.1", "8.G", "8.G", "exact", "Test", '[{"n":1,"pointed":"I am well · pléased * that the Lord hath · héard"}]'),
  pointing.bind("test/2", "16", "i.2", null, "1.a", "close", null, '[{"n":1,"pointed":"Preserve me, O · Gód * for in thee have I · pút my trust."}]'),
]);
