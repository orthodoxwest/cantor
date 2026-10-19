// A soft held tone on the reciting note, to sing against. It is a short buffer of whole
// cycles looped by one buffer source, faded in and out by a gain.

/** Each mode's final, as semitones above the clef's do, and its reciting note's interval above
 * the final (its dominant). */
const FINAL: Record<number, number> = { 1: 2, 2: 2, 3: 4, 4: 4, 5: 5, 6: 5, 7: 7, 8: 7 };
const DOMINANT: Record<number, number> = { 1: 7, 2: 3, 3: 8, 4: 5, 5: 7, 6: 4, 7: 7, 8: 5 };

const pc = (semitones: number) => ((semitones % 12) + 12) % 12;

/** A note as the drone reads it: on the staff (semitones above the clef's do), as sung (MIDI),
 * and whether it is recited. */
export interface DroneSource {
  semitones: number;
  midi: number;
  recitation: boolean;
}

/** The note to drone on, as MIDI, of `notes` in mode `mode` (1 to 8, or null when not known):
 * the mode's reciting note (written a fifth higher when the chant's body, up to note `bodyEnd`,
 * and the chant itself both end on the mode's final a fifth higher, so that a repeat cue after
 * a verse does not count), at the first recited note on it, or else where the chant sings it
 * nearest its middle. Without a mode, the first recited note, or the last note. Null with no
 * notes. */
export function droneNote(notes: readonly DroneSource[], mode: number | null, bodyEnd = notes.length - 1): number | null {
  const last = notes.at(-1);
  if (!last) return null;
  const final = mode === null ? undefined : FINAL[mode];
  if (final === undefined) return (notes.find((n) => n.recitation) ?? last).midi;
  // Sung pitch is staff pitch moved by one amount for the whole chant.
  const shift = last.midi - last.semitones;
  const fifthUp = [notes[bodyEnd] ?? last, last].every((n) => pc(n.semitones) === pc(final + 7));
  const dominant = pc(final + DOMINANT[mode!]! + (fifthUp ? 7 : 0));
  const recited = notes.find((n) => n.recitation && pc(n.semitones) === dominant);
  if (recited) return recited.midi;
  const sorted = notes.map((n) => n.semitones).sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)]!;
  // The dominant's octave nearest the middle.
  return middle + ((((dominant - middle) % 12) + 18) % 12) - 6 + shift;
}

/** The mode number of a header such as "viii", "8", "1g" or "IV E", or null. */
export function modeNumber(mode: string | null | undefined): number | null {
  const m = (mode ?? "").trim().toLowerCase();
  const digit = /^([1-8])(?![0-9])/.exec(m);
  if (digit) return Number(digit[1]);
  const roman = /^(viii|vii|vi|iv|v|iii|ii|i)(?![a-z])/.exec(m);
  return roman ? ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii"].indexOf(roman[1]!) + 1 : null;
}

/** Of a tone's loudness, the share of each partial from the first: soft, reedy, not a sine. */
const PARTIALS = [1, 0.35, 0.12, 0.05];
/** The tone's loudness at level 1, as the root of its mean square: its partials' over their
 * peak, which [`droneLoop`] scales it by. */
export const TONE_RMS = Math.sqrt(PARTIALS.reduce((sum, a) => sum + a * a, 0) / 2) / PARTIALS.reduce((a, b) => a + b, 0);
/** About how long the looped buffer lasts, in seconds. */
const LOOP = 1;
const LEVEL = 0.08;
const FADE_IN = 0.4;
const FADE_OUT = 0.25;
/** How fast the drone falls silent before a take, in seconds: at once, without a click. */
const CUT = 0.003;

/** One loop of the tone at `freq` Hz, `rate` samples a second: about [`LOOP`] long, its length
 * chosen to hold a whole number of cycles, so it loops without a seam and in tune. */
export function droneLoop(freq: number, rate: number): Float32Array<ArrayBuffer> {
  const cycles = Math.max(1, Math.round(freq * LOOP));
  const length = Math.round((cycles * rate) / freq);
  const peak = PARTIALS.reduce((a, b) => a + b, 0);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const phase = (2 * Math.PI * cycles * i) / length;
    let x = 0;
    PARTIALS.forEach((a, k) => (x += a * Math.sin((k + 1) * phase)));
    out[i] = x / peak;
  }
  return out;
}

/** The drone while it sounds; `stop` fades it out, or cuts it. */
export class Drone {
  /** Drones not yet silent, fading ones included. */
  static readonly sounding = new Set<Drone>();
  /** When it began, in the context's time. */
  readonly began: number;
  private readonly source: AudioBufferSourceNode;
  private readonly gain: GainNode;
  private fading = false;

  constructor(
    private readonly ctx: AudioContext,
    /** As MIDI, any fraction of a semitone. */
    readonly midi: number,
    level = LEVEL,
  ) {
    const freq = 440 * 2 ** ((midi - 69) / 12);
    const samples = droneLoop(freq, ctx.sampleRate);
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    this.gain = ctx.createGain();
    // Silent, should its schedule ever be cancelled before it begins.
    this.gain.gain.value = 0;
    const now = (this.began = ctx.currentTime);
    this.gain.gain.setValueAtTime(0, now);
    this.gain.gain.linearRampToValueAtTime(level, now + FADE_IN);
    this.gain.connect(ctx.destination);
    this.source = ctx.createBufferSource();
    this.source.buffer = buffer;
    this.source.loop = true;
    this.source.connect(this.gain);
    this.source.onended = () => this.release();
    this.source.start(now);
    Drone.sounding.add(this);
  }

  /** Silences every drone at once, fading ones too: a take is beginning. */
  static cutAll(): void {
    for (const drone of Drone.sounding) drone.stop(false);
  }

  /** Fades the drone out, or (`fade` false) silences it at once, even mid-fade. */
  stop(fade = true): void {
    if (!Drone.sounding.has(this) || (fade && this.fading)) return;
    this.fading = true;
    const now = this.ctx.currentTime;
    const g = this.gain.gain;
    // Held where it is, mid-ramp or not, so that what follows starts there without a step.
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now);
    else {
      const at = g.value;
      g.cancelScheduledValues(now);
      g.setValueAtTime(at, now);
    }
    if (fade) {
      g.linearRampToValueAtTime(0, now + FADE_OUT);
      this.source.stop(now + FADE_OUT);
      return;
    }
    g.setTargetAtTime(0, now, CUT);
    this.source.stop(now + 8 * CUT);
    // Out of the count at once, whenever the audio thread ends it.
    Drone.sounding.delete(this);
  }

  private release(): void {
    Drone.sounding.delete(this);
    this.source.disconnect();
    this.gain.disconnect();
  }
}
