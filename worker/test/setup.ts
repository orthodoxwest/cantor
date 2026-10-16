// Runs before each test file: the schema, then three chants (one private) and two made-up
// pointings to read back.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const insert = (table: string) =>
  env.DB.prepare(`INSERT OR IGNORE INTO ${table} (slug, title, name, mode, kind, source, words, gabc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
await env.DB.batch([
  insert("chants").bind("ubi-caritas", "Where charity and love are", "Ubi caritas", "6", "antiphon", "test", "Where charity", "name:Ubi caritas;\n%%\n(c4) WHere(f) cha(gh)ri(hg)ty(h) (::)"),
  insert("chants").bind("crux-fidelis", "Faithful Cross", "Crux fidelis", "1", "hymn", "test", "Faithful Cross", "name:Crux fidelis;\n%%\n(c4) FAith(d)ful(e) Cross,(gh) (::)"),
  insert("private_chants").bind("private-test", "Booklet antiphon", "Test", "ii", "antiphon", "booklet", "Booklet", "name:Test;\n%%\n(c4) BOok(f) (::)"),
]);

const pointing = env.DB.prepare(
  "INSERT OR IGNORE INTO pointings (id, psalm, label, tone, nearest, match, section, verses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
await env.DB.batch([
  pointing.bind("test/1", "116a", "viii.1", "8.G", "8.G", "exact", "Test", '[{"n":1,"pointed":"I am well · pléased * that the Lord hath · héard"}]'),
  pointing.bind("test/2", "16", "i.2", null, "1.a", "close", null, '[{"n":1,"pointed":"Preserve me, O · Gód * for in thee have I · pút my trust."}]'),
]);
