// The engraved chant in its host, laid out again whenever the host's width changes. After a
// take, a strip opens under each staff line for the ribbon (ribbon.ts).
import type { Chant, LineBox, LinesPage, Timeline, View } from "neuma";
import { STRIP } from "./ribbon";

/** Draws the ribbon's strips, given where each line's strip starts. */
export type Strips = (timeline: Timeline, stripTop: (line: number) => number) => string;

export class Score {
  private view: View<LinesPage>;
  private page: LinesPage;
  timeline: Timeline;
  private strips: Strips | null = null;

  constructor(
    readonly host: HTMLElement,
    private chant: Chant,
  ) {
    this.view = chant.view({ svg: "lines" });
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
    this.view = chant.view({ svg: "lines" });
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

  /** Line `i`'s box as drawn, below the strips over it. */
  line(i: number): LineBox {
    const box = this.timeline.lines[i]!;
    const shift = this.strips ? i * STRIP : 0;
    return { top: box.top + shift, bottom: box.bottom + shift, staff: box.staff + shift, baseline: box.baseline + shift };
  }

  /** Where line `i`'s strip starts: under the line, and under the page's foot (an initial's
   * descent) for the last. */
  private stripTop(i: number): number {
    const bottom = this.line(i).bottom;
    return i === this.timeline.lines.length - 1 ? Math.max(bottom, this.page.height + i * STRIP) : bottom;
  }

  private render(): void {
    const { head, defs, rest, lines } = this.page.svgParts;
    const gap = this.strips ? STRIP : 0;
    const height = this.page.height + gap * lines.length;
    let top = head
      .replace(/ height="[\d.]+"/, ` height="${height.toFixed(2)}"`)
      .replace(/viewBox="([\d.]+) ([\d.]+) ([\d.]+) [\d.]+"/, `viewBox="$1 $2 $3 ${height.toFixed(2)}"`);
    const engraving = [rest, ...lines.map((l, i) => `<g transform="translate(0 ${(l.top + i * gap).toFixed(2)})">${l.svg}</g>`)].join("");
    let body = engraving;
    if (this.strips) {
      // An image's children are hidden from assistive technology, so with the ribbon's
      // buttons beside it the engraving alone is the image.
      const label = / aria-label="([^"]*)"/.exec(top)?.[1] ?? "";
      top = top.replace(/ role="img"/, "").replace(/ aria-label="[^"]*"/, "");
      body = `<g role="img" aria-label="${label}">${engraving}</g><g class="ribbon">${this.strips(this.timeline, (i) => this.stripTop(i))}</g>`;
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
