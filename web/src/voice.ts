// A neutral-vowel guide voice: a band-limited sawtooth, a soft envelope per note, through
// the three formants of a schwa, so the guide sounds sung rather than played.
const FORMANTS = [
  { freq: 500, q: 6, gain: 1 },
  { freq: 1500, q: 10, gain: 0.45 },
  { freq: 2500, q: 14, gain: 0.2 },
];
const HARMONICS = 24;
const ATTACK = 0.025;
const RELEASE = 0.06;
const LEVEL = 1.6;

export class Voice {
  /** Notes go here; the formants and master gain follow. */
  readonly input: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly wave: PeriodicWave;

  constructor(
    private readonly ctx: BaseAudioContext,
    level = LEVEL,
  ) {
    const real = new Float32Array(HARMONICS + 1);
    const imag = new Float32Array(HARMONICS + 1);
    for (let k = 1; k <= HARMONICS; k++) imag[k] = 1 / k;
    this.wave = ctx.createPeriodicWave(real, imag);
    this.input = ctx.createGain();
    const master = ctx.createGain();
    master.gain.value = level;
    master.connect(ctx.destination);
    // A little of the source itself, low-passed, keeps the fundamental's body.
    const body = ctx.createBiquadFilter();
    body.type = "lowpass";
    body.frequency.value = 700;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.25;
    this.input.connect(body).connect(bodyGain).connect(master);
    this.nodes.push(this.input, master, body, bodyGain);
    for (const f of FORMANTS) {
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = f.freq;
      band.Q.value = f.q;
      const gain = ctx.createGain();
      gain.gain.value = f.gain * 3;
      this.input.connect(band).connect(gain).connect(master);
      this.nodes.push(band, gain);
    }
  }

  /** Sings `freq` from `start` to `end`, in the context's seconds. */
  note(freq: number, start: number, end: number): void {
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(this.wave);
    osc.frequency.value = freq;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(0.3, start + ATTACK);
    env.gain.setValueAtTime(0.3, Math.max(start + ATTACK, end - RELEASE));
    env.gain.linearRampToValueAtTime(0, end);
    osc.connect(env).connect(this.input);
    osc.start(start);
    osc.stop(end);
    osc.onended = () => env.disconnect();
  }

  /** Silences every note and lets the graph go. */
  close(): void {
    for (const node of this.nodes) node.disconnect();
  }
}
