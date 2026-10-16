// Validates every score in content/chants with neuma and writes content/dist/library.json.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chant, init } from "../vendor/neuma/neuma.mjs";

const chantsDir = fileURLToPath(new URL("chants/", import.meta.url));
const distDir = fileURLToPath(new URL("dist/", import.meta.url));

/** GABC headers: `key:value;` lines before `%%`. */
function headers(gabc) {
  const head = gabc.split(/^%%$/m, 1)[0];
  const out = {};
  for (const m of head.matchAll(/^([\w-]+):([\s\S]*?);\s*$/gm)) out[m[1]] = m[2].trim();
  return out;
}

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
  library.push({ slug, title: h.name, mode: h.mode ?? null, source: h.source, licence: h.licence, url: h.url, gabc });
}
if (failed) process.exit(1);
mkdirSync(distDir, { recursive: true });
writeFileSync(distDir + "library.json", JSON.stringify(library, null, 2) + "\n");
console.log(`${library.length} chants -> content/dist/library.json`);
