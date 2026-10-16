// Sings a run of a timeline's notes with the guide's singer (see singer.ts) and reports the
// sounding note as it goes. One pulse is `pulse` seconds; pauses keep their weight.
import { type TimelineNote, noteAtTime } from "neuma";
import { audioContext } from "./audio";
import { DO } from "./notes";
import { fromTimeline, neutralTable, octaveShift, sing, type Singing } from "./singer";

/** The pointer sings English. */
const GABC = "language: English;\n%%\n";

export interface PlayOptions {
  /** Seconds per pulse. */
  pulse: number;
  /** Semitones above where the voice is at home. */
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
  private singing: Singing | undefined;
  private frame = 0;
  private options: PlayOptions | undefined;

  /** Plays `notes` (in timeline order, a contiguous run); stops what was playing. */
  async play(notes: TimelineNote[], options: PlayOptions): Promise<void> {
    this.stop();
    if (!notes.length) return options.onStop();
    this.playing = true;
    this.options = options;
    const current = () => this.playing && this.options === options;
    let ctx: AudioContext;
    let singing: Singing;
    try {
      ctx = await audioContext();
      const table = await neutralTable();
      if (!current()) return;
      const first = notes[0]!.start;
      // The run moves by whole octaves to where the voice is at home, then by the pitch chosen.
      const shift = octaveShift(
        notes.map((n) => DO + n.semitones),
        table.centre,
      );
      const midi = (semitones: number) => DO + semitones + shift + options.transpose;
      singing = await sing(ctx, fromTimeline(notes, options.pulse, midi, first), { table, gabc: GABC });
    } catch (error) {
      console.error("pointer:", error);
      if (this.options === options) this.stop();
      return;
    }
    if (!current()) return singing.stop();
    this.singing = singing;
    const first = notes[0]!.start;
    const last = notes[notes.length - 1]!;
    const length = last.start + last.duration - first;
    const clock = options.clock ?? (() => ctx.currentTime);
    // The follower runs on the clock given, from when the singer's first sample plays.
    const origin = clock() + (singing.start - ctx.currentTime);
    const run = { notes: [...notes] };
    this.started = true;
    let shown: TimelineNote | null | undefined;
    const tick = () => {
      if (!current()) return;
      const t = (clock() - origin) / options.pulse;
      if (t >= length) return this.stop(true);
      const note = t < 0 ? null : noteAtTime(run, first + t);
      if (note !== shown) options.onNote((shown = note));
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Stops singing, at once or (at the end of the run) letting the last note die away. */
  stop(letRing = false): void {
    if (!this.playing) return;
    this.playing = false;
    this.started = false;
    cancelAnimationFrame(this.frame);
    this.singing?.stop(letRing);
    this.singing = undefined;
    const options = this.options;
    this.options = undefined;
    options?.onNote(null);
    options?.onStop();
  }
}
