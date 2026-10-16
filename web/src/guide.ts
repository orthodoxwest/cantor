// Sings the timeline with the guide voice (see singer.ts) and moves the cursor with it. One
// pulse is PULSE seconds; pauses keep their weight.
import { noteAtTime } from "neuma";
import { audioContext } from "./audio";
import type { Cursor } from "./cursor";
import { DO } from "./notes";
import type { Score } from "./score";
import { fromTimeline, octaveShift, sing, type Singing, type VoiceTable } from "./singer";

export const PULSE = 0.5;

export interface GuideOptions {
  /** The voice table to sing with, and the chant's GABC, read for its language. */
  table: VoiceTable;
  gabc: string;
  /** Seconds, for the cursor; defaults to the audio context's clock. */
  clock?: () => number;
  onStop?: () => void;
  /** Told why the guide stopped when the voice could not sing, before onStop. */
  onError?: (message: string) => void;
}

export class Guide {
  playing = false;
  /** Ids of the notes the cursor has marked, in order. */
  readonly visited: number[] = [];
  private singing: Singing | null = null;
  private frame = 0;
  /** Counts plays, so a play stopped while it was starting does not go on. */
  private plays = 0;

  constructor(
    private readonly score: Score,
    private readonly cursor: Cursor,
    private readonly options: GuideOptions,
  ) {}

  /** The chunks scheduled in the latest play, as [from, length, RMS]. */
  get chunks(): Array<[number, number, number]> {
    return this.singing?.chunks ?? [];
  }

  async play(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    const play = ++this.plays;
    let ctx: AudioContext;
    let singing: Singing;
    try {
      ctx = await audioContext();
      if (!this.playing || play !== this.plays) return;
      const { timeline } = this.score;
      const { table, gabc } = this.options;
      // The chant moves by whole octaves to where the voice is at home.
      const shift = octaveShift(
        timeline.notes.map((n) => DO + n.semitones),
        table.centre,
      );
      const onError = (error: unknown) => this.fail(play, error);
      singing = await sing(ctx, fromTimeline(timeline.notes, PULSE, (s) => DO + s + shift), { table, gabc, onError });
    } catch (error) {
      return this.fail(play, error);
    }
    if (!this.playing || play !== this.plays) return singing.stop();
    this.singing = singing;
    this.visited.length = 0;
    const clock = this.options.clock ?? (() => ctx.currentTime);
    const origin = clock() + (singing.start - ctx.currentTime);
    const tick = () => {
      if (!this.playing) return;
      // At the end the voice is left to die away.
      if (!this.follow((clock() - origin) / PULSE)) return this.halt(true);
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    this.halt(false);
  }

  private fail(play: number, error: unknown): void {
    console.error("guide:", error);
    if (!this.playing || play !== this.plays) return;
    this.options.onError?.("The guide voice failed. Press Play to try again.");
    this.halt(false);
  }

  private halt(letRing: boolean): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.singing?.stop(letRing);
    this.cursor.hide();
    this.options.onStop?.();
  }

  /** Moves the cursor to pulse t; false once the timeline is over. */
  private follow(t: number): boolean {
    const { timeline } = this.score;
    if (t >= timeline.duration) return false;
    const note = noteAtTime(timeline, t);
    if (note) {
      if (this.visited[this.visited.length - 1] !== note.id) this.visited.push(note.id);
      this.cursor.show(note.cx, timeline.lines[note.line]!, note.id);
      return true;
    }
    const pause = timeline.pauses.find((p) => t >= p.start && t < p.start + p.duration);
    if (pause?.bar) this.cursor.show(pause.bar.cx, timeline.lines[pause.bar.line]!, null);
    return true;
  }
}
