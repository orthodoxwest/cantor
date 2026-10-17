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
  ].map(([syllable, sourceUtf16Start, sourceUtf16End]) => ({ syllable: syllable!, sourceUtf16Start: sourceUtf16Start!, sourceUtf16End: sourceUtf16End! }));
  it("groups a melisma's notes written together, apart at a space or a slash, and not a syllable of one neume", () => {
    expect(melismaNeumes(notes, source)).toEqual([[0, 1], [0, 1], [2, 3], [2, 3], [4, 7], [4, 7], [4, 7], [4, 7], [8, 8], null, null, null]);
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
});
