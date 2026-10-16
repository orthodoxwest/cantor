import { describe, expect, it } from "vitest";
import { droneLoop, droneNote, modeNumber } from "../src/drone";

/** A note `semitones` above do, sung an octave lower (as a low voice would). */
const n = (semitones: number, recitation = false) => ({ semitones, midi: 48 + semitones, recitation });

describe("droneNote", () => {
  it("drones on the mode's reciting note where the chant recites on it", () => {
    // Mode 8, ending on G: recited C.
    expect(droneNote([n(5), n(12, true), n(12, true), n(7)], 8)).toBe(60);
  });
  it("does not take a run on another note for the reciting note", () => {
    // Mode 6, a run on its final F: the reciting note is A, nearest the middle.
    expect(droneNote([n(5, true), n(5, true), n(5, true), n(7), n(9), n(5)], 6)).toBe(48 + 9);
    // Mode 8 with no recitation, around G: C above.
    expect(droneNote([n(7), n(9), n(11), n(7)], 8)).toBe(48 + 12);
  });
  it("reads a chant ending on its final a fifth up as written a fifth up", () => {
    // Mode 1 ending on A, not D: its reciting note is E.
    expect(droneNote([n(9), n(14), n(16), n(9)], 1)).toBe(48 + 16);
    // Mode 1 ending on D: A.
    expect(droneNote([n(2), n(7), n(9), n(2)], 1)).toBe(48 + 9);
  });
  it("does not read a repeat cue after a verse as a fifth up", () => {
    // Mode 1, its body ending on D; then a verse reciting on A, and the cue ending on A.
    const gaudeamus = [n(2), n(7), n(9), n(2), n(9, true), n(9, true), n(9, true), n(7), n(9)];
    expect(droneNote(gaudeamus, 1, 3)).toBe(48 + 9);
    // A gradual of the second mode written on A, body and all: its reciting note is C.
    expect(droneNote([n(9), n(12), n(14), n(9)], 2, 3)).toBe(48 + 12);
  });
  it("without a mode, on the first recited note, or the last", () => {
    expect(droneNote([n(5), n(9, true), n(9, true), n(7)], null)).toBe(48 + 9);
    expect(droneNote([n(0), n(2)], null)).toBe(48 + 2);
  });
  it("on nothing without notes", () => {
    expect(droneNote([], 1)).toBeNull();
  });
});

describe("modeNumber", () => {
  it("reads numerals, roman numerals and differentiae", () => {
    expect(["viii", "8", "1g", "IV E", " iii ", "VIII.", "8G"].map(modeNumber)).toEqual([8, 8, 1, 4, 3, 8, 8]);
  });
  it("is null for anything else", () => {
    expect(["per", "", "9", "10", null, undefined, "ix"].map(modeNumber)).toEqual([null, null, null, null, null, null, null]);
  });
});

describe("droneLoop", () => {
  it("holds a whole number of cycles of a pitch between whole hertz, in tune to a few hundredths of a cent", () => {
    const rate = 48000;
    const freq = 123.4708; // B2
    const loop = droneLoop(freq, rate);
    const cycles = Math.round(freq);
    const sung = (cycles * rate) / loop.length;
    expect(Math.abs(1200 * Math.log2(sung / freq))).toBeLessThan(0.05);
    // Across the seam it goes on as it began: the sample after the last is the first.
    const next = (i: number) => {
      const p = (2 * Math.PI * cycles * i) / loop.length;
      return [1, 0.35, 0.12, 0.05].reduce((x, a, k) => x + a * Math.sin((k + 1) * p), 0) / 1.52;
    };
    expect(next(loop.length)).toBeCloseTo(loop[0]!, 6);
    // And it holds that many cycles: its upward zero crossings, the first at sample 0.
    let ups = 1;
    for (let i = 1; i < loop.length; i++) if (loop[i - 1]! < 0 && loop[i]! >= 0) ups++;
    expect(ups).toBe(cycles);
    expect(Math.max(...loop.map(Math.abs))).toBeLessThanOrEqual(1);
  });
});
