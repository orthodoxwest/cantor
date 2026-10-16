// The take as the singer sees it after singing: under each staff line, a band for each note,
// its target at the centre, and the pitch heard over the note's sustained part. Each band is
// measured in cents from the note itself, as the core's judge placed it in the singer's key,
// so a half step is drawn no smaller than a whole one. The values are the core's (cantor-core
// ribbon.rs); the page only draws them, re-based on a note when the singer taps it. The
// ribbon itself draws no verdict: no zone of what counts as in tune, no colours; the core's
// marks are drawn by marks.ts, on the notes in the engraving.
import type { TimelineNote } from "neuma";
import type { Mark } from "./marks";

/** One note's band, as cantor-core's `Band` serializes. */
export interface Band {
  index: number;
  from_s: number;
  to_s: number;
  cents: number | null;
  trace: Array<[number, number]>;
}

/** A take judged, as the ear's `Judged` serializes: what the page reads of it. */
export interface Judged {
  verdict: { key_cents: number | null; marks: Mark[] };
  ribbon: Band[];
  /** Each mark in words. */
  told: string[];
}

/** The height of the strip under each line, in the score's units (pixels). */
export const STRIP = 76;
/** Cents from a band's centre to its edge; a trace beyond it is drawn at the edge. */
export const RANGE_CENTS = 200;
/** The strip's margin above and below its bands. */
const PAD = 8;
/** The widest a band is drawn either side of its note, for a note alone on its line. */
const LONE = 14;
/** The narrowest a band is drawn, centred on its note (notes stacked in a neume overlap). */
export const MIN_WIDTH = 8;

/** How a band sits on the page: its line, and its left and right edges. */
interface Place {
  line: number;
  left: number;
  right: number;
}

/** Each note's band from the midpoints to its neighbours on the same line. */
export function places(notes: readonly TimelineNote[]): Place[] {
  return notes.map((n, i) => {
    const prev = notes[i - 1];
    const next = notes[i + 1];
    const left = prev && prev.line === n.line ? (prev.cx + n.cx) / 2 : n.cx - LONE;
    const right = next && next.line === n.line ? (n.cx + next.cx) / 2 : n.cx + LONE;
    const place = { line: n.line, left: Math.max(left, n.cx - 2 * LONE), right: Math.min(right, n.cx + 2 * LONE) };
    if (place.right - place.left < MIN_WIDTH) {
      place.left = n.cx - MIN_WIDTH / 2;
      place.right = n.cx + MIN_WIDTH / 2;
    }
    return place;
  });
}

/** The y of `cents` (after re-basing) in a strip whose top is `top`. */
export function yOf(cents: number, top: number): number {
  const half = STRIP / 2 - PAD;
  const clipped = Math.max(-RANGE_CENTS, Math.min(RANGE_CENTS, cents));
  return top + STRIP / 2 - (clipped / RANGE_CENTS) * half;
}

const f = (x: number) => x.toFixed(1);

/** The strips' SVG, each line's at `stripTop(line)`. Every band's centre is its note in the
 * key; the traces are drawn `base` cents lower, a note's own value when the singer re-based on
 * it (so that note's trace sits on its centre), else 0; `baseIndex` is that note. */
export function drawRibbon(
  notes: readonly TimelineNote[],
  bands: readonly Band[],
  stripTop: (line: number) => number,
  base = 0,
  baseIndex: number | null = null,
): string {
  const at = places(notes);
  const out: string[] = [];
  for (const band of bands) {
    const p = at[band.index];
    if (!p) continue;
    const top = stripTop(p.line);
    const w = p.right - p.left;
    const centre = yOf(0, top);
    const heard = band.cents !== null;
    const attrs = heard
      ? `data-band="${band.index}" data-cents="${band.cents!.toFixed(1)}" tabindex="0" role="button" aria-label="Measure from note ${band.index + 1}" aria-pressed="${band.index === baseIndex}"`
      : `data-band="${band.index}" data-cents=""`;
    out.push(`<g class="band${heard ? "" : " unheard"}" ${attrs}>`);
    out.push(`<rect class="band-hit" x="${f(p.left)}" y="${f(top)}" width="${f(w)}" height="${STRIP}"/>`);
    out.push(`<line class="band-target" x1="${f(p.left + 1)}" x2="${f(p.right - 1)}" y1="${f(centre)}" y2="${f(centre)}"/>`);
    if (band.trace.length > 0 && band.to_s > band.from_s) {
      const inner = Math.max(w - 4, 0);
      const x = (t: number) => p.left + (w - inner) / 2 + ((t - band.from_s) / (band.to_s - band.from_s)) * inner;
      const points = band.trace.map(([t, c]) => `${f(x(t))},${f(yOf(c - base, top))}`).join(" ");
      out.push(`<polyline class="band-trace" points="${points}"/>`);
    }
    out.push("</g>");
  }
  return out.join("");
}

/** The singer's key as a transposition from the page: "3 semitones down, 3 cents flat". */
export function describeKey(cents: number): string {
  const semis = Math.round(cents / 100);
  const rest = Math.round(cents - semis * 100);
  const steps =
    semis === 0 ? "as written" : `${Math.abs(semis)} semitone${Math.abs(semis) === 1 ? "" : "s"} ${semis > 0 ? "up" : "down"}`;
  if (rest === 0) return steps;
  return `${steps}, ${Math.abs(rest)} cent${Math.abs(rest) === 1 ? "" : "s"} ${rest > 0 ? "sharp" : "flat"}`;
}
