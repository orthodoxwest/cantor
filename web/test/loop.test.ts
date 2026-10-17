import { describe, expect, it } from "vitest";
import { melismaNeumes, phraseOf, spanOf, tapLoop } from "../src/loop";

// Ten notes: a breath before note 2, a half bar before note 4 and a full bar before note 7.
const pauses = [
  { beforeNote: 2, kind: "quarter" as const },
  { beforeNote: 4, kind: "half" as const },
  { beforeNote: 7, kind: "full" as const },
];

describe("phraseOf", () => {
  it("runs from the division before a note to the one after, passing breaths", () => {
    expect(phraseOf(0, pauses, 10)).toEqual([0, 3]);
    expect(phraseOf(3, pauses, 10)).toEqual([0, 3]);
    expect(phraseOf(4, pauses, 10)).toEqual([4, 6]);
    expect(phraseOf(9, pauses, 10)).toEqual([7, 9]);
  });
  it("is the whole chant without divisions", () => {
    expect(phraseOf(5, [], 10)).toEqual([0, 9]);
  });
});

describe("spanOf", () => {
  it("runs between any divisions, breaths too", () => {
    expect(spanOf(0, pauses, 10)).toEqual([0, 1]);
    expect(spanOf(3, pauses, 10)).toEqual([2, 3]);
    expect(spanOf(5, pauses, 10)).toEqual([4, 6]);
  });
});

describe("melismaNeumes", () => {
  // As neuma gives them: each note's syllable and where it is written in the source.
  const source = "(c4) Al(gh/ji~)le(h_g!hiw/j) lu(g.f) ia(f) (::)";
  const notes = [
    [1, 8, 9],
    [1, 9, 10],
    [1, 11, 12],
    [1, 12, 14],
    [2, 18, 20],
    [2, 20, 21],
    [2, 22, 23],
    [2, 23, 25],
    [2, 26, 27],
    [3, 32, 34],
    [3, 34, 35],
    [4, 40, 41],
  ].map(([syllable, sourceUtf16Start, sourceUtf16End]) => ({ syllable: syllable!, syllableText: "x", sourceUtf16Start: sourceUtf16Start!, sourceUtf16End: sourceUtf16End! }));
  it("groups a melisma's notes written together, apart at a space or a slash, and not a syllable of one neume", () => {
    expect(melismaNeumes(notes, source)).toEqual([[0, 1], [0, 1], [2, 3], [2, 3], [4, 7], [4, 7], [4, 7], [4, 7], [8, 8], null, null, null]);
  });
  it("parts a melisma's neumes at a division written within it", () => {
    // "(c4) Al(gh/kjjh,ji/hg) le(f) (::)": a quarter bar before note 6.
    const notes = [8, 9, 11, 12, 13, 14, 16, 17, 19, 20, 26].map((at, i) => ({ syllable: i < 10 ? 1 : 2, syllableText: i < 10 ? "Al" : "le", sourceUtf16Start: at, sourceUtf16End: at + 1 }));
    const of = melismaNeumes(notes, "(c4) Al(gh/kjjh,ji/hg) le(f) (::)", [{ beforeNote: 6, kind: "quarter" }]);
    expect(of).toEqual([[0, 1], [0, 1], [2, 5], [2, 5], [2, 5], [2, 5], [6, 7], [6, 7], [8, 9], [8, 9], null]);
  });
  it("takes a group with no words straight after a syllable's notes for its melisma written on", () => {
    // "(c4) r(jhhgh)(fg'h) e(f) (::)"
    const at: [number, number, number, string][] = [[1, 7, 8, "r"], [1, 8, 9, "r"], [1, 9, 10, "r"], [1, 10, 11, "r"], [1, 11, 12, "r"], [2, 14, 15, ""], [2, 15, 17, ""], [2, 17, 18, ""], [3, 22, 23, "e"]];
    const notes = at.map(([syllable, sourceUtf16Start, sourceUtf16End, syllableText]) => ({ syllable, syllableText, sourceUtf16Start, sourceUtf16End }));
    const of = melismaNeumes(notes, "(c4) r(jhhgh)(fg'h) e(f) (::)");
    expect(of).toEqual([[0, 4], [0, 4], [0, 4], [0, 4], [0, 4], [5, 7], [5, 7], [5, 7], null]);
    // Not after a division.
    expect(melismaNeumes(notes, "(c4) r(jhhgh)(fg'h) e(f) (::)", [{ beforeNote: 5, kind: "quarter" }])).toEqual(Array(9).fill(null));
  });
});

describe("tapLoop", () => {
  it("loops the phrase tapped and stretches to another", () => {
    const one = tapLoop(null, 5, pauses, 10);
    expect(one).toEqual([4, 6]);
    const two = tapLoop(one, 8, pauses, 10);
    expect(two).toEqual([4, 9]);
    expect(tapLoop(two, 1, pauses, 10)).toEqual([0, 9]);
  });
  it("narrows on a tap inside: to the phrase, then between breaths, then to a melisma's neume, then lets go", () => {
    const neumes = [null, null, [2, 3], [2, 3], null, null, null, null, null, null] as const;
    const phrase = tapLoop([0, 9], 3, pauses, 10, neumes);
    expect(phrase).toEqual([0, 3]);
    const breath = tapLoop(phrase, 3, pauses, 10, neumes);
    expect(breath).toEqual([2, 3]);
    // The neume is the span already: nothing narrower is left.
    expect(tapLoop(breath, 3, pauses, 10, neumes)).toBeNull();
    // A phrase with no breath and no melisma lets go at once.
    expect(tapLoop([4, 6], 5, pauses, 10, neumes)).toBeNull();
    // A melisma's neume inside a phrase.
    expect(tapLoop([4, 6], 5, pauses, 10, [null, null, null, null, [4, 5], [4, 5], null])).toEqual([4, 5]);
  });
  it("stretches a loop less than a phrase as finely as it is: neume by neume, or breath by breath", () => {
    const neumes = [null, null, null, null, [4, 5], [4, 5], [6, 6], null, null, null] as const;
    // From a neume, to the next neume, or a note without one, and not to the whole phrase.
    expect(tapLoop([4, 5], 6, pauses, 10, neumes)).toEqual([4, 6]);
    expect(tapLoop([6, 6], 5, pauses, 10, neumes)).toEqual([4, 6]);
    // From the span between breaths, to the next span, in its phrase or the next.
    expect(tapLoop([2, 3], 1, pauses, 10, neumes)).toEqual([0, 3]);
    expect(tapLoop([2, 3], 5, pauses, 10, neumes)).toEqual([2, 6]);
    // A phrase stretches by phrases, as before.
    expect(tapLoop([0, 3], 5, pauses, 10, neumes)).toEqual([0, 6]);
  });
});
