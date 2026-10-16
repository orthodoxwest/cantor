import { describe, expect, it } from "vitest";
import { phraseOf, tapLoop } from "../src/loop";

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

describe("tapLoop", () => {
  it("loops the phrase tapped, stretches to another, and lets go on a tap inside", () => {
    const one = tapLoop(null, 5, pauses, 10);
    expect(one).toEqual([4, 6]);
    const two = tapLoop(one, 8, pauses, 10);
    expect(two).toEqual([4, 9]);
    expect(tapLoop(two, 1, pauses, 10)).toEqual([0, 9]);
    expect(tapLoop(two, 6, pauses, 10)).toBeNull();
  });
});
