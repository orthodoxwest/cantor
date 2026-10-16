import type { TimelineNote } from "neuma";
import { describe, expect, it } from "vitest";
import { chunksDue, fromTimeline, notesText, octaveShift } from "../src/singer";

describe("fromTimeline and notesText", () => {
  it("time a run from its first pulse and write one tab-separated line per note", () => {
    const run = [
      { semitones: 7, start: 4, duration: 1, word: 3, syllable: 5, syllableText: "Al" },
      { semitones: 9, start: 5, duration: 2, word: 3, syllable: 6, syllableText: "le\tlu" },
    ] as unknown as TimelineNote[];
    const notes = fromTimeline(run, 0.5, (s) => 48 + s, 4);
    expect(notes[1]).toEqual({ midi: 57, start: 0.5, duration: 1, word: 3, syllable: 6, text: "le\tlu" });
    expect(notesText(notes)).toBe("55\t0\t0.5\t3\t5\tAl\n57\t0.5\t1\t3\t6\tle lu");
  });
});

describe("octaveShift", () => {
  it("moves the middle note by whole octaves toward the voice", () => {
    expect(octaveShift([60, 62, 67], 55)).toBe(-12);
    expect(octaveShift([55, 57], 55)).toBe(0);
    expect(octaveShift([40, 41, 43], 55)).toBe(12);
    expect(octaveShift([], 55)).toBe(0);
  });
});

describe("chunksDue", () => {
  it("covers the part once, chunk by chunk, up to the horizon", () => {
    expect(chunksDue(0, 250, 100, 1000)).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
    ]);
    expect(chunksDue(300, 250, 100, 1000)).toEqual([]);
    expect(chunksDue(900, 5000, 100, 950)).toEqual([[900, 50]]);
  });
});
