// Sings a run of a timeline's notes with the guide's singer (see singer.ts) and reports the
// sounding note as it goes, at the times the practice page leads (timing.ts). One pulse is
// `pulse` seconds; pauses keep their weight.
import type { TimelineNote } from "neuma";
import { audioContext } from "./audio";
import { DO } from "./notes";
import { fromTimeline, neutralTable, sing, type Singing, type SungNote } from "./singer";
import { noteAt } from "./timing";

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
    let sung: SungNote[];
    try {
      ctx = await audioContext();
      const table = await neutralTable();
      if (!current()) return;
      const midi = (semitones: number) => DO + options.transpose + semitones;
      const onError = (error: unknown) => {
        console.error("pointer:", error);
        if (!current()) return;
        options.onError?.("The voice failed while singing. Press Play to try again.");
        this.stop();
      };
      sung = fromTimeline(notes, options.pulse, midi, notes[0]!.start);
      singing = await sing(ctx, sung, { table, gabc: GABC, onError });
    } catch (error) {
      console.error("pointer:", error);
      if (this.options !== options) return;
      options.onError?.("The voice could not be loaded, so nothing can be sung.");
      this.stop();
      return;
    }
    if (!current()) return singing.stop();
    this.singing = singing;
    const last = sung[sung.length - 1]!;
    const length = last.start + last.duration;
    const clock = options.clock ?? (() => ctx.currentTime);
    // The follower runs on the clock given, from when the singer's first sample plays; on the
    // audio clock, behind by the output's latency.
    const origin = clock() + (singing.start - ctx.currentTime) + (options.clock ? 0 : ctx.outputLatency || 0);
    this.started = true;
    let shown: TimelineNote | null | undefined;
    const tick = () => {
      if (!current()) return;
      const t = clock() - origin;
      if (t >= length) return this.stop(true);
      const i = noteAt(sung, t);
      // In a pause, no note sounds.
      const note = i >= 0 && t < sung[i]!.start + sung[i]!.duration ? notes[i]! : null;
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
