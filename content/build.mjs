// Validates every score in content/chants with neuma and writes content/dist/library.json,
// and checks that every psalm in content/psalter.json sets to every tone without error.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chant, init, psalm, summarize, toneNames } from "../vendor/neuma/neuma.mjs";
import { chantRow, headers } from "./chant-row.mjs";

const chantsDir = fileURLToPath(new URL("chants/", import.meta.url));
const distDir = fileURLToPath(new URL("dist/", import.meta.url));

await init();
let failed = false;
const library = [];
for (const file of readdirSync(chantsDir).filter((f) => f.endsWith(".gabc")).sort()) {
  const slug = file.slice(0, -5);
  const gabc = readFileSync(chantsDir + file, "utf8");
  const h = headers(gabc);
  const problems = [];
  for (const key of ["name", "source", "licence", "url"]) if (!h[key]) problems.push(`missing ${key}: header`);
  if (h.licence && h.licence !== "CC0") problems.push(`licence is ${h.licence}, not CC0`);
  const chant = new Chant(gabc);
  for (const d of chant.diagnostics) {
    const line = `${d.severity} ${d.code}: ${d.message}`;
    if (d.severity === "error") problems.push(line);
    else console.warn(`${file}: ${line}`);
  }
  chant.free();
  if (problems.length) {
    failed = true;
    for (const p of problems) console.error(`${file}: ${p}`);
    continue;
  }
  library.push(chantRow(slug, gabc, summarize));
}
const { psalms } = JSON.parse(readFileSync(new URL("psalter.json", import.meta.url), "utf8"));
for (const entry of psalms) {
  const text = entry.verses.map((v, i) => `${entry.first + i} ${v}`).join("\n");
  for (const tone of toneNames()) {
    for (const d of psalm(text, tone).diagnostics) {
      if (d.severity !== "error") continue;
      failed = true;
      console.error(`psalter.json psalm ${entry.id}, tone ${tone}: ${d.code}: ${d.message}`);
    }
  }
}
if (failed) process.exit(1);
mkdirSync(distDir, { recursive: true });
writeFileSync(distDir + "library.json", JSON.stringify(library, null, 2) + "\n");
console.log(`${library.length} chants -> content/dist/library.json; ${psalms.length} psalms set to every tone`);
