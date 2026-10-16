import { describe, expect, it } from "vitest";
import { halve, takeFile, wav } from "../src/wav";

const sine = (hz: number, rate: number, seconds: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
const rms = (x: Float32Array, from = 100, to = x.length - 100) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i]! ** 2;
  return Math.sqrt(sum / (to - from));
};

describe("wav", () => {
  it("writes a 16-bit mono WAV file", () => {
    const bytes = wav(Float32Array.from([0, 1, -1, 2, 0.5]), 24_000);
    const view = new DataView(bytes);
    const tag = (at: number) => String.fromCharCode(...new Uint8Array(bytes, at, 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + 2 * i, true))).toEqual([0, 32767, -32767, 32767, 16384]);
  });

  it("halves a rate, keeping the voice and stopping what would fold back", () => {
    const rate = 48_000;
    // A sung note passes; a tone above the new Nyquist is all but gone.
    expect(rms(halve(sine(440, rate, 0.5))) / rms(sine(440, rate, 0.5))).toBeCloseTo(1, 2);
    expect(rms(halve(sine(15_000, rate, 0.5))) / rms(sine(15_000, rate, 0.5))).toBeLessThan(0.01);
    expect(halve(new Float32Array(5))).toHaveLength(3);
  });

  it("keeps the take's times: a click stays where it was", () => {
    const x = new Float32Array(48_000);
    x[24_000] = 1;
    const y = halve(x);
    const peak = y.reduce((best, v, i) => (Math.abs(v) > Math.abs(y[best]!) ? i : best), 0);
    expect(peak).toBe(12_000);
  });

  it("sends 48 and 44.1 kHz at half, and 24 kHz or less as it is", () => {
    expect(takeFile(new Float32Array(480), 48_000).rate).toBe(24_000);
    expect(takeFile(new Float32Array(441), 44_100).rate).toBe(22_050);
    expect(takeFile(new Float32Array(160), 16_000).rate).toBe(16_000);
    expect(takeFile(new Float32Array(960), 96_000).rate).toBe(24_000);
    expect(takeFile(new Float32Array(480), 48_000).wav.byteLength).toBe(44 + 480);
  });
});
