// Sings the timeline with the guide voice (see singer.ts) and moves the cursor with it, or
// moves the cursor alone. Notes fall at the core's times (timing.ts), `pulse` seconds a pulse.
import { audioContext } from "./audio";
import type { Cursor } from "./cursor";
import { DO } from "./notes";
import type { Score } from "./score";
import { octaveShift, sing, type Singing, type SungNote, type VoiceTable } from "./singer";
import { noteAt, timed, type Timed } from "./timing";

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

/** How a play goes: with the voice or the cursor alone, and how long the cursor waits on the
 * first note before it moves, in seconds. */
export interface PlayOptions {
  voice?: boolean;
  lead?: number;
}

/** A play under way: when its first note is due on the audio clock, and whether it ran to
 * the end (true) or was stopped (false). */
export interface Started {
  origin: number;
  ended: Promise<boolean>;
}

export class Guide {
  playing = false;
  /** Seconds a pulse. */
  pulse = PULSE;
  /** Ids of the notes the cursor has marked, in order. */
  readonly visited: number[] = [];
  private singing: Singing | null = null;
  private frame = 0;
  /** Counts plays, so a play stopped while it was starting does not go on. */
  private plays = 0;
  private times: Timed[] = [];
  private end: ((finished: boolean) => void) | null = null;

  constructor(
    private readonly score: Score,
    private readonly cursor: Cursor,
    private readonly options: GuideOptions,
  ) {}

  /** The chunks scheduled in the latest play, as [from, length, RMS]. */
  get chunks(): Array<[number, number, number]> {
    return this.singing?.chunks ?? [];
  }

  /** The chant's GABC, read for the voice's language. */
  set gabc(gabc: string) {
    this.options.gabc = gabc;
  }

  /** The notes to sing: the timeline at the core's times, moved by whole octaves to where
   * the voice is at home. */
  notes(): SungNote[] {
    const { notes } = this.score.timeline;
    const shift = octaveShift(
      notes.map((n) => DO + n.semitones),
      this.options.table.centre,
    );
    return timed(notes, this.pulse).map((at, i) => {
      const n = notes[i]!;
      return { midi: DO + n.semitones + shift, start: at.start, duration: at.duration, word: n.word, syllable: n.syllable, text: n.syllableText };
    });
  }

  /** Plays the chant, sung (unless `voice` is false) and followed by the cursor; resolves
   * once it has started, or with null if it did not. */
  async play({ voice = true, lead = 0 }: PlayOptions = {}): Promise<Started | null> {
    if (this.playing) return null;
    this.playing = true;
    const play = ++this.plays;
    let ctx: AudioContext;
    let singing: Singing | null = null;
    try {
      ctx = await audioContext();
      if (!this.playing || play !== this.plays) return null;
      const { table, gabc } = this.options;
      const onError = (error: unknown) => this.fail(play, error);
      if (voice) singing = await sing(ctx, this.notes().map((n) => ({ ...n, start: n.start + lead })), { table, gabc, onError });
    } catch (error) {
      this.fail(play, error);
      return null;
    }
    if (!this.playing || play !== this.plays) {
      singing?.stop();
      return null;
    }
    this.singing = singing;
    this.visited.length = 0;
    this.times = timed(this.score.timeline.notes, this.pulse);
    const origin = (singing?.start ?? ctx.currentTime) + lead;
    const clock = this.options.clock ?? (() => ctx.currentTime);
    const zero = clock() + (origin - ctx.currentTime);
    const ended = new Promise<boolean>((resolve) => (this.end = resolve));
    const tick = () => {
      if (!this.playing) return;
      // At the end the voice is left to die away.
      if (!this.follow(Math.max(clock() - zero, 0))) return this.halt(true);
      this.frame = requestAnimationFrame(tick);
    };
    tick();
    return { origin, ended };
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

  private halt(finished: boolean): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.singing?.stop(finished);
    this.cursor.hide();
    this.end?.(finished);
    this.end = null;
    this.options.onStop?.();
  }

  /** Moves the cursor to `t` seconds into the chant; false once it is over. */
  private follow(t: number): boolean {
    const { timeline } = this.score;
    const last = this.times.at(-1);
    if (!last || t >= last.start + last.duration) return false;
    const i = Math.max(noteAt(this.times, t), 0);
    const at = this.times[i]!;
    const note = timeline.notes[i]!;
    // In the pause after a note, the cursor stands at the bar if one is drawn for it.
    const bar = t >= at.start + at.duration ? timeline.pauses.find((p) => p.beforeNote === i + 1 && p.bar)?.bar : undefined;
    if (bar) {
      this.cursor.show(bar.cx, this.score.line(bar.line), null);
      return true;
    }
    if (this.visited[this.visited.length - 1] !== note.id) this.visited.push(note.id);
    this.cursor.show(note.cx, this.score.line(note.line), note.id);
    return true;
  }
}
