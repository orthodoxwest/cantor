// The take as the singer sees it after singing: under each staff line, a band for each note,
// its target at the centre, and the pitch heard over the note's sustained part. Each band is
// measured in cents from the note itself, as the core's judge placed it in the singer's key,
// so a half step is drawn no smaller than a whole one. The values are the core's (cantor-core
// ribbon.rs); the page only draws them, re-based on a note only where a caller asks. Each heard
// note's value, the pitch it was held at, is drawn as a short bar across its band, over the
// faint trace it was taken from, so the take reads at a glance as steps against the targets,
// which reach past the bars' ends. Where the chant has an aligned recording, its trace is drawn
// under the singer's, each measured from its own key, so the two compare as sung, wherever each
// was pitched. The ribbon itself draws no
// verdict: no zone of what counts as in tune, no colours; the core's marks are drawn by
// marks.ts, on the notes in the engraving.
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
   * `last`, with its note furthest off, the mark over that note that tells of it already if one
   * is, and in words; from the ear only. */
  endings?: Array<{ first: number; last: number; note: number; mark: number | null; words: string }>;
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
 * key; the traces are drawn `base` cents lower, a note's own value when re-based on it (so that
 * note's trace sits on its centre), else 0; `baseIndex` is that note, the one pressed, or a run
 * of notes pressed together. A heard band is a button to re-base on it; given `choose`, every
 * band is a button named by it instead, the first pressed (else the first band) the one tab
 * stop among them. Given `recorded`, the bands of a recording of the same notes, each note's
 * recorded trace is drawn under the singer's, re-based on the same note. */
export function drawRibbon(
  notes: readonly TimelineNote[],
  bands: readonly Band[],
  stripTop: (line: number) => number,
  base = 0,
  baseIndex: number | readonly [number, number] | null = null,
  choose?: (index: number) => string,
  recorded: readonly Band[] = [],
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
    const trace = (b: Band | undefined, by: number, cls: string) => {
      if (!b || b.trace.length === 0 || b.to_s <= b.from_s) return;
      const inner = Math.max(w - 4, 0);
      const x = (t: number) => p.left + (w - inner) / 2 + ((t - b.from_s) / (b.to_s - b.from_s)) * inner;
      const points = b.trace.map(([t, c]) => `${f(x(t))},${f(yOf(c - by, top))}`).join(" ");
      out.push(`<polyline class="${cls}" points="${points}"/>`);
    };
    trace(sung.get(band.index), recordedBase ?? 0, "band-recorded");
    trace(band, base, "band-trace");
    if (heard) {
      const y = f(yOf(band.cents! - base, top));
      // Inset within the target, so that it shows either side even under a note on pitch, and
      // neighbours' bars do not meet, save where a neume's narrow bands overlap.
      const inset = Math.min(4, w / 4);
      out.push(`<line class="band-held" x1="${f(p.left + inset)}" x2="${f(p.right - inset)}" y1="${y}" y2="${y}"/>`);
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
