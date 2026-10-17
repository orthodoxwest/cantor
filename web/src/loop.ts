// A run of the chant to play over and over: a phrase between divisions, or several in a row, or
// less of one: the span between breaths, or a neume of a melisma.
import type { Pause, TimelineNote } from "neuma";

type Pauses = readonly Pick<Pause, "beforeNote" | "kind">[];

/** The divisions a loop snaps to: those that end a half-verse or a verse, not a breath. */
const ENDS = new Set<Pause["kind"]>(["half", "full", "dotted-full", "double", "dominican", "mediant"]);

/** The first and last note, by index, of the phrase holding note `i` of `count`: from the
 * division before it to the one after. */
export function phraseOf(i: number, pauses: Pauses, count: number): [number, number] {
  return between(i, pauses.filter((p) => ENDS.has(p.kind)), count);
}

/** The first and last note of the span holding note `i` between any divisions, breaths too. */
export function spanOf(i: number, pauses: Pauses, count: number): [number, number] {
  return between(i, pauses, count);
}

function between(i: number, pauses: Pauses, count: number): [number, number] {
  let from = 0;
  let to = count - 1;
  for (const p of pauses) {
    if (p.beforeNote <= i) from = Math.max(from, p.beforeNote);
    else to = Math.min(to, p.beforeNote - 1);
  }
  return [from, to];
}

type Run = readonly [number, number];

/** Each note's neume in a melisma, as its first and last note by index: the notes of a syllable
 * written together in `source`, not apart by a space, a slash or a division (of `pauses`); null
 * for a note of a syllable written as one neume. A group with no words of its own straight after
 * another's notes is the same syllable's melisma written on. */
export function melismaNeumes(
  notes: readonly Pick<TimelineNote, "syllable" | "syllableText" | "sourceUtf16Start" | "sourceUtf16End">[],
  source: string,
  pauses: Pauses = [],
): (Run | null)[] {
  const divided = new Set(pauses.map((p) => p.beforeNote));
  // The syllable each note is sung on.
  const sung: number[] = [];
  const neumes: [number, number][] = [];
  notes.forEach((n, i) => {
    const before = notes[i - 1];
    const on = before && !divided.has(i);
    sung[i] = on && n.syllable !== before.syllable && !n.syllableText.trim() ? sung[i - 1]! : n.syllable;
    const joined = on && before.syllable === n.syllable && !/[\s/]/.test(source.slice(before.sourceUtf16End, n.sourceUtf16Start));
    if (joined) neumes.at(-1)![1] = i;
    else neumes.push([i, i]);
  });
  const of: (Run | null)[] = notes.map(() => null);
  neumes.forEach(([first, last], k) => {
    const syllable = sung[first];
    const shared = [neumes[k - 1], neumes[k + 1]].some((m) => m && sung[m[0]] === syllable);
    if (shared) for (let i = first; i <= last; i++) of[i] = neumes[k]!;
  });
  return of;
}

/** The loop after a tap on note `i`: its phrase when there is no loop; outside the loop, the loop
 * stretched to take in what holds the note, as fine as the loop is: its neume (or the note alone)
 * for a loop less than a span between breaths, its span for one less than a phrase, else its
 * phrase; inside it, the loop narrowed a step at a time to the phrase, the span between breaths
 * and the neume (of `neumes`, a melisma's) holding the note, and none once it is no wider than
 * these. */
export function tapLoop(loop: Run | null, i: number, pauses: Pauses, count: number, neumes: readonly (Run | null)[] = []): [number, number] | null {
  const [a, b] = phraseOf(i, pauses, count);
  if (!loop) return [a, b];
  if (i < loop[0] || i > loop[1]) {
    const less = (run: Run) => loop[0] >= run[0] && loop[1] <= run[1] && loop[1] - loop[0] < run[1] - run[0];
    const unit = less(spanOf(loop[0], pauses, count)) ? (neumes[i] ?? [i, i]) : less(phraseOf(loop[0], pauses, count)) ? spanOf(i, pauses, count) : [a, b];
    return [Math.min(loop[0], unit[0]), Math.max(loop[1], unit[1])];
  }
  for (const run of [[a, b] as const, spanOf(i, pauses, count), neumes[i] ?? null]) {
    if (run && run[0] >= loop[0] && run[1] <= loop[1] && run[1] - run[0] < loop[1] - loop[0]) return [run[0], run[1]];
  }
  return null;
}
