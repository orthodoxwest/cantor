// The engraved chant in its host, laid out again whenever the host's width changes. After a
// take, a strip opens under each staff line for the ribbon (ribbon.ts).
import type { Chant, LineBox, LinesPage, Timeline, View } from "neuma";
import { STRIP } from "./ribbon";

/** Where things go once the strips are open: each line's strip, and how far each line's
 * engraving moved down to make room for the strips over it. */
export interface Room {
  stripTop(line: number): number;
  shift(line: number): number;
}

/** Draws the ribbon's strips, and anything over the engraving, given the room made. */
export type Strips = (timeline: Timeline, room: Room) => string;

/** The room above the first line while the strips are open, for a ring round a note at
 * its top. */
const HEADROOM = 8;

/** Pixels per staff space for a score read at the desk, larger than neuma's 6. */
export const SCALE = 8;

export class Score {
  private view: View<LinesPage>;
  private page: LinesPage;
  timeline: Timeline;
  private strips: Strips | null = null;

  /** `scale` is pixels per staff space (neuma's default is 6). */
  constructor(
    readonly host: HTMLElement,
    private chant: Chant,
    private readonly scale?: number,
  ) {
    this.view = chant.view({ svg: "lines", scale });
    this.page = this.view.layout(host.clientWidth);
    this.timeline = this.page.timeline();
    this.render();
    new ResizeObserver(() => this.relayout()).observe(host);
  }

  /** The GABC shown. */
  get source(): string {
    return this.chant.source;
  }

  /** Shows another chant. */
  setChant(chant: Chant): void {
    this.view.free();
    this.chant.free();
    this.chant = chant;
    this.view = chant.view({ svg: "lines", scale: this.scale });
    this.strips = null;
    this.page = this.view.layout(this.host.clientWidth);
    this.timeline = this.page.timeline();
    this.render();
  }

  /** Lays out at the host's width; nothing changes when the width is the same. */
  relayout(): void {
    const page = this.view.layout(this.host.clientWidth);
    if (page === this.page) return;
    this.page = page;
    this.timeline = page.timeline();
    this.render();
  }

  /** Opens a strip under each line drawn by `strips`, or closes them. */
  showStrips(strips: Strips | null): void {
    this.strips = strips;
    this.render();
  }

  /** How far line `i` is drawn below where the page laid it out: the room above the first
   * line and the strips over it. */
  private shift(i: number): number {
    return this.strips ? HEADROOM + i * STRIP : 0;
  }

  /** Line `i`'s box as drawn, below the strips over it. */
  line(i: number): LineBox {
    const box = this.timeline.lines[i]!;
    const shift = this.shift(i);
    return { top: box.top + shift, bottom: box.bottom + shift, staff: box.staff + shift, baseline: box.baseline + shift };
  }

  /** Where line `i`'s strip starts: under the line, and under the page's foot (an initial's
   * descent) for the last. */
  private stripTop(i: number): number {
    const bottom = this.line(i).bottom;
    return i === this.timeline.lines.length - 1 ? Math.max(bottom, this.page.height + this.shift(i)) : bottom;
  }

  private render(): void {
    const { head, defs, rest, lines } = this.page.svgParts;
    const gap = this.strips ? STRIP : 0;
    const height = this.page.height + gap * lines.length + (this.strips ? HEADROOM : 0);
    let top = head
      .replace(/ height="[\d.]+"/, ` height="${height.toFixed(2)}"`)
      .replace(/viewBox="([\d.]+) ([\d.]+) ([\d.]+) [\d.]+"/, `viewBox="$1 $2 $3 ${height.toFixed(2)}"`);
    const engraving = [
      this.strips ? `<g transform="translate(0 ${HEADROOM})">${rest}</g>` : rest,
      ...lines.map((l, i) => `<g transform="translate(0 ${(l.top + this.shift(i)).toFixed(2)})">${l.svg}</g>`),
    ].join("");
    let body = engraving;
    if (this.strips) {
      // An image's children are hidden from assistive technology, so with the ribbon's
      // buttons beside it the engraving alone is the image.
      const label = / aria-label="([^"]*)"/.exec(top)?.[1] ?? "";
      top = top.replace(/ role="img"/, "").replace(/ aria-label="[^"]*"/, "");
      body = `<g role="img" aria-label="${label}">${engraving}</g><g class="ribbon">${this.strips(this.timeline, { stripTop: (i) => this.stripTop(i), shift: (i) => this.shift(i) })}</g>`;
    }
    const svg = `${top}<defs>${defs}</defs>${body}</svg>`;
    const old = this.host.querySelector("svg");
    if (old) old.outerHTML = svg;
    else this.host.insertAdjacentHTML("afterbegin", svg);
  }

  /** The ink of one note (a neume may draw several notes in one element). */
  ink(id: number): NodeListOf<Element> {
    return this.host.querySelectorAll(`[data-note~="${id}"]`);
  }
}
