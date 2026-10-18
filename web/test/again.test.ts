import { describe, expect, it } from "vitest";
import { grewOver, grown, saidIn, viewOf } from "../src/again";
import type { Mark } from "../src/marks";
import type { Band, Judged } from "../src/ribbon";

type Ending = NonNullable<Judged["endings"]>[number];

const band = (index: number, cents: number): Band => ({ index, from_s: index, to_s: index + 1, cents, trace: [] });
const mark = (kind: Mark["kind"], first: number, last = first, cents: number | null = 200): Mark => ({ kind, first, last, cents });
const ending = (first: number, last: number, mark: number | null): Ending => ({ first, last, note: last, mark, words: `ending ${first}` });
/** A judged take of twelve notes, its bands on pitch. */
const judged = (marks: Mark[], endings: Ending[]): Judged => ({
  verdict: { outcome: "heard", key_cents: 0, marks },
  told: marks.map((m) => `mark ${m.first}`),
  summary: [],
  endings,
  ribbon: Array.from({ length: 12 }, (_, i) => band(i, 0)),
});

describe("grown", () => {
  // A verse mark over notes 4 to 9, a note mark on 11 and its phrase's ending over 10 to 11.
  const take = judged([mark("verse", 4, 9), mark("note", 11)], [ending(10, 11, 1)]);

  it("leaves a run that holds the take's places whole, or none of them", () => {
    expect(grown(take, [0, 3])).toEqual([0, 3]);
    expect(grown(take, [4, 9])).toEqual([4, 9]);
    expect(grown(take, [2, 9])).toEqual([2, 9]);
  });

  it("grows a run that holds part of a place to the whole of it", () => {
    expect(grown(take, [6, 7])).toEqual([4, 9]);
    expect(grown(take, [8, 10])).toEqual([4, 11]);
    expect(grown(take, [11, 11])).toEqual([10, 11]);
  });
});

describe("grewOver", () => {
  it("names what the run is grown to hold: a mark, an ending a mark does not tell of, or both", () => {
    const take = judged([mark("verse", 4, 9), mark("note", 11)], [ending(10, 11, 1), ending(2, 3, null)]);
    expect(grewOver(take, [6, 7])).toBe("to hold the whole of your take’s mark there");
    // The ending over 10 to 11 is told by the mark on 11: grown over both, it is that mark; over
    // the ending alone, from the mark, the ending.
    expect(grewOver(take, [8, 10])).toBe("to hold the whole of your take’s marks there");
    expect(grewOver(take, [11, 11])).toBe("to hold the whole of your take’s phrase ending there");
    expect(grewOver(take, [3, 3])).toBe("to hold the whole of your take’s phrase ending there");
    expect(grewOver(take, [3, 5])).toBe("to hold the whole of your take’s marks and phrase endings there");
  });
});

describe("viewOf", () => {
  const take = judged([mark("note", 1), mark("verse", 4, 7)], [ending(2, 3, null), ending(6, 7, 1)]);
  // Its bands are of the run's notes only, by the chant's index.
  const sung = { ...judged([mark("note", 5, 5, -200)], [ending(6, 7, 0)]), ribbon: [4, 5, 6, 7].map((i) => band(i, -200)) };
  const view = viewOf(take, [4, 7], sung);

  it("draws the run's bands in place of the take's there", () => {
    expect(view.ribbon.map((b) => b.cents)).toEqual([0, 0, 0, 0, -200, -200, -200, -200, 0, 0, 0, 0]);
  });

  it("puts the run's marks and endings in place of the take's there, in the order sung, each ending with the mark that tells of it", () => {
    expect(view.verdict.marks).toEqual([mark("note", 1), mark("note", 5, 5, -200)]);
    expect(view.told).toEqual(["mark 1", "mark 5"]);
    expect(view.endings).toEqual([ending(2, 3, null), ending(6, 7, 1)]);
  });

  it("keeps the rest of the take as it was", () => {
    expect(view.summary).toBe(take.summary);
    expect(view.verdict.key_cents).toBe(0);
  });
});

describe("saidIn", () => {
  it("opens the take's first ending where the view has it, not the run's before it", () => {
    // The take's first ending off pitch, told by its mark on note 9, after a run whose own
    // ending comes first in the view.
    const take = judged([mark("note", 9)], [ending(8, 9, 0)]);
    const sung = judged([], [ending(4, 5, null)]);
    const view = viewOf(take, [2, 5], sung);
    expect(view.endings![0]!.first).toBe(4);
    expect(saidIn(take, view, [2, 5])).toBe(0);
    // Standing alone, it is among the endings that stand alone, after the marks.
    const alone = judged([], [ending(8, 9, null)]);
    const marked = judged([mark("note", 3)], [ending(4, 5, null)]);
    expect(saidIn(alone, viewOf(alone, [2, 5], marked), [2, 5])).toBe(2);
  });

  it("opens none when the take has no ending off pitch, or the run holds it", () => {
    const sung = judged([], [ending(4, 5, null)]);
    const none = judged([], []);
    expect(saidIn(none, viewOf(none, [2, 5], sung), [2, 5])).toBeNull();
    const held = judged([], [ending(4, 5, null)]);
    expect(saidIn(held, viewOf(held, [2, 5], sung), [2, 5])).toBeNull();
  });
});
