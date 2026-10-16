// Marks the sounding note and draws a bar over its staff line. SVG units are pixels: the
// page is laid out at the host's width.
import type { LineBox } from "neuma";
import type { Score } from "./score";

export class Cursor {
  private readonly bar = document.createElement("div");
  private marked: number | null = null;

  constructor(private readonly score: Score) {
    this.bar.className = "cursor";
    this.bar.hidden = true;
    score.host.append(this.bar);
  }

  /** Puts the bar at x on a line, marking the note (or none, during a pause). */
  show(x: number, line: LineBox, note: number | null): void {
    this.mark(note);
    this.bar.style.left = `${x}px`;
    this.bar.style.top = `${line.top}px`;
    this.bar.style.height = `${line.bottom - line.top}px`;
    this.bar.hidden = false;
  }

  hide(): void {
    this.mark(null);
    this.bar.hidden = true;
  }

  private mark(note: number | null): void {
    if (note === this.marked) return;
    if (this.marked !== null) for (const el of this.score.ink(this.marked)) el.classList.remove("cantor-current");
    if (note !== null) for (const el of this.score.ink(note)) el.classList.add("cantor-current");
    this.marked = note;
  }
}
