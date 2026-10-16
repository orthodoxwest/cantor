// Runs before each test file: the schema, then two chants to read back.
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
