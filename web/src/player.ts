// Sings a run of a timeline's notes in the neutral-vowel voice and reports the sounding note
// as it goes. One pulse is `pulse` seconds; pauses keep their weight.
import { type TimelineNote, noteAtTime } from "neuma";
import { audioContext } from "./audio";
import { DO, midiToFreq } from "./notes";
import { Voice } from "./voice";

export interface PlayOptions {
  /** Seconds per pulse. */
  pulse: number;
  /** Semitones above the clef's do at C4. */
  transpose: number;
  /** Seconds, for following along; defaults to the audio context's clock. */
  clock?: () => number;
  onNote: (note: TimelineNote | null) => void;
  onStop: () => void;
}

export class Player {
  playing = false;
  /** The sound has been scheduled and the follower started. */
  started = false;
  private voice: Voice | undefined;
  private frame = 0;
  private options: PlayOptions | undefined;

  /** Plays `notes` (in timeline order, a contiguous run); stops what was playing. */
  async play(notes: TimelineNote[], options: PlayOptions): Promise<void> {
    this.stop();
    if (!notes.length) return options.onStop();
    this.playing = true;
    this.options = options;
    let ctx: AudioContext;
    try {
      ctx = await audioContext();
    } catch {
      if (this.options === options) this.stop();
      return;
    }
    if (!this.playing || this.options !== options) return;
    const voice = new Voice(ctx);
    this.voice = voice;
    const first = notes[0]!.start;
    const last = notes[notes.length - 1]!;
    const length = last.start + last.duration - first;
    const clock = options.clock ?? (() => ctx.currentTime);
    // The follower runs on the clock given; on the audio clock, behind by the output's latency.
    const origin = clock() + 0.05 + (options.clock ? 0 : ctx.outputLatency || 0);
    const t0 = ctx.currentTime + 0.05;
    for (const n of notes) {
      const start = t0 + (n.start - first) * options.pulse;
      // A hair of silence between notes on one pitch keeps the syllables apart.
      const end = start + n.duration * options.pulse - 0.012;
      voice.note(midiToFreq(DO + options.transpose + n.semitones), start, end);
    }
    const run = { notes: [...notes] };
    this.started = true;
    let shown: TimelineNote | null | undefined;
    const tick = () => {
      if (!this.playing || this.options !== options) return;
      const t = (clock() - origin) / options.pulse;
      if (t >= length) return this.stop();
      const note = t < 0 ? null : noteAtTime(run, first + t);
      if (note !== shown) options.onNote((shown = note));
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.started = false;
    cancelAnimationFrame(this.frame);
    this.voice?.close();
    this.voice = undefined;
    const options = this.options;
    this.options = undefined;
    options?.onNote(null);
    options?.onStop();
  }
}
