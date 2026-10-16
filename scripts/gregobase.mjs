// Adds GregoBase's English scores (CC0) to content/chants, from a folder of them: `<id>.gabc`
// and an index.jsonl with each score's id, language, licence and url:
//   node scripts/gregobase.mjs path/to/gregobase
// Each lands as `<name>-<id>.gabc` with the headers content/build.mjs asks for. Scores already
// here (by url) are left alone, as are any neuma finds an error in, which are listed. People are
// never named: the transcriber header is left out, the source address credits them.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Chant, init } from "../vendor/neuma/neuma.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/gregobase.mjs GREGOBASE_FOLDER");
  process.exit(2);
}
const chants = fileURLToPath(new URL("../content/chants/", import.meta.url));

const have = new Set(
  readdirSync(chants)
    .filter((f) => f.endsWith(".gabc"))
    .map((f) => /^url:(.*?);\s*$/m.exec(readFileSync(join(chants, f), "utf8"))?.[1]?.trim()),
);

const slugOf = (name) =>
  name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-$/, "");

await init();
let added = 0;
const skipped = [];
for (const line of readFileSync(join(dir, "index.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const entry = JSON.parse(line);
  if (!entry.language?.startsWith("en") || !/^CC0\b/.test(entry.licence ?? "") || entry.copyrighted_flag) continue;
  if (have.has(entry.url)) continue;
  for (const file of entry.files) {
    const gabc = readFileSync(join(dir, file), "utf8").replace(/\r\n?/g, "\n");
    const [head, ...body] = gabc.split(/^%%$/m);
    if (!body.length) {
      skipped.push(`${file}: no %% line`);
      continue;
    }
    // The score's own headers, less any this script writes.
    const kept = head
      .split("\n")
      .filter((l) => l.trim() && !/^(source|licence|url|transcriber):/.test(l))
      .join("\n");
    const name = /^name:(.*?);\s*$/m.exec(kept)?.[1]?.trim() || entry.incipit || "chant";
    const out = `${kept}\nsource:GregoBase;\nlicence:CC0;\nurl:${entry.url};\n%%${body.join("%%")}`;
    const chant = new Chant(out);
    const errors = chant.diagnostics.filter((d) => d.severity === "error");
    chant.free();
    if (errors.length) {
      skipped.push(`${file}: ${errors[0].code}: ${errors[0].message}`);
      continue;
    }
    const slug = `${slugOf(name) || "chant"}-${entry.id}${entry.files.length > 1 ? `-${entry.files.indexOf(file) + 1}` : ""}`;
    if (existsSync(join(chants, `${slug}.gabc`))) continue;
    writeFileSync(join(chants, `${slug}.gabc`), out.endsWith("\n") ? out : `${out}\n`);
    added++;
  }
}
console.log(`${added} scores added to content/chants; ${skipped.length} left out`);
for (const s of skipped) console.log(`  ${s}`);
