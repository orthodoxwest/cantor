// A take as a file to send: mono 16-bit WAV, at half the microphone's rate when that is above
// 24 kHz (a voice needs no more, and the file is half the size). Sample 0 is the take's first,
// so the judged result's times stay true of the file.

/** The highest rate kept; above it the take is halved. */
export const MAX_RATE = 24_000;

/** Taps of the half-band low-pass run before dropping every other sample. */
const TAPS = 63;

/** A windowed-sinc low-pass at a quarter of the rate (Blackman window), its gains summing to 1. */
const HALF_BAND = (() => {
  const h = new Float64Array(TAPS);
  const mid = (TAPS - 1) / 2;
  // A little under a quarter, so the band to the new Nyquist is mostly stopped.
  const cut = 0.225;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * n) / (Math.PI * n);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    h[i] = sinc * w;
    sum += h[i]!;
  }
  return h.map((x) => x / sum);
})();

/** `samples` at half their rate: low-passed, then every other sample, the first kept. */
export function halve(samples: Float32Array): Float32Array {
  const out = new Float32Array(Math.ceil(samples.length / 2));
  const mid = (TAPS - 1) / 2;
  for (let k = 0; k < out.length; k++) {
    // The taps that fall within the take; beyond it is silence.
    const from = 2 * k - mid;
    const lo = Math.max(0, -from);
    const hi = Math.min(TAPS, samples.length - from);
    let acc = 0;
    for (let j = lo; j < hi; j++) acc += samples[from + j]! * HALF_BAND[j]!;
    out[k] = acc;
  }
  return out;
}

/** `samples` at `rate` as a 16-bit mono WAV file. */
export function wav(samples: Float32Array, rate: number): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(x * 32767), true);
  }
  return bytes;
}

/** The take at `rate` as the file sent: halved while above [`MAX_RATE`]. */
export function takeFile(samples: Float32Array, rate: number): { wav: ArrayBuffer; rate: number } {
  let s = samples;
  let r = rate;
  while (r > MAX_RATE) {
    s = halve(s);
    r /= 2;
  }
  return { wav: wav(s, Math.round(r)), rate: r };
}
