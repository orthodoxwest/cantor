// A run of the chant to play over and over: a phrase between divisions, or several in a row.
import type { Pause } from "neuma";

/** The divisions a loop snaps to: those that end a half-verse or a verse, not a breath. */
const ENDS = new Set<Pause["kind"]>(["half", "full", "dotted-full", "double", "dominican", "mediant"]);

/** The first and last note, by index, of the phrase holding note `i` of `count`: from the
 * division before it to the one after. */
export function phraseOf(i: number, pauses: readonly Pick<Pause, "beforeNote" | "kind">[], count: number): [number, number] {
  let from = 0;
  let to = count - 1;
  for (const p of pauses) {
    if (!ENDS.has(p.kind)) continue;
    if (p.beforeNote <= i) from = Math.max(from, p.beforeNote);
    else to = Math.min(to, p.beforeNote - 1);
  }
  return [from, to];
}

/** The loop after a tap on note `i`: its phrase when there is no loop; none when it falls in
 * the loop; else the loop stretched to take in its phrase. */
export function tapLoop(
  loop: readonly [number, number] | null,
  i: number,
  pauses: readonly Pick<Pause, "beforeNote" | "kind">[],
  count: number,
): [number, number] | null {
  const [a, b] = phraseOf(i, pauses, count);
  if (!loop) return [a, b];
  if (i >= loop[0] && i <= loop[1]) return null;
  return [Math.min(loop[0], a), Math.max(loop[1], b)];
}
