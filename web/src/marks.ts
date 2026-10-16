// The core's marks, drawn on exactly the notes the judge marked and nowhere else: a ring
// round each marked note in the engraving, one button per mark, whose words (cantor-core
// tell.rs) the page shows when it is tapped. The page adds no marks of its own.
import type { TimelineNote } from "neuma";

/** One of the judge's marks, as cantor-core's `Mark` serializes. */
export interface Mark {
  kind: "note" | "verse" | "verse-missing";
  first: number;
  last: number;
  cents: number | null;
}

/** How far a ring stands off its notehead. */
const RING_GAP = 4;
/** The radius a ring answers a tap within, wider than it is drawn. */
const HIT = 12;

const f = (x: number) => x.toFixed(1);

/** The notes `mark` covers. */
export const covered = (mark: Mark): number[] => Array.from({ length: mark.last - mark.first + 1 }, (_, k) => mark.first + k);

/** The marks' SVG over the engraving, each line's notes moved down by `shift(line)`;
 * `open` is the mark whose words are shown (in the element `words` names). */
export function drawMarks(
  notes: readonly TimelineNote[],
  marks: readonly Mark[],
  shift: (line: number) => number,
  open: number | null,
  words = "why",
): string {
  const out: string[] = [];
  marks.forEach((mark, k) => {
    const rings = covered(mark).flatMap((i) => {
      const n = notes[i];
      if (!n) return [];
      const r = Math.max(n.w, n.h) / 2 + RING_GAP;
      const [cx, cy] = [f(n.cx), f(n.cy + shift(n.line))];
      return [
        `<circle class="mark-hit" cx="${cx}" cy="${cy}" r="${HIT}"/><circle class="mark-ring" data-ring="${i}" cx="${cx}" cy="${cy}" r="${f(r)}"/>`,
      ];
    });
    if (rings.length === 0) return;
    const label = mark.first === mark.last ? `Why note ${mark.first + 1} is marked` : `Why notes ${mark.first + 1} to ${mark.last + 1} are marked`;
    out.push(
      `<g class="mark" data-mark="${k}" tabindex="0" role="button" aria-label="${label}" aria-controls="${words}" aria-expanded="${k === open}">${rings.join("")}</g>`,
    );
  });
  return `<g class="marks">${out.join("")}</g>`;
}
