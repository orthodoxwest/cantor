// The take as the singer sees it after singing: under each staff line, a band for each note,
// its target at the centre, and the pitch heard over the whole note. Each band is measured in
// cents from the note itself, as the core's judge placed it in the singer's key, so a half step
// is drawn no smaller than a whole one. The values are the core's (cantor-core ribbon.rs); the
// page only draws them, re-based on a note only where a caller asks. Each heard note's value,
// the pitch it was held at, is drawn as a short bar over the part of its band it was read from,
// the note's sustained part, over the faint trace, so the take reads at a glance as steps
// against the targets, which reach past the bars' ends, and a slide into a note or away from it
// shows beside the bar. Where the chant has an aligned recording, its trace is drawn
// under the singer's, each measured from its own key, so the two compare as sung, wherever each
// was pitched; the singer's take of it before this one, kept on the device (kept.ts), is drawn
// faintly under theirs, its bars and trace alike. The ribbon itself draws no verdict: no zone
// of what counts as in tune, no colours; the core's marks are drawn by marks.ts, on the notes
// in the engraving.
import type { TimelineNote } from "neuma";
import type { Mark } from "./marks";

/** One note's band, as cantor-core's `Band` serializes: its sustained part, where its value was
 * read, and the whole note, where its trace lies; a take sent, or a recording seeded, before the
 * trace was drawn over the whole note has only the sustained part, which its trace lies over. */
export interface Band {
  index: number;
  from_s: number;
  to_s: number;
  start_s?: number;
  end_s?: number;
  cents: number | null;
  trace: Array<[number, number]>;
}

/** Whether `band` has the whole note's times, as the core's bands do since they were drawn over
 * it; one sent or seeded before has its sustained part only. */
function whole(band: Band): band is Band & { start_s: number; end_s: number } {
  return band.start_s !== undefined && band.end_s !== undefined;
}

/** The seconds a band's trace is drawn across: the whole note, or for a band without it the
 * sustained part. */
export function span(band: Band): [number, number] {
  return whole(band) ? [band.start_s, band.end_s] : [band.from_s, band.to_s];
}

/** A take judged, as the ear's `Judged` serializes: what the page reads of it. */
export interface Judged {
  /** The notes as judged, each where it was due in the take, in seconds; from the ear only (a
   * sent take keeps none), as many as were judged. */
  notes?: Array<{ start_s: number; dur_s: number }>;
  /** The outcome and the report come from the ear only; a sent take keeps neither. */
  verdict: { outcome?: "heard" | "not-heard" | "masked"; key_cents: number | null; marks: Mark[] };
  /** The notes as scored: a note with no cents was not heard. */
  report?: { notes: Array<{ cents: number | null }> };
  ribbon: Band[];
  /** Each mark in words. */
  told: string[];
  /** The take as a whole in two sentences, or none when it was not heard. */
  summary: string[];
  /** The phrase endings the second sentence tells of as off pitch, each over notes `first` to
   * `last`, with its note furthest off, the mark on its notes that tells of it already if one
   * does, and in words; from the ear only. */
  endings?: Array<{ first: number; last: number; note: number; mark: number | null; words: string }>;
  /** A psalm sung to a tone, verse by verse, as the core lays it out; none for another chant, or
   * a take not heard; from the ear only. */
  grid?: Grid | null;
}

/** A part of a psalm tone, as cantor-core's `Part` serializes. */
export type Part = "whole" | "flex" | "mediant" | "termination";

/** One part of one verse, as cantor-core's grid `Cell` serializes: its notes `first` to `last`,
 * its ending's notes as the judge placed them, how the judge called it and in words, and the note
 * of its ending furthest off and how far in cents, when called. `was`, drawn only, is the take's
 * cell where a run sung again called it anew (grid.ts `gridWith`). */
export interface GridCell {
  part: Part;
  first: number;
  last: number;
  called: "on-pitch" | "off-pitch" | "unclear" | "unsung" | "recited";
  ending: [number, number] | null;
  note: number | null;
  cents: number | null;
  words: string;
  was?: GridCell;
}

/** One psalm verse, as cantor-core's grid `Row` serializes: the chant's verse, its place among
 * the psalm's verses from 1, its notes, and a cell for each column (none where it has no such
 * part). */
export interface GridRow {
  verse: number;
  number: number;
  first: number;
  last: number;
  cells: Array<GridCell | null>;
}

/** A psalm verse by verse, as cantor-core's `Grid` serializes: its parts, named, and its verses
 * judged. */
export interface Grid {
  columns: Array<{ part: Part; name: string }>;
  rows: GridRow[];
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
/** The shortest a held bar is drawn, where the band leaves room for it. */
const HELD = 4;

/** How a band sits on the page: its line, and its left and right edges. */
export interface Place {
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

/** The margin either side of a band that its trace is drawn within. */
const MARGIN = 2;

/** Where `t` seconds of the take falls across the band `band` placed at `p`, as its trace is
 * drawn: its seconds across its width, but for a margin either side; at an end before or after
 * them. */
export function across(p: Place, band: Band, t: number): number {
  const w = p.right - p.left;
  const inner = Math.max(w - 2 * MARGIN, 0);
  const [from, to] = span(band);
  const at = to > from ? Math.min(Math.max((t - from) / (to - from), 0), 1) : 0;
  return p.left + (w - inner) / 2 + at * inner;
}

/** The second of the take at `x` across the band `band` placed at `p`: [`across`] undone. */
export function secondAt(p: Place, band: Band, x: number): number {
  const w = p.right - p.left;
  const inner = Math.max(w - 2 * MARGIN, 0);
  const [from, to] = span(band);
  const at = inner > 0 ? Math.min(Math.max((x - p.left - (w - inner) / 2) / inner, 0), 1) : 0;
  return from + at * (to - from);
}

/** The y of `cents` (after re-basing) in a strip whose top is `top`. */
export function yOf(cents: number, top: number): number {
  const half = STRIP / 2 - PAD;
  const clipped = Math.max(-RANGE_CENTS, Math.min(RANGE_CENTS, cents));
  return top + STRIP / 2 - (clipped / RANGE_CENTS) * half;
}

const f = (x: number) => x.toFixed(1);

/** The strips' SVG, each line's at `stripTop(line)`. Every band's centre is its note in the
 * key; the traces are drawn `base` cents lower, a note's own value when re-based on it (so that
 * note's trace sits on its centre), else 0; `baseIndex` is that note, the one pressed, or a run
 * of notes pressed together. A heard band is a button to re-base on it; given `choose`, every
 * band is a button named by it instead, the first pressed (else the first band) the one tab
 * stop among them. Given `recorded`, the bands of a recording of the same notes, each note's
 * recorded trace is drawn under the singer's, re-based on the same note; given `before`, the
 * singer's take before this one of the same notes, its trace and held bars are drawn faintly
 * under them, re-based alike. */
export function drawRibbon(
  notes: readonly TimelineNote[],
  bands: readonly Band[],
  stripTop: (line: number) => number,
  base = 0,
  baseIndex: number | readonly [number, number] | null = null,
  choose?: (index: number) => string,
  recorded: readonly Band[] = [],
  before: readonly Band[] = [],
): string {
  const at = places(notes);
  // Re-based on a note the recording has no value for, the recording has no base to be drawn
  // from, so it is not drawn.
  const recordedBase = typeof baseIndex === "number" ? (recorded.find((b) => b.index === baseIndex)?.cents ?? null) : 0;
  const [first, last] = baseIndex === null ? [null, null] : typeof baseIndex === "number" ? [baseIndex, baseIndex] : baseIndex;
  // Choosing among every note, only one band is a tab stop; the arrows move along.
  // The first band pressed, or the first drawn when none is (a run chosen past a take stopped).
  const inRun = (index: number) => first !== null && last !== null && index >= first && index <= last;
  const stop = bands.find((b) => inRun(b.index))?.index ?? bands[0]?.index;
  const sung = new Map(recordedBase === null ? [] : recorded.map((b) => [b.index, b]));
  const beforeBase = typeof baseIndex === "number" ? (before.find((b) => b.index === baseIndex)?.cents ?? null) : 0;
  const was = new Map(beforeBase === null ? [] : before.map((b) => [b.index, b]));
  const out: string[] = [];
  for (const band of bands) {
    const p = at[band.index];
    if (!p) continue;
    const top = stripTop(p.line);
    const w = p.right - p.left;
    const centre = yOf(0, top);
    const heard = band.cents !== null;
    const cents = heard ? band.cents!.toFixed(1) : "";
    const label = choose ? choose(band.index) : heard ? `Measure from note ${band.index + 1}` : null;
    const tab = choose && band.index !== stop ? "-1" : "0";
    const pressed = inRun(band.index);
    const attrs =
      label === null
        ? `data-band="${band.index}" data-cents=""`
        : `data-band="${band.index}" data-cents="${cents}" tabindex="${tab}" role="button" aria-label="${label}" aria-pressed="${pressed}"`;
    out.push(`<g class="band${heard ? "" : " unheard"}" ${attrs}>`);
    out.push(`<rect class="band-hit" x="${f(p.left)}" y="${f(top)}" width="${f(w)}" height="${STRIP}"/>`);
    out.push(`<line class="band-target" x1="${f(p.left + 1)}" x2="${f(p.right - 1)}" y1="${f(centre)}" y2="${f(centre)}"/>`);
    const xOf = (b: Band): ((t: number) => number) | null => {
      const [from, to] = span(b);
      if (!(to > from)) return null;
      // A recording's band with only its sustained part, under the singer's with the whole note,
      // is drawn over the part the singer's value was read from, so that the two keep one time.
      if (b !== band && !whole(b) && whole(band)) {
        const own = xOf(band);
        if (!own) return null;
        const [x1, x2] = [own(band.from_s), own(band.to_s)];
        return (t) => x1 + ((t - from) / (to - from)) * (x2 - x1);
      }
      return (t) => across(p, b, t);
    };
    const trace = (b: Band | undefined, by: number, cls: string) => {
      const x = b && b.trace.length > 0 ? xOf(b) : null;
      if (!b || !x) return;
      const points = b.trace.map(([t, c]) => `${f(x(t))},${f(yOf(c - by, top))}`).join(" ");
      out.push(`<polyline class="${cls}" points="${points}"/>`);
    };
    const held = (b: Band | undefined, by: number, cls: string) => {
      if (!b || b.cents === null) return;
      const y = f(yOf(b.cents - by, top));
      // Over the part it was read from, inset within the target, so that the target shows either
      // side even under a note on pitch, and neighbours' bars do not meet, save where a neume's
      // narrow bands overlap.
      const inset = Math.min(4, w / 4);
      const [lo, hi] = [p.left + inset, p.right - inset];
      const x = xOf(b);
      let [x1, x2] = x ? [Math.max(lo, x(b.from_s)), Math.min(hi, x(b.to_s))] : [lo, hi];
      // No shorter than a dot in a neume's narrow band.
      const least = Math.min(HELD, hi - lo);
      if (x2 - x1 < least) {
        const mid = Math.min(Math.max((x1 + x2) / 2, lo + least / 2), hi - least / 2);
        [x1, x2] = [mid - least / 2, mid + least / 2];
      }
      out.push(`<line class="${cls}" x1="${f(x1)}" x2="${f(x2)}" y1="${y}" y2="${y}"/>`);
    };
    trace(sung.get(band.index), recordedBase ?? 0, "band-recorded");
    trace(was.get(band.index), beforeBase ?? 0, "band-before");
    held(was.get(band.index), beforeBase ?? 0, "band-before-held");
    trace(band, base, "band-trace");
    held(band, base, "band-held");
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
