// The engraved chant in its host, laid out again whenever the host's width changes.
import type { Chant, Timeline, View, WholePage } from "neuma";

export class Score {
  private readonly view: View<WholePage>;
  private page: WholePage;
  timeline: Timeline;

  constructor(readonly host: HTMLElement, chant: Chant) {
    this.view = chant.view();
    this.page = this.view.layout(host.clientWidth);
    this.timeline = this.page.timeline();
    this.render();
    new ResizeObserver(() => this.relayout()).observe(host);
  }

  /** Lays out at the host's width; nothing changes when the width is the same. */
  relayout(): void {
    const page = this.view.layout(this.host.clientWidth);
    if (page === this.page) return;
    this.page = page;
    this.timeline = page.timeline();
    this.render();
  }

  private render(): void {
    const svg = this.host.querySelector("svg");
    if (svg) svg.outerHTML = this.page.svg;
    else this.host.insertAdjacentHTML("afterbegin", this.page.svg);
  }

  /** The ink of one note (a neume may draw several notes in one element). */
  ink(id: number): NodeListOf<Element> {
    return this.host.querySelectorAll(`[data-note~="${id}"]`);
  }
}
