// Turns content/dist/library.json into out/seed.sql for the local D1 database.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const library = JSON.parse(readFileSync(path.join(root, "content/dist/library.json"), "utf8"));
const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

const sql = library.map(
  (c) =>
    `INSERT INTO chants (slug, title, mode, source, gabc) VALUES (${q(c.slug)}, ${q(c.title)}, ${q(c.mode)}, ${q(c.source)}, ${q(c.gabc)})\n` +
    "  ON CONFLICT(slug) DO UPDATE SET title = excluded.title, mode = excluded.mode, source = excluded.source, gabc = excluded.gabc;",
);
const out = path.join(root, "out/seed.sql");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, sql.join("\n") + "\n");
console.log(`${library.length} chants -> ${path.relative(process.cwd(), out)}`);
console.log(`apply with: npx wrangler d1 execute cantor --local --file ${path.relative(process.cwd(), out)}`);
