// Writes content/psalter.json, the Coverdale psalter (BCP 1662, Hebrew numbering) with each
// psalm's Latin incipit, from a checkout of the public Office repository:
//   node scripts/psalter.mjs ../office
// Each verse keeps the Office text's `*` and `†`; the opening word's capitals become
// sentence case.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const office = process.argv[2];
if (!office) {
  console.error("usage: node scripts/psalter.mjs OFFICE_CHECKOUT");
  process.exit(2);
}
const out = fileURLToPath(new URL("../content/psalter.json", import.meta.url));

const incipits = new Map();
for (const line of readFileSync(join(office, "data/latin-incipits.txt"), "utf8").split("\n")) {
  const m = line.match(/^psalms\/(\d{3}(?:-[ivx]+)?)\s*=\s*(.+?)\s*$/);
  if (m) incipits.set(m[1], m[2]);
}
const UNITS = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix"];
const ROMAN = Array.from({ length: 22 }, (_, i) => "x".repeat(Math.floor((i + 1) / 10)) + UNITS[(i + 1) % 10]);

// Words kept capitalised when the opening capitals are lowered.
const PROPER = new Set(["LORD", "GOD", "JEWRY", "I", "O"]);

/** "I WILL love thee, O LORD" -> "I will love thee, O Lord": the opening run of capitals. */
export function sentenceCase(verse) {
  let first = true;
  return verse.replace(/^(?:[A-Z][A-Z']*\b[\s,;:!]*)+/, (run) =>
    run.replace(/[A-Z][A-Z']*/g, (word) => {
      const keep = first || PROPER.has(word);
      first = false;
      if (word.length === 1) return word;
      return keep ? word[0] + word.slice(1).toLowerCase() : word.toLowerCase();
    }),
  );
}

// A psalm, or for Psalm 119 each of its 22 parts (an unnumbered line opens a part), with
// `first`, the number of its first verse.
const psalms = [];
for (let n = 1; n <= 150; n++) {
  const key = String(n).padStart(3, "0");
  const file = join(office, "data/texts/psalms", `${key}.txt`);
  const parts = [];
  let count = 0;
  for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
    const text = line.trim();
    if (!text || text.startsWith("#") || text.startsWith("!")) continue;
    const m = text.match(/^(\d+)\.\s+(.*)$/);
    count++;
    if (m && Number(m[1]) !== count) throw new Error(`${file}: verse ${m[1]} after ${count - 1}`);
    if (!m) parts.push({ first: count, verses: [] });
    const verse = m ? m[2] : sentenceCase(text);
    if ((verse.match(/\*/g) ?? []).length !== 1) throw new Error(`${file}: verse ${count} has no single *`);
    parts.at(-1).verses.push(verse);
  }
  if (parts.length !== (n === 119 ? 22 : 1)) throw new Error(`${file}: ${parts.length} parts`);
  parts.forEach((part, i) => {
    const id = parts.length > 1 ? `${n}-${ROMAN[i]}` : String(n);
    const incipit = incipits.get(parts.length > 1 ? `${key}-${ROMAN[i]}` : key);
    if (!incipit) throw new Error(`no Latin incipit for psalm ${id}`);
    psalms.push({ id, number: n, ...(parts.length > 1 ? { part: ROMAN[i] } : {}), first: part.first, incipit, verses: part.verses });
  });
}

const source = "Book of Common Prayer (1662), Coverdale psalter, via github.com/orthodoxwest/office";
writeFileSync(out, JSON.stringify({ source, psalms }, null, 0).replace(/\},\{"id"/g, '},\n{"id"') + "\n");
console.log(`${psalms.length} psalms and parts -> content/psalter.json`);
