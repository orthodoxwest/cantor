// Sings a run of a timeline's notes with the guide's singer (see singer.ts) and reports the
// sounding note as it goes. One pulse is `pulse` seconds; pauses keep their weight.
import { type TimelineNote, noteAtTime } from "neuma";
import { audioContext } from "./audio";
import { DO } from "./notes";
import { fromTimeline, neutralTable, sing, type Singing } from "./singer";

/** The pointer sings English. */
const GABC = "language: English;\n%%\n";

export interface PlayOptions {
  /** Seconds per pulse. */
  pulse: number;
  /** Semitones above the clef's do at C4. */
  transpose: number;
  /** Seconds, for following along; defaults to the audio context's clock. */
  clock?: () => number;
  onNote: (note: TimelineNote | null) => void;
  onStop: () => void;
  /** Told why nothing could be sung, or why singing stopped, before onStop. */
  onError?: (message: string) => void;
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
      const midi = (semitones: number) => DO + options.transpose + semitones;
      const onError = (error: unknown) => {
        console.error("pointer:", error);
        if (!current()) return;
        options.onError?.("The voice failed while singing, so it stopped.");
        this.stop();
      };
      singing = await sing(ctx, fromTimeline(notes, options.pulse, midi, notes[0]!.start), { table, gabc: GABC, onError });
    } catch (error) {
      console.error("pointer:", error);
      if (this.options !== options) return;
      options.onError?.("The voice could not be loaded, so nothing can be sung.");
      this.stop();
      return;
    }
    if (!current()) return singing.stop();
    this.singing = singing;
    const first = notes[0]!.start;
    const last = notes[notes.length - 1]!;
    const length = last.start + last.duration - first;
    const clock = options.clock ?? (() => ctx.currentTime);
    // The follower runs on the clock given, from when the singer's first sample plays; on the
    // audio clock, behind by the output's latency.
    const origin = clock() + (singing.start - ctx.currentTime) + (options.clock ? 0 : ctx.outputLatency || 0);
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
