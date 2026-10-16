// McLeod pitch method on one frame: normalised square difference, the first peak at or
// above 90% of the highest, refined parabolically. The stand-in until the Rust core's wasm
// build replaces it.

export interface Pitch {
  /** The pitch as a fractional MIDI number, or null when none is clear enough. */
  midi: number | null;
  clarity: number;
  rms: number;
}

export const freqToMidi = (f: number): number => 69 + 12 * Math.log2(f / 440);

export function detectPitch(buf: Float32Array, sampleRate: number, minRms = 0.008, minClarity = 0.8): Pitch {
  const n = buf.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i]! * buf[i]!;
  const rms = Math.sqrt(sum / n);
  const none = { midi: null, clarity: 0, rms };
  if (rms < minRms) return none;

  const minTau = Math.max(2, Math.floor(sampleRate / 1100));
  const maxTau = Math.min(n >> 1, Math.floor(sampleRate / 62));
  // Lags below minTau are computed too, so the lobe at lag 0 can be told from the first real one.
  const nsdf = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let acf = 0;
    let m = 0;
    for (let i = 0, end = n - tau; i < end; i++) {
      const a = buf[i]!;
      const b = buf[i + tau]!;
      acf += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }

  // Skip the lobe at lag 0, then take the highest point of each positive run.
  let tau = 1;
  while (tau <= maxTau && nsdf[tau]! > 0) tau++;
  const peaks: Array<[number, number]> = [];
  let maxVal = 0;
  while (tau <= maxTau) {
    while (tau <= maxTau && nsdf[tau]! <= 0) tau++;
    let best = -1;
    let bestTau = -1;
    while (tau <= maxTau && nsdf[tau]! > 0) {
      if (nsdf[tau]! > best) {
        best = nsdf[tau]!;
        bestTau = tau;
      }
      tau++;
    }
    if (bestTau >= minTau) {
      peaks.push([bestTau, best]);
      if (best > maxVal) maxVal = best;
    }
  }
  const peak = peaks.find((p) => p[1] >= 0.9 * maxVal);
  if (!peak || peak[1] < minClarity) return none;

  let t = peak[0];
  if (t > 1 && t < maxTau) {
    const a = nsdf[t - 1]!;
    const b = nsdf[t]!;
    const c = nsdf[t + 1]!;
    const den = a - 2 * b + c;
    if (den) t += (0.5 * (a - c)) / den;
  }
  const f = sampleRate / t;
  if (f < 62 || f > 1100) return none;
  return { midi: freqToMidi(f), clarity: peak[1], rms };
}
