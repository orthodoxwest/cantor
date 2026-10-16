// Measures the automatic pointer against a hand-pointed psalter, and the share of the psalter's
// words the stress dictionary doesn't know. The hand-pointed corpus is private and is never
// committed; pass its path:
//   node scripts/pointing-eval.mjs --corpus ../cantor-content/pointing-corpus/settings.jsonl \
//     [--cmudict cmudict.dict]
// The settings file has one JSON setting a line: `{ psalm, tone: { norm }, verses: [{ pointed,
// gloria?, requiem? }], duplicate_of? }`. Only totals are printed.
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { init } from "../vendor/neuma/neuma.mjs";
import { compareVerse, summarize, toneShapes } from "./agreement.mjs";

const { values } = parseArgs({
  options: {
    corpus: { type: "string" },
    cmudict: { type: "string" },
    tones: { type: "string", default: "vendor/neuma-src/crates/neuma-tones/tones/solesmes.tones" },
    stress: { type: "string", default: "vendor/neuma-src/crates/neuma-tones/tones/stress.txt" },
  },
});
await init();

const pct = (x) => `${(100 * x).toFixed(1)}%`;

if (values.corpus) {
  const builtins = existsSync(values.tones) ? toneShapes(readFileSync(values.tones, "utf8")) : [];
  const settings = readFileSync(values.corpus, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byPsalm = new Map();
  const all = [];
  let skipped = 0;
  for (const s of settings) {
    if (s.duplicate_of) continue;
    const norm = s.tone?.norm ?? "";
    const mode = norm === "peregrinus" ? "per" : (norm.match(/^\d/)?.[0] ?? "");
    const key = String(s.psalm_hebrew ?? s.psalm);
    for (const v of s.verses) {
      if (v.gloria || v.requiem) continue;
      const results = compareVerse(v.pointed, mode, builtins);
      if (results.length < 2) skipped += 2 - results.length;
      all.push(...results);
      byPsalm.set(key, [...(byPsalm.get(key) ?? []), ...results]);
    }
  }
  const total = summarize(all);
  console.log(`Settings ${settings.filter((s) => !s.duplicate_of).length}, half-verses compared ${total.halves}, skipped ${skipped}`);
  console.log(`Agreement: ${pct(total.agreement)} of half-verses`);
  console.log(`Sure (confidence >= 0.8): ${pct(total.sureShare)} of half-verses, agreeing ${pct(total.sureAgreement)}`);
  const builtin = summarize(all.filter((r) => r.builtin));
  const made = summarize(all.filter((r) => !r.builtin));
  console.log(`  with a built-in tone of the mode: ${builtin.halves} halves, ${pct(builtin.agreement)}`);
  console.log(`  with a tone made to the hand's shape: ${made.halves} halves, ${pct(made.agreement)}`);
  console.log("\nBy psalm (Hebrew numbering) or canticle:");
  const rows = [...byPsalm].sort(([a], [b]) => (Number(a) || 999) - (Number(b) || 999) || a.localeCompare(b));
  for (const [psalm, results] of rows) {
    const s = summarize(results);
    console.log(`  ${psalm.padEnd(20)} ${String(s.halves).padStart(5)} halves  ${pct(s.agreement).padStart(6)}  sure ${pct(s.sureAgreement).padStart(6)}`);
  }
}

if (values.cmudict) {
  // A word is known when the CMU dictionary or neuma's own stress table has it, or (for the
  // archaic endings neuma strips) its stem.
  const known = new Set();
  for (const line of readFileSync(values.cmudict, "utf8").split("\n")) {
    const word = line.split(" ")[0]?.replace(/\(\d+\)$/, "");
    if (word) known.add(word.toLowerCase());
  }
  if (existsSync(values.stress)) {
    for (const line of readFileSync(values.stress, "utf8").split("\n")) if (!line.startsWith("#")) known.add(line.split(" ")[0]);
  }
  const knows = (w) =>
    known.has(w) ||
    ["eth", "est", "edst"].some((suffix) => {
      if (!w.endsWith(suffix)) return false;
      const stem = w.slice(0, -suffix.length);
      const undoubled = stem.length > 2 && stem.at(-1) === stem.at(-2) ? stem.slice(0, -1) : null;
      return [stem, stem + "e", undoubled].some((s) => s && known.has(s));
    });
  const psalter = JSON.parse(readFileSync(new URL("../content/psalter.json", import.meta.url), "utf8"));
  let tokens = 0;
  let unknownTokens = 0;
  const unknown = new Map();
  for (const p of psalter.psalms) {
    for (const verse of p.verses) {
      for (const raw of verse.toLowerCase().split(/[^a-z'-]+/)) {
        for (const w of raw.replace(/^'+|'+$/g, "").split("-")) {
          if (!w) continue;
          tokens++;
          if (!knows(w) && !knows(w.replace(/'s$/, ""))) {
            unknownTokens++;
            unknown.set(w, (unknown.get(w) ?? 0) + 1);
          }
        }
      }
    }
  }
  console.log(`\nCoverdale psalter: ${tokens} words, ${new Set([...unknown.keys()]).size} distinct unknown`);
  console.log(`Unknown-word rate: ${pct(unknownTokens / tokens)} of words (${unknownTokens})`);
  const top = [...unknown].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`Most frequent: ${top.map(([w, n]) => `${w} ${n}`).join(", ")}`);
}

if (!values.corpus && !values.cmudict) {
  console.error("usage: node scripts/pointing-eval.mjs [--corpus settings.jsonl] [--cmudict cmudict.dict]");
  process.exit(2);
}
