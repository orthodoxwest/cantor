// Pointed psalm text and the edits the pointer page makes to it. The text is neuma's pointed
// text, a verse per line; offsets are UTF-16, as the display's spans give them.
import { point, psalm } from "neuma";

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

const ACUTE = "\u0301";
const VOWEL = /[aeiouy]/i;
const MARK = /[·–]/;

/**
 * Re-points one half-verse with its accents on the syllables starting at `accents` (offsets
 * of syllables in `text`, each with its end). The half's old marks go; the acutes go on each
 * syllable's first vowel; and the `·` goes where the tone's cadence then starts, as neuma
 * counts it from the accents.
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
  for (const a of accents) {
    if (a.start < start || a.end > end) throw new Error("accent outside its half");
    const syllable = text.slice(a.start, a.end);
    const vowel = syllable.normalize("NFD").replace(/\u0301/g, "").search(VOWEL);
    // The syllable's characters are precomposed or plain letters, so an index into the
    // decomposed, acute-free syllable is one into the syllable.
    accented.add(a.start + Math.max(vowel, 0));
  }
  let out = "";
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    if (MARK.test(c)) continue;
    if (c === " " && (out === "" || out.endsWith(" "))) continue;
    const plain = c.normalize("NFD").replace(/\u0301/g, "").normalize("NFC");
    out += accented.has(i) ? (plain + ACUTE).normalize("NFC") : plain;
  }
  out = out.trimEnd();
  const marked = text.slice(0, start) + out + text.slice(end);
  // Where the cadence starts once the accents are placed: its first preparatory or accented
  // note in this half.
  const first = psalm(marked, tone, { autoPoint: false }).notes.find(
    (n) => n.verse === verse && n.part === part && (n.role === "preparatory" || n.role === "accent"),
  );
  if (!first) return marked;
  const at = first.sourceUtf16Start;
  const wordStart = at === start || marked[at - 1] === " ";
  return marked.slice(0, at) + (wordStart ? "· " : "·") + marked.slice(at);
}
