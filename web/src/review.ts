// Finding one's way about a take shown: the places the core tells of (its marks, and the phrase
// endings it heard off pitch) in the order sung, stepped through one at a time from the bar, and
// gathered by the run of phrases each is in (loop.ts) for the list under the score. The page
// orders and gathers them; it ranks none and adds none.
import type { Pause } from "neuma";
import { phraseOf } from "./loop";

type Pauses = readonly Pick<Pause, "beforeNote" | "kind">[];
/** A place the core tells of, over the notes `first` to `last`. */
type Spot = { readonly first: number; readonly last: number };

/** The places' indexes in the order sung: by first note, then as given. */
export function sungOrder(marks: readonly Spot[]): number[] {
  return marks
    .map((m, k) => ({ m, k }))
    .sort((a, b) => a.m.first - b.m.first || a.k - b.k)
    .map(({ k }) => k);
}

/** The run of phrases a place is in: from the start of its first note's phrase to the end of its
 * last's. */
export function runOf(mark: Spot, pauses: Pauses, count: number): [number, number] {
  const [a] = phraseOf(mark.first, pauses, count);
  const [, b] = phraseOf(mark.last, pauses, count);
  return [a, b];
}

/** The place a step `by` goes to in the order sung: the next or last from the one open; else,
 * from the run chosen, the first at or after its start or the last before it; else the first or
 * the last of all. Null past either end. */
export function stepTo(marks: readonly Spot[], open: number | null, run: readonly [number, number] | null, by: 1 | -1): number | null {
  const order = sungOrder(marks);
  const at = open === null ? -1 : order.indexOf(open);
  if (at >= 0) return order[at + by] ?? null;
  if (!run) return (by === 1 ? order[0] : order.at(-1)) ?? null;
  const after = order.findIndex((k) => marks[k]!.first >= run[0]);
  if (by === 1) return after < 0 ? null : order[after]!;
  return (after < 0 ? order.at(-1) : order[after - 1]) ?? null;
}

/** A run of phrases and the places in it, in the order sung. */
export interface Place {
  run: [number, number];
  marks: number[];
}

/** The places gathered by the run of phrases each is in, the runs in the order their first place
 * is sung. */
export function byPhrase(marks: readonly Spot[], pauses: Pauses, count: number): Place[] {
  const places = new Map<string, Place>();
  for (const k of sungOrder(marks)) {
    const run = runOf(marks[k]!, pauses, count);
    const key = run.join("-");
    const place = places.get(key);
    if (place) place.marks.push(k);
    else places.set(key, { run, marks: [k] });
  }
  return [...places.values()];
}

/** Intervals by their size in semitones, as a singer names them. */
const INTERVALS = [
  "",
  "a semitone",
  "a whole tone",
  "a minor third",
  "a major third",
  "a fourth",
  "a tritone",
  "a fifth",
  "a minor sixth",
  "a major sixth",
  "a minor seventh",
  "a major seventh",
  "an octave",
];

/** How a note is written from the one before it, `semitones` higher (lower when negative), as
 * the score has it: "a whole tone above the note before". */
export function writtenStep(semitones: number): string {
  if (semitones === 0) return "on the same pitch as the note before";
  const n = Math.abs(semitones);
  return `${INTERVALS[n] ?? "more than an octave"} ${semitones > 0 ? "above" : "below"} the note before`;
}
