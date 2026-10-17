import { describe, expect, it } from "vitest";
import type { Mark } from "../src/marks";
import { byPhrase, runOf, stepTo, sungOrder, writtenStep } from "../src/review";

// Twelve notes: a half bar before note 4 and a full bar before note 8.
const pauses = [
  { beforeNote: 4, kind: "half" as const },
  { beforeNote: 8, kind: "full" as const },
];
const note = (first: number, last = first): Mark => ({ kind: "note", first, last, cents: 200 });
// As the core may give them: not in the order sung.
const marks = [note(9), note(2), { ...note(5, 9), kind: "verse" as const }, note(1)];

describe("sungOrder", () => {
  it("orders the marks by their first note", () => {
    expect(sungOrder(marks)).toEqual([3, 1, 2, 0]);
  });
});

describe("runOf", () => {
  it("runs from the phrase of a mark's first note to the end of its last's", () => {
    expect(runOf(note(2), pauses, 12)).toEqual([0, 3]);
    expect(runOf(note(5, 9), pauses, 12)).toEqual([4, 11]);
  });
});

describe("stepTo", () => {
  it("steps along the marks in the order sung from the one open, and stops at the ends", () => {
    expect(stepTo(marks, 1, null, 1)).toBe(2);
    expect(stepTo(marks, 1, null, -1)).toBe(3);
    expect(stepTo(marks, 0, null, 1)).toBeNull();
    expect(stepTo(marks, 3, null, -1)).toBeNull();
  });
  it("starts from either end when nothing is chosen", () => {
    expect(stepTo(marks, null, null, 1)).toBe(3);
    expect(stepTo(marks, null, null, -1)).toBe(0);
    expect(stepTo([], null, null, 1)).toBeNull();
  });
  it("steps from a run chosen: into it, or to the last mark before it", () => {
    expect(stepTo(marks, null, [4, 7], 1)).toBe(2);
    expect(stepTo(marks, null, [4, 7], -1)).toBe(1);
    expect(stepTo(marks, null, [0, 3], -1)).toBeNull();
    expect(stepTo(marks, null, [10, 11], 1)).toBeNull();
    expect(stepTo(marks, null, [10, 11], -1)).toBe(0);
  });
});

describe("byPhrase", () => {
  it("gathers the marks by the run each chooses, in the order sung", () => {
    expect(byPhrase(marks, pauses, 12)).toEqual([
      { run: [0, 3], marks: [3, 1] },
      { run: [4, 11], marks: [2] },
      { run: [8, 11], marks: [0] },
    ]);
  });
  it("keeps a run's marks together though another run's come between them", () => {
    const between = [note(1), { ...note(2, 9), kind: "verse" as const }, note(3)];
    expect(byPhrase(between, pauses, 12)).toEqual([
      { run: [0, 3], marks: [0, 2] },
      { run: [0, 11], marks: [1] },
    ]);
  });
});

describe("writtenStep", () => {
  it("names the interval from the note before, and which way", () => {
    expect(writtenStep(2)).toBe("a whole tone above the note before");
    expect(writtenStep(-5)).toBe("a fourth below the note before");
    expect(writtenStep(0)).toBe("on the same pitch as the note before");
    expect(writtenStep(14)).toBe("more than an octave above the note before");
  });
});
