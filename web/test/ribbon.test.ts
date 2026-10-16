import type { TimelineNote } from "neuma";
import { describe, expect, it } from "vitest";
import { describeKey, drawRibbon, places, RANGE_CENTS, STRIP, yOf } from "../src/ribbon";

const note = (cx: number, line: number) => ({ cx, line }) as TimelineNote;

describe("ribbon", () => {
  it("gives each note the space to its neighbours on its line", () => {
    const at = places([note(100, 0), note(120, 0), note(160, 0), note(40, 1)]);
    expect(at.map((p) => [p.left, p.right])).toEqual([
      [86, 110],
      [110, 140],
      [140, 174],
      [26, 54],
    ]);
    expect(at.map((p) => p.line)).toEqual([0, 0, 0, 1]);
  });

  it("measures every band in the same cents, clipped at its edge", () => {
    expect(yOf(0, 10)).toBe(10 + STRIP / 2);
    expect(yOf(100, 0) - yOf(200, 0)).toBeCloseTo(yOf(0, 0) - yOf(100, 0));
    expect(yOf(RANGE_CENTS * 3, 0)).toBe(yOf(RANGE_CENTS, 0));
    expect(yOf(-50, 0)).toBeGreaterThan(yOf(50, 0));
  });

  it("draws the core's values, re-based where asked", () => {
    const notes = [note(100, 0), note(130, 0)];
    const bands = [
      { index: 0, from_s: 0, to_s: 1, cents: 12.34, trace: [[0.2, 10], [0.6, 14]] as Array<[number, number]> },
      { index: 1, from_s: 1, to_s: 2, cents: null, trace: [] },
    ];
    const svg = drawRibbon(notes, bands, () => 0);
    expect(svg).toContain('data-band="0" data-cents="12.3"');
    expect(svg).toContain('class="band unheard" data-band="1" data-cents=""');
    expect(svg.match(/<polyline/g)).toHaveLength(1);
    const rebased = drawRibbon(notes, bands, () => 0, 12.34);
    expect(rebased).toContain('data-cents="12.3"');
    expect(rebased).not.toEqual(svg);
  });

  it("names the key as a transposition", () => {
    expect(describeKey(-303.4)).toBe("3 semitones down, 3 cents flat");
    expect(describeKey(100)).toBe("1 semitone up");
    expect(describeKey(-12)).toBe("as written, 12 cents flat");
    expect(describeKey(0)).toBe("as written");
  });
});
