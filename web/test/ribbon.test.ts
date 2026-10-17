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

  it("presses a run of bands, the first of them the one tab stop, or the first drawn past them", () => {
    const notes = [note(100, 0), note(130, 0), note(160, 0)];
    const band = (index: number) => ({ index, from_s: index, to_s: index + 1, cents: 0, trace: [] });
    const states = (svg: string) => [...svg.matchAll(/tabindex="(-?\d)" role="button" aria-label="[^"]*" aria-pressed="(\w+)"/g)].map((m) => [m[1], m[2]]);
    const choose = (i: number) => `Note ${i + 1}`;
    const all = [band(0), band(1), band(2)];
    expect(states(drawRibbon(notes, all, () => 0, 0, [1, 2], choose))).toEqual([["-1", "false"], ["0", "true"], ["-1", "true"]]);
    expect(states(drawRibbon(notes, all, () => 0, 0, null, choose))).toEqual([["0", "false"], ["-1", "false"], ["-1", "false"]]);
    // A take stopped after note 2, a run chosen past it: the ribbon is still reached.
    expect(states(drawRibbon(notes, all.slice(0, 2), () => 0, 0, [2, 2], choose))).toEqual([["0", "false"], ["-1", "false"]]);
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

  it("draws each heard note's value as a bar across its band, re-based with the traces", () => {
    const notes = [note(100, 0), note(130, 0)];
    const bands = [
      { index: 0, from_s: 0, to_s: 1, cents: 60, trace: [[0.2, 40], [0.6, 80]] as Array<[number, number]> },
      { index: 1, from_s: 1, to_s: 2, cents: null, trace: [] },
    ];
    const held = (svg: string) =>
      [...svg.matchAll(/<line class="band-held" x1="([^"]*)" x2="([^"]*)" y1="([^"]*)" y2="([^"]*)"/g)].map((m) => m.slice(1).map(Number));
    // The first note only, the second not heard: its band (86 to 115) less 4 each side, inside
    // its target (the band less 1).
    expect(held(drawRibbon(notes, bands, () => 0))).toEqual([[90, 111, ...[yOf(60, 0), yOf(60, 0)].map((y) => Number(y.toFixed(1)))]]);
    expect(held(drawRibbon(notes, bands, () => 0, 60, 0))).toEqual([[90, 111, yOf(0, 0), yOf(0, 0)]]);
    // Clipped at the strip's edge, as the trace is.
    const far = [{ ...bands[0]!, cents: RANGE_CENTS * 2 }];
    expect(held(drawRibbon(notes, far, () => 0))[0]!.slice(2)).toEqual([yOf(RANGE_CENTS, 0), yOf(RANGE_CENTS, 0)]);
    // In a neume's narrow band, a quarter of its width each side.
    const stacked = [note(157.5, 0), note(157.8, 0), note(163.5, 0)];
    const [bar] = held(drawRibbon(stacked, [{ ...bands[0]!, index: 1 }], () => 0));
    expect(bar![1]! - bar![0]!).toBeCloseTo(MIN_WIDTH / 2);
    expect(bar![0]).toBeGreaterThan(157.8 - MIN_WIDTH / 2 + 1);
    expect(bar![1]).toBeLessThan(157.8 + MIN_WIDTH / 2 - 1);
  });

  it("draws the trace over the whole note, and the value over the part it was read from", () => {
    const notes = [note(100, 0), note(130, 0)];
    // Slid up into the note over its first tenth, then held 10 cents sharp.
    const bands = [{ index: 0, from_s: 0.2, to_s: 0.9, start_s: 0, end_s: 1, cents: 10, trace: [[0.05, -120], [0.5, 10]] as Array<[number, number]> }];
    const svg = drawRibbon(notes, bands, () => 0);
    // Its band is 86 to 115; the whole note across it, less 2 each side.
    const points = svg.match(/<polyline class="band-trace" points="([^"]*)"/)![1]!.split(" ").map((p) => p.split(",").map(Number));
    expect(points.map((p) => p[0])).toEqual([89.3, 100.5]);
    expect(points[0]![1]).toBe(Number(yOf(-120, 0).toFixed(1)));
    const held = svg.match(/<line class="band-held" x1="([^"]*)" x2="([^"]*)"/)!.slice(1).map(Number);
    expect(held).toEqual([93, 110.5]);
    // Never shorter than a dot, in a neume's narrow band.
    const stacked = [note(157.5, 0), note(157.8, 0), note(163.5, 0)];
    const narrow = drawRibbon(stacked, [{ ...bands[0]!, index: 1 }], () => 0).match(/<line class="band-held" x1="([^"]*)" x2="([^"]*)"/)!.slice(1).map(Number);
    expect(narrow[1]! - narrow[0]!).toBeCloseTo(4);
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

  it("draws a recording's trace under the singer's, each from its own key, re-based on the same note", () => {
    const notes = [note(100, 0), note(130, 0)];
    const t = (pts: Array<[number, number]>) => pts;
    const bands = [
      { index: 0, from_s: 0, to_s: 1, cents: 50, trace: t([[0.2, 50], [0.6, 50]]) },
      { index: 1, from_s: 1, to_s: 2, cents: null, trace: [] },
    ];
    // The recording, sung at its own pace: its times are its own, its cents from its own key.
    const recorded = [
      { index: 0, from_s: 4, to_s: 6, cents: -20, trace: t([[4, -20], [6, -20]]) },
      { index: 1, from_s: 6, to_s: 8, cents: 10, trace: t([[6, 10], [8, 10]]) },
    ];
    const lines = (svg: string, cls: string) =>
      [...svg.matchAll(new RegExp(`<polyline class="${cls}" points="([^"]*)"`, "g"))].map((m) =>
        m[1]!.split(" ").map((p) => p.split(",").map(Number)),
      );
    const svg = drawRibbon(notes, bands, () => 0, 0, null, undefined, recorded);
    // Drawn first, so under the singer's; on the singer's unheard note too.
    expect(svg.indexOf("band-recorded")).toBeLessThan(svg.indexOf("band-trace"));
    const drawn = lines(svg, "band-recorded");
    expect(drawn).toHaveLength(2);
    expect(drawn[0]!.map((p) => p[1])).toEqual([yOf(-20, 0), yOf(-20, 0)].map((y) => Number(y.toFixed(1))));
    // Across the band the singer's is drawn in (86 to 115, less 2 each side), whatever the
    // recording's times.
    expect(drawn[0]!.map((p) => p[0])).toEqual([88, 113]);
    // Re-based on the first note: the singer's trace by the singer's 50, the recording's by its -20.
    const rebased = lines(drawRibbon(notes, bands, () => 0, 50, 0, undefined, recorded), "band-recorded");
    expect(rebased[0]!.map((p) => p[1])).toEqual([yOf(0, 0), yOf(0, 0)]);
    expect(rebased[1]!.map((p) => p[1])).toEqual([yOf(30, 0), yOf(30, 0)].map((y) => Number(y.toFixed(1))));
    expect(drawRibbon(notes, bands, () => 0)).not.toContain("band-recorded");
    // Re-based on a note the recording has no value for, the recording is not drawn.
    const missed = [{ ...recorded[0]!, cents: null }, recorded[1]!];
    const unbased = drawRibbon(notes, bands, () => 0, 50, 0, undefined, missed);
    expect(unbased).not.toContain("band-recorded");
    expect(unbased).toContain("band-trace");
  });

  it("draws a recording seeded with only its sustained parts over the part the singer's value was read from", () => {
    const notes = [note(100, 0), note(130, 0)];
    // The singer's whole note runs 0 to 1, its value read from 0.2 to 0.9; the recording's band,
    // seeded before bands had the whole note, has its sustained part alone, at its own pace.
    const bands = [{ index: 0, from_s: 0.2, to_s: 0.9, start_s: 0, end_s: 1, cents: 0, trace: [[0.2, 0], [0.9, 0]] as Array<[number, number]> }];
    const recorded = [{ index: 0, from_s: 4, to_s: 6, cents: 0, trace: [[4, 0], [6, 0]] as Array<[number, number]> }];
    const xs = (svg: string, cls: string) =>
      svg.match(new RegExp(`<polyline class="${cls}" points="([^"]*)"`))![1]!.split(" ").map((p) => Number(p.split(",")[0]));
    const svg = drawRibbon(notes, bands, () => 0, 0, null, undefined, recorded);
    // The two traces' ends lie together, over the singer's sustained part.
    expect(xs(svg, "band-recorded")).toEqual(xs(svg, "band-trace"));
    // A recording with the whole note is drawn across it, as the singer's is.
    const whole = [{ ...recorded[0]!, start_s: 3.5, end_s: 6.5, trace: [[3.5, 0], [6.5, 0]] as Array<[number, number]> }];
    expect(xs(drawRibbon(notes, bands, () => 0, 0, null, undefined, whole), "band-recorded")).toEqual([88, 113]);
    // One with only one of the whole note's times is drawn as one with neither.
    const half = [{ ...recorded[0]!, start_s: 3.5 }];
    expect(xs(drawRibbon(notes, bands, () => 0, 0, null, undefined, half), "band-recorded")).toEqual(xs(svg, "band-trace"));
  });

  it("names the key as a transposition", () => {
    expect(describeKey(-303.4)).toBe("3 semitones down, 3 cents flat");
    expect(describeKey(100)).toBe("1 semitone up");
    expect(describeKey(-12)).toBe("as written, 12 cents flat");
    expect(describeKey(0)).toBe("as written");
  });
});
