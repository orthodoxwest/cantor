import { describe, expect, it } from "vitest";
import { droneLoop, TONE_RMS } from "../src/drone";
import { heldBand, loudness, times, toneLevel } from "../src/held";

/** `seconds` of a sine of amplitude `amp` at `rate` samples a second. */
const sine = (seconds: number, amp: number, rate = 8000) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / rate));

describe("times", () => {
  it("hears a note about 2.4 seconds over, a short note more often", () => {
    expect(times(0.8)).toBe(3);
    expect(times(0.6)).toBe(4);
    expect(times(0.4)).toBe(6);
  });
  it("hears a long note at least three times and a short one at most eight", () => {
    expect(times(3)).toBe(3);
    expect(times(1.2)).toBe(3);
    expect(times(0.3)).toBe(8);
    expect(times(0.1)).toBe(8);
    expect(times(0)).toBe(8);
  });
});

describe("loudness", () => {
  it("is the root of the mean square of the seconds asked for, alone", () => {
    const rate = 8000;
    const quiet = sine(1, 0.1, rate);
    const loud = sine(1, 0.4, rate);
    const take = new Float32Array(2 * rate);
    take.set(quiet);
    take.set(loud, rate);
    expect(loudness([take], rate, 0, 1)).toBeCloseTo(0.1 / Math.SQRT2, 3);
    expect(loudness([take], rate, 1, 2)).toBeCloseTo(0.4 / Math.SQRT2, 3);
  });
  it("is over every channel, and none past the take's end", () => {
    const rate = 8000;
    expect(loudness([sine(1, 0.2, rate), new Float32Array(rate)], rate, 0, 1)).toBeCloseTo(0.2 / 2, 3);
    expect(loudness([sine(1, 0.2, rate)], rate, 0.5, 3)).toBeCloseTo(0.2 / Math.SQRT2, 3);
    expect(loudness([sine(1, 0.2, rate)], rate, 2, 3)).toBe(0);
  });
});

describe("toneLevel", () => {
  it("sounds the tone half as loud as the note as it plays back", () => {
    // The note plays back at 0.9.
    for (const rms of [0.03, 0.1, 0.2]) expect(toneLevel(rms) * TONE_RMS).toBeCloseTo(0.5 * 0.9 * rms, 6);
  });
  it("keeps within a level heard and one not too loud", () => {
    expect(toneLevel(0)).toBe(0.01);
    expect(toneLevel(0.001)).toBe(0.01);
    expect(toneLevel(1)).toBe(0.2);
  });
  it("knows how loud the tone is at level 1", () => {
    const rate = 48000;
    const loop = droneLoop(220, rate);
    expect(loudness([loop], rate, 0, loop.length / rate)).toBeCloseTo(TONE_RMS, 3);
  });
});

describe("heldBand", () => {
  const band = (index: number, target_midi?: number | null, from_s = 1, to_s = 1.4) => ({ index, from_s, to_s, cents: target_midi == null ? null : 20, target_midi, trace: [] });
  const bands = [band(0, 69.1), band(1, 67.05), band(2, null), band(3), band(4, 64, 3, 3.03125), band(5, 62, 3, 3.0625)];
  it("is the band of the note asked for, where it belonged", () => {
    expect(heldBand(bands, 1, "note")).toEqual(band(1, 67.05));
    expect(heldBand(bands, 0, undefined)).toEqual(band(0, 69.1));
    expect(heldBand(bands, 5, "verse")).toEqual(band(5, 62, 3, 3.0625));
  });
  it("is none for a note not heard, or not among the bands", () => {
    expect(heldBand(bands, 2, "note")).toBeNull();
    // Sent, or seeded, before bands said where the note belonged.
    expect(heldBand(bands, 3, "note")).toBeNull();
    expect(heldBand(bands, 6, "note")).toBeNull();
  });
  it("is none for a note held too short to hear", () => {
    expect(heldBand(bands, 4, "note")).toBeNull();
  });
  it("is none at a verse not heard, whatever of it was", () => {
    expect(heldBand(bands, 0, "verse-missing")).toBeNull();
  });
});
