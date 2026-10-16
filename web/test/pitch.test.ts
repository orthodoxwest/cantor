import { describe, expect, it } from "vitest";
import { detectPitch, freqToMidi } from "../src/pitch";

const sine = (f: number, sampleRate: number, n = 2048, amplitude = 0.3) =>
  Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin((2 * Math.PI * f * i) / sampleRate));

describe("detectPitch", () => {
  for (const sampleRate of [44100, 48000]) {
    for (const f of [110, 220, 261.63, 440, 880]) {
      it(`finds ${f} Hz at ${sampleRate} Hz within 2 cents`, () => {
        const { midi, clarity } = detectPitch(sine(f, sampleRate), sampleRate);
        expect(midi).not.toBeNull();
        expect(Math.abs(midi! - freqToMidi(f)) * 100).toBeLessThan(2);
        expect(clarity).toBeGreaterThanOrEqual(0.8);
      });
    }
  }

  it("reports nothing for silence", () => {
    expect(detectPitch(new Float32Array(2048), 48000)).toEqual({ midi: null, clarity: 0, rms: 0 });
  });

  it("reports nothing below the floor", () => {
    expect(detectPitch(sine(440, 48000, 2048, 0.005), 48000).midi).toBeNull();
  });
});
