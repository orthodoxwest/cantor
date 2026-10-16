import type { TimelineNote } from "neuma";
import { describe, expect, it } from "vitest";
import { describeKey, drawRibbon, MIN_WIDTH, places, RANGE_CENTS, STRIP, yOf } from "../src/ribbon";

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

  it("draws notes stacked in a neume no narrower than the least width", () => {
    const at = places([note(157.5, 0), note(157.8, 0), note(163.5, 0)]);
    for (const p of at) expect(p.right - p.left).toBeGreaterThanOrEqual(MIN_WIDTH);
    expect(at[1]).toEqual({ line: 0, left: 157.8 - MIN_WIDTH / 2, right: 157.8 + MIN_WIDTH / 2 });
  });

  it("measures every band in the same cents, clipped at its edge", () => {
    expect(yOf(0, 10)).toBe(10 + STRIP / 2);
    expect(yOf(50, 0) - yOf(100, 0)).toBeCloseTo(yOf(0, 0) - yOf(50, 0));
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
  });

  it("re-bases the traces on a note, keeping every target where it was", () => {
    const notes = [note(100, 0), note(130, 0)];
    const bands = [
      { index: 0, from_s: 0, to_s: 1, cents: 100, trace: [[0.2, 100], [0.6, 100]] as Array<[number, number]> },
      { index: 1, from_s: 1, to_s: 2, cents: 0, trace: [[1.2, 0], [1.6, 0]] as Array<[number, number]> },
    ];
    const ys = (svg: string, cls: string) =>
      [...svg.matchAll(new RegExp(`class="${cls}"[^>]*`, "g"))].map((m) =>
        cls === "band-trace"
          ? m[0].match(/points="([^"]*)"/)![1]!.split(" ").map((p) => Number(p.split(",")[1]))
          : [Number(m[0].match(/y1="([^"]*)"/)![1])],
      );
    const rebased = drawRibbon(notes, bands, () => 0, 100);
    expect(ys(rebased, "band-target")).toEqual(ys(drawRibbon(notes, bands, () => 0), "band-target"));
    const centre = yOf(0, 0);
    expect(ys(rebased, "band-trace")).toEqual([
      [centre, centre],
      [yOf(-100, 0), yOf(-100, 0)].map((y) => Number(y.toFixed(1))),
    ]);
  });

  it("names the key as a transposition", () => {
    expect(describeKey(-303.4)).toBe("3 semitones down, 3 cents flat");
    expect(describeKey(100)).toBe("1 semitone up");
    expect(describeKey(-12)).toBe("as written, 12 cents flat");
    expect(describeKey(0)).toBe("as written");
  });
});
