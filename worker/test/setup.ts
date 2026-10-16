// Runs before each test file: the schema, then two chants and two made-up pointings to read back.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const insert = env.DB.prepare(
  "INSERT OR IGNORE INTO chants (slug, title, mode, source, gabc) VALUES (?, ?, ?, ?, ?)",
);
await env.DB.batch([
  insert.bind("ubi-caritas", "Ubi caritas", "6", "test", "name:Ubi caritas;\n%%\n(c4) WHere(f) cha(gh)ri(hg)ty(h) (::)"),
  insert.bind("crux-fidelis", "Crux fidelis", "1", "test", "name:Crux fidelis;\n%%\n(c4) FAith(d)ful(e) Cross,(gh) (::)"),
]);

const pointing = env.DB.prepare(
  "INSERT OR IGNORE INTO pointings (id, psalm, label, tone, nearest, match, section, verses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
await env.DB.batch([
  pointing.bind("test/1", "116a", "viii.1", "8.G", "8.G", "exact", "Test", '[{"n":1,"pointed":"I am well · pléased * that the Lord hath · héard"}]'),
  pointing.bind("test/2", "16", "i.2", null, "1.a", "close", null, '[{"n":1,"pointed":"Preserve me, O · Gód * for in thee have I · pút my trust."}]'),
]);
