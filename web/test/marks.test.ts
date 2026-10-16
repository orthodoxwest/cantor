import type { TimelineNote } from "neuma";
import { describe, expect, it } from "vitest";
import { covered, drawMarks, type Mark } from "../src/marks";

const note = (cx: number, cy: number, line: number) => ({ cx, cy, w: 8, h: 6, line }) as TimelineNote;

describe("marks", () => {
  const notes = [note(10, 50, 0), note(30, 52, 0), note(50, 48, 0), note(10, 150, 1), note(30, 150, 1)];
  const marks: Mark[] = [
    { kind: "note", first: 1, last: 1, cents: 196 },
    { kind: "verse", first: 3, last: 4, cents: -310 },
  ];

  it("rings exactly the notes the core marked", () => {
    const svg = drawMarks(notes, marks, () => 0, null);
    expect([...svg.matchAll(/data-ring="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([1, 3, 4]);
    expect(marks.flatMap(covered)).toEqual([1, 3, 4]);
    expect(svg.match(/role="button"/g)).toHaveLength(2);
    expect(svg).toContain('aria-label="Why notes 4 to 5 are marked"');
  });

  it("follows each line down when strips open over it, and says which mark is open", () => {
    const svg = drawMarks(notes, marks, (line) => line * 44, 1);
    expect(svg).toContain('data-ring="1" cx="30.0" cy="52.0"');
    expect(svg).toContain('data-ring="3" cx="10.0" cy="194.0"');
    expect(svg).toContain('data-mark="1" tabindex="0" role="button" aria-label="Why notes 4 to 5 are marked" aria-controls="why" aria-expanded="true"');
    expect(svg).toContain('data-mark="0" tabindex="0" role="button" aria-label="Why note 2 is marked" aria-controls="why" aria-expanded="false"');
  });

  it("draws nothing for a clean take, or for a mark past the last note", () => {
    expect(drawMarks(notes, [], () => 0, null)).toBe('<g class="marks"></g>');
    expect(drawMarks(notes, [{ kind: "note", first: 7, last: 7, cents: 200 }], () => 0, null)).toBe('<g class="marks"></g>');
  });

  it("answers a tap wider than the ring it draws", () => {
    const svg = drawMarks(notes, marks, () => 0, null);
    expect(svg.match(/class="mark-hit"[^>]*r="12"/g)).toHaveLength(3);
  });
});
