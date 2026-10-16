// Pointed psalm text and the edits the pointer page makes to it. The text is neuma's pointed
// text, a verse per line; offsets are UTF-16, as the display's spans give them.
import { point, psalm, psalmDisplay } from "neuma";

export type Half = "mediant" | "termination";

/** A half-verse the automatic pointer was less than sure of: "3:termination". */
export type HalfKey = `${number}:${Half}`;

export const halfKey = (verse: number, part: Half): HalfKey => `${verse}:${part}`;

/** Below this the pointer's choice is worth a look (neuma flags the same halves). */
export const SURE = 0.8;

export const GLORIA = [
  "Glory be to the Father, and to the Son * and to the Holy Ghost.",
  "As it was in the beginning, † is now, and ever shall be * world without end. Amen.",
];

/** Verses as psalm text: numbered from `first`, then the Gloria Patri unnumbered. */
export function psalmText(verses: string[], first: number, gloria: boolean): string {
  const lines = verses.map((v, i) => `${first + i} ${v}`);
  if (gloria) lines.push(...GLORIA);
  return lines.join("\n");
}

/** Points every unmarked half for the tone; returns the text and the halves to check. */
export function pointText(text: string, tone: string): { text: string; unsure: HalfKey[] } {
  const p = point(text, tone);
  const unsure = p.halves.filter((h) => !h.kept && h.confidence < SURE).map((h) => halfKey(h.verse, h.part));
  return { text: p.text.replace(/\n$/, ""), unsure };
}

const ACUTE = "́";
const VOWEL = /[aeiouy]/;
const MARK = /[·–]/;
/** What may stand between a half's syllables and its edges: marks and spaces. */
const EDGE = /[·–  ⁠]/;

/** A character without its acute, and its base letter in lower case. */
const unaccent = (c: string) => c.normalize("NFD").replace(/́/g, "").normalize("NFC");
const base = (c: string) => c.normalize("NFD")[0]!.toLowerCase();

/**
 * Where a syllable's accent goes: its first vowel, as a pointed psalter writes it ("píeces",
 * "trúe"), but not a y or the u of qu that only leads into the vowel ("yé", "quí"), nor an i
 * before a or o ("Sión"), which the syllabifier would split off. -1 for a syllable with no vowel.
 */
export function nucleus(syllable: string): number {
  const chars = [...syllable];
  let offset = 0;
  let fallback = -1;
  for (let i = 0; i < chars.length; i++) {
    const b = base(chars[i]!);
    const next = chars[i + 1] ? base(chars[i + 1]!) : "";
    const prev = i > 0 ? base(chars[i - 1]!) : "";
    if (VOWEL.test(b)) {
      const leads = VOWEL.test(next) && ((b === "y") || (b === "u" && prev === "q") || (b === "i" && /[ao]/.test(next)));
      if (!leads) return offset;
      if (fallback < 0) fallback = offset;
    }
    offset += chars[i]!.length;
  }
  return fallback;
}

/** The accented syllables of one half as the display reads them, accents off. */
function accentedSyllables(text: string, tone: string, verse: number, part: Half): string[] {
  return (psalmDisplay(text, tone).verses[verse]?.runs ?? []).flatMap((r) =>
    r.kind === "syllable" && r.part === part && r.accent ? [[...r.text].map(unaccent).join("")] : [],
  );
}

/** One half's syllables as the display splits them, accents off: "glo|ri|ous". */
function halfSyllables(text: string, tone: string, verse: number, part: Half): string {
  return (psalmDisplay(text, tone).verses[verse]?.runs ?? [])
    .flatMap((r) => (r.kind === "syllable" && r.part === part ? [[...r.text].map(unaccent).join("")] : []))
    .join("|");
}

/**
 * Re-points one half-verse with its accents on the syllables at `accents` (spans of syllables
 * in `text`). The half's old marks go; the acutes go on each syllable's vowel; and the `·`
 * goes where the tone's cadence then starts, as neuma counts it from the accents. Throws when
 * a syllable can't carry the accent.
 */
export function moveAccents(
  text: string,
  tone: string,
  verse: number,
  part: Half,
  accents: Array<{ start: number; end: number }>,
): string {
  const half = point(text, tone).halves.find((h) => h.verse === verse && h.part === part);
  if (!half) throw new Error(`no ${part} in verse ${verse}`);
  const { sourceUtf16Start: start, sourceUtf16End: end } = half;
  const accented = new Set<number>();
  const wanted: string[] = [];
  for (const a of accents) {
    if (a.start < start || a.end > end) throw new Error("accent outside its half");
    const syllable = text.slice(a.start, a.end);
    const at = nucleus(syllable);
    if (at < 0) throw new Error(`“${syllable}” has no vowel to accent`);
    accented.add(a.start + at);
    wanted.push([...syllable].map(unaccent).join(""));
  }
  // The half's own marks can stand outside its syllables ("* – – · mý God"): take them too.
  let from = start;
  while (from > 0 && EDGE.test(text[from - 1]!)) from--;
  let to = end;
  while (to < text.length && EDGE.test(text[to]!)) to++;
  const before = from > 0 && text[from - 1] !== "\n" ? " " : "";
  const after = to < text.length && text[to] !== "\n" ? " " : "";
  const halfStart = from + before.length;
  // An in-word `·` also split a syllable ("hail·stones"): without it the syllabifier may split
  // the word elsewhere, so it can stay as a sung split instead.
  const build = (keepSplits: boolean): string => {
    let out = "";
    const splits = new Set<number>();
    for (let i = start; i < end; i++) {
      const c = text[i]!;
      if (c === "·" && keepSplits && /\p{L}/u.test(text[i - 1] ?? "") && /\p{L}/u.test(text[i + 1] ?? "")) {
        splits.add(halfStart + out.length);
        out += "-";
        continue;
      }
      if (MARK.test(c)) continue;
      if (c === " " && (out === "" || out.endsWith(" "))) continue;
      out += accented.has(i) ? (unaccent(c) + ACUTE).normalize("NFC") : unaccent(c);
    }
    const marked = text.slice(0, from) + before + out.trimEnd() + after + text.slice(to);
    // Where the cadence starts once the accents are placed: its first preparatory or
    // accented note in this half.
    const first = psalm(marked, tone, { autoPoint: false }).notes.find(
      (n) => n.verse === verse && n.part === part && (n.role === "preparatory" || n.role === "accent"),
    );
    if (!first) return marked;
    const at = first.sourceUtf16Start;
    if (splits.has(at - 1)) return marked.slice(0, at - 1) + "·" + marked.slice(at);
    const wordStart = at === halfStart || marked[at - 1] === " ";
    return marked.slice(0, at) + (wordStart ? "· " : "·") + marked.slice(at);
  };
  const was = halfSyllables(text, tone, verse, part);
  const plain = build(false);
  const result = halfSyllables(plain, tone, verse, part) === was ? plain : build(true);
  // An accent can join syllables the syllabifier had apart ("Is·ráel"): refuse rather than
  // put it somewhere else.
  if (accentedSyllables(result, tone, verse, part).join("|") !== wanted.join("|")) {
    throw new Error(`The accent can't go on “${wanted.join("”, “")}” here`);
  }
  return result;
}

