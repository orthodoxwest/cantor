// A synthetic voice file for tests: five vowels made of harmonics shaped by textbook
// formants, in cantor-core's voice file format. No recording is involved.
const RATE = 24000;
const MIDI = 55;
const VOWELS = {
  AA: [700, 1150, 2500],
  EH: [550, 1800, 2500],
  IY: [300, 2300, 3000],
  OW: [450, 850, 2400],
  UW: [320, 800, 2300],
};

export function makeVoice() {
  const f0 = 440 * 2 ** ((MIDI - 69) / 12);
  const n = Math.round(0.3 * RATE);
  const period = RATE / f0;
  const marks = [];
  for (let k = 1; k * period < n - 1; k++) marks.push(Math.round(k * period));
  const parts = [];
  const head = Buffer.alloc(12);
  head.write("CVOX", 0);
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(Object.keys(VOWELS).length, 6);
  head.writeUInt32LE(RATE, 8);
  parts.push(head);
  for (const [name, formants] of Object.entries(VOWELS)) {
    const unit = Buffer.alloc(1 + name.length + 12 + marks.length * 4 + n * 2);
    let at = unit.writeUInt8(name.length, 0);
    at += unit.write(name, at);
    at = unit.writeFloatLE(MIDI, at);
    at = unit.writeUInt32LE(marks.length, at);
    at = unit.writeUInt32LE(n, at);
    for (const m of marks) at = unit.writeUInt32LE(m, at);
    const wave = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let k = 1; k * f0 < RATE / 2; k++) {
        let amp = 1 / k;
        for (const fc of formants) amp /= Math.sqrt(1 + ((k * f0 - fc) / 60) ** 2);
        wave[i] += amp * Math.cos((2 * Math.PI * k * f0 * i) / RATE);
      }
    }
    // Peak at half scale.
    const peak = wave.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    for (const v of wave) at = unit.writeInt16LE(Math.round((v / peak) * 16384), at);
    parts.push(unit);
  }
  return Buffer.concat(parts);
}
