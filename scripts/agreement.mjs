// How often the automatic pointer agrees with a hand-pointed psalter, half-verse by half-verse.
// Each hand-pointed half is pointed again from its plain text for a tone of the same shape (as
// many accents, as many preparatory syllables), with the hand's own syllable splits, and agrees
// when its accents fall on the same syllables.
import { point, psalmDisplay } from "../vendor/neuma/neuma.mjs";

const ACUTE = /́/;

/** Letters only, lower case, accents off: positions in it identify a syllable's vowel. */
function letters(text) {
  let out = "";
  const accents = [];
  for (const c of text.normalize("NFD")) {
    if (ACUTE.test(c)) accents.push(out.length - 1);
    else if (/\p{L}/u.test(c)) out += c.toLowerCase();
  }
  return { letters: out, accents };
}

/** A hand-pointed verse as plain text: the marks off, an in-word `·` kept as a sung split. */
export function plain(verse) {
  return verse
    .normalize("NFD")
    .replace(/́/g, "")
    .normalize("NFC")
    .replace(/(\p{L})·(\p{L})/gu, "$1-$2")
    .replace(/\s*[·–]\s*/g, " ")
    .replace(/ +/g, " ")
    .replace(/ ([*†])/g, " $1")
    .trim();
}

/** A tone with this shape for each half, `[accents, preparatory]`, its accents on the tenor's level. */
export function toneOfShape(mediant, termination) {
  const cadence = ([accents, prep]) =>
    accents === 1 ? `hr ${"h ".repeat(prep)}'i hr h` : `hr ${"h ".repeat(prep)}'i hr 'g hr h`;
  return `name: shape\nclef: c4\nmediant: ${cadence(mediant)}\ntermination: ${cadence(termination)}\n`;
}

/** The shape of a cadence formula, or null when a free neume comes between its preparatory notes and its accent. */
function formulaShape(formula) {
  const neumes = formula.trim().split(/\s+/);
  const tenor = neumes.findIndex((n) => n.endsWith("r"));
  const after = neumes.slice(tenor + 1);
  const first = after.findIndex((n) => n.startsWith("'"));
  if (first < 0 || after.slice(0, first).some((n) => n.endsWith("r"))) return null;
  return [after.filter((n) => n.startsWith("'")).length, first];
}

/** The built-in tones' cadence shapes, from a tone file: `{ name, mode, mediant, termination }`. */
export function toneShapes(toneFile) {
  return toneFile
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(block.split("\n").map((l) => l.split(/:\s*/, 2)).filter((kv) => kv.length === 2)))
    .filter((t) => t.name && t.mediant && t.termination)
    .map((t) => ({
      name: t.name,
      mode: t.name.split(".")[0],
      mediant: formulaShape(t.mediant),
      termination: formulaShape(t.termination),
    }));
}

const same = (a, b) => !a || (b && a[0] === b[0] && a[1] === b[1]);

/** The tone to point a verse with: a built-in tone of its mode whose cadences have the hand's shapes, else one made to them. */
export function toneFor(shape, mode, builtins) {
  const fits = (t) => same(shape.mediant, t.mediant) && same(shape.termination, t.termination);
  const builtin = builtins.find((t) => t.mode === mode && fits(t));
  if (builtin) return { tone: builtin.name, builtin: true };
  return { tone: toneOfShape(shape.mediant ?? [1, 2], shape.termination ?? [1, 2]), builtin: false };
}

/**
 * The shape of each half of a hand-pointed verse, or null for one that can't be compared:
 * no accent, more than two, a held `–`, or no `·`.
 */
export function shapes(verse) {
  const runs = psalmDisplay(verse, "8.G").verses[0]?.runs ?? [];
  const half = () => ({ point: false, prep: 0, accents: 0, held: false });
  const state = { mediant: half(), termination: half() };
  let pendingPoint = false;
  let pendingHeld = false;
  let last = null;
  for (const r of runs) {
    if (r.kind === "point") pendingPoint = true;
    if (r.kind === "held") {
      pendingHeld = true;
      if (last) last.held = true;
    }
    if (r.kind !== "syllable") continue;
    const h = state[r.part];
    if (!h) {
      pendingPoint = pendingHeld = false;
      continue;
    }
    if (pendingHeld) h.held = true;
    if (pendingPoint) h.point = true;
    pendingPoint = pendingHeld = false;
    last = h;
    if (r.accent) h.accents++;
    else if (h.point && h.accents === 0) h.prep++;
  }
  const shape = (h) => (!h.held && h.point && h.accents >= 1 && h.accents <= 2 ? [h.accents, h.prep] : null);
  return { mediant: shape(state.mediant), termination: shape(state.termination) };
}

/** Accent positions of each half, as letter offsets. */
function accentsByHalf(verse) {
  const [first, second = ""] = verse.split("*");
  const a = letters(first);
  const b = letters(second);
  return { mediant: a.accents.join(","), termination: b.accents.map((i) => i + a.letters.length).join(",") };
}

/**
 * Compares the pointer with one hand-pointed verse (no verse number), sung in `mode` ("8").
 * Returns a result per comparable half: `{ part, agree, confidence, builtin }`.
 */
export function compareVerse(hand, mode = "", builtins = []) {
  const shape = shapes(hand);
  if (!shape.mediant && !shape.termination) return [];
  const { tone, builtin } = toneFor(shape, mode, builtins);
  const p = point(plain(hand), tone);
  const ours = accentsByHalf(p.text.trim());
  const theirs = accentsByHalf(hand);
  const results = [];
  for (const part of ["mediant", "termination"]) {
    if (!shape[part]) continue;
    const half = p.halves.find((h) => h.part === part);
    results.push({ part, agree: ours[part] === theirs[part], confidence: half?.confidence ?? 0, builtin });
  }
  return results;
}

/** Totals over many results: all halves, and those the pointer is sure of. */
export function summarize(results, sure = 0.8) {
  const n = results.length;
  const agree = results.filter((r) => r.agree).length;
  const confident = results.filter((r) => r.confidence >= sure);
  const confidentAgree = confident.filter((r) => r.agree).length;
  return {
    halves: n,
    agreement: n ? agree / n : 0,
    sureShare: n ? confident.length / n : 0,
    sureAgreement: confident.length ? confidentAgree / confident.length : 0,
  };
}
