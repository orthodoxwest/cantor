import type { Timeline } from "neuma";
import { describe, expect, it } from "vitest";
import { chunksDue, notesText, octaveShift } from "../src/voice";

describe("notesText", () => {
  it("writes one tab-separated line per note in seconds", () => {
    const timeline = {
      notes: [
        { semitones: 7, start: 0, duration: 1, word: 0, syllable: 0, syllableText: "Al" },
        { semitones: 9, start: 1, duration: 2, word: 0, syllable: 1, syllableText: "le\tlu" },
      ],
    } as unknown as Timeline;
    expect(notesText(timeline, 0.5, (s) => 48 + s)).toBe("55\t0\t0.5\t0\t0\tAl\n57\t0.5\t1\t0\t1\tle lu");
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
