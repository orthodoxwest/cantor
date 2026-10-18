// The singer's last take played back against the score, the cursor on each note where it was
// due in the take: from the audio the ear keeps for sending, decoded once by the page, through a
// buffer source and a gain. The whole take, or only a run of its notes, from a moment before the
// first. A chant's aligned recording plays back the same way, the cursor on each note where the
// recording sang it.
import type { Cursor, Voice } from "./cursor";
import type { Score } from "./score";
import { noteAt, type Timed } from "./timing";

const LEVEL = 0.9;
/** How fast a take stopped falls silent, in seconds. */
const FADE = 0.004;
/** How much of the take a run is heard from before its first note was due, and after its last
 * ended, in seconds: a singer may come in a little early or hold on. */
const BEFORE = 0.3;
const AFTER = 0.4;

export class Replay {
  playing = false;
  /** Ids of the notes the cursor has marked in the latest play, or since it was last moved, in
   * order. */
  readonly visited: number[] = [];
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private frame = 0;
  private timer = 0;
  /** Counts plays, so the cursor of one stopped does not go on. */
  private plays = 0;
  private end: ((finished: boolean) => void) | null = null;
  /** The play under way: its audio, the notes it follows from note `from`, the second of the
   * take it ends at, the second it was last sounded from, and the context's time at which the
   * take's second 0 would have sounded. */
  private now: {
    ctx: AudioContext;
    buffer: AudioBuffer;
    times: readonly Timed[];
    from: number;
    until: number;
    at: number;
    zero: number;
  } | null = null;

  constructor(
    private readonly score: Score,
    private readonly cursor: Cursor,
    private readonly onStop: () => void,
    /** Told, as the take plays, which note it is in (null in a pause or outside the notes
     * played) and how many seconds into the take; null once it has stopped. */
    private readonly onAt: (at: { note: number | null; t: number } | null) => void = () => {},
    /** Whose sound it plays, the cursor drawn in its colour. */
    private readonly voice: Exclude<Voice, "guide"> = "take",
  ) {}

  /** Plays `buffer`, a take whose notes were judged at `times` (in seconds of the take, as many
   * as were judged), or only the notes `range` of them; resolves when it has ended (true) or was
   * stopped (false). */
  play(ctx: AudioContext, buffer: AudioBuffer, times: readonly Timed[], range?: readonly [number, number]): Promise<boolean> {
    this.stop();
    const play = ++this.plays;
    this.playing = true;
    const [from, to] = range ?? [0, times.length - 1];
    const run = times.slice(0, to + 1);
    const first = run[from];
    const last = run.at(-1);
    // Seconds of the take heard: all of it, or the run with a moment either side.
    const begin = range && first ? Math.max(first.start - BEFORE, 0) : 0;
    const until = range && last ? Math.max(last.start + last.duration + AFTER, begin) : buffer.duration;
    this.now = { ctx, buffer, times: run, from, until, at: begin, zero: 0 };
    this.visited.length = 0;
    const ended = new Promise<boolean>((resolve) => (this.end = resolve));
    this.sound(play, begin);
    // The cursor shows what is heard: the take's sound reaches the ear late by the output's latency.
    const late = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    const step = () => {
      if (play !== this.plays || !this.now) return false;
      // Not before where it was sounded from, in the moment before it sounds.
      this.follow(run, from, Math.max(ctx.currentTime - this.now.zero - late, this.now.at));
      return true;
    };
    const tick = () => {
      if (step()) this.frame = requestAnimationFrame(tick);
    };
    this.timer = window.setInterval(step, 250);
    tick();
    return ended;
  }

  /** The first and last of the notes the play under way plays; null when none is. */
  get notes(): [number, number] | null {
    return this.now && [this.now.from, this.now.times.length - 1];
  }

  /** Goes on with the play under way from `t` seconds into the take, within what it plays, as
   * though it had been heard from there. */
  seek(t: number): void {
    const now = this.now;
    if (!this.playing || !now) return;
    const at = Math.min(Math.max(t, 0), now.until);
    this.fade();
    this.visited.length = 0;
    this.sound(this.plays, at);
  }

  stop(): void {
    this.halt(false);
  }

  /** Sounds the play under way, play `play`, from `at` seconds into the take to its end. */
  private sound(play: number, at: number): void {
    const now = this.now!;
    const { ctx } = now;
    const gain = ctx.createGain();
    gain.gain.value = LEVEL;
    gain.connect(ctx.destination);
    const source = ctx.createBufferSource();
    source.buffer = now.buffer;
    source.connect(gain);
    this.source = source;
    this.gain = gain;
    const startAt = ctx.currentTime + 0.05;
    now.zero = startAt - at;
    now.at = at;
    source.onended = () => {
      if (play === this.plays && this.source === source) this.halt(true);
    };
    source.start(startAt, at, Math.max(now.until - at, 0));
  }

  /** Lets the sound under way go, faded out in a few milliseconds rather than cut, so that it
   * does not click. */
  private fade(): void {
    const { source, gain } = this;
    this.source = this.gain = null;
    if (!source || !gain) return;
    const release = () => {
      source.disconnect();
      gain.disconnect();
    };
    const t = gain.context.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.setTargetAtTime(0, t, FADE);
    source.onended = release;
    source.stop(t + 8 * FADE);
  }

  private halt(finished: boolean): void {
    this.plays++;
    cancelAnimationFrame(this.frame);
    clearInterval(this.timer);
    if (finished) {
      this.source?.disconnect();
      this.gain?.disconnect();
      this.source = this.gain = null;
    } else this.fade();
    this.now = null;
    if (!this.playing) return;
    this.playing = false;
    this.cursor.hide();
    this.onAt(null);
    this.end?.(finished);
    this.end = null;
    this.onStop();
  }

  /** Puts the cursor where the take is, `t` seconds into it: on the note due then, at the bar in
   * a pause, hidden before note `from` and after the last of `times`; drawn in its voice's colour. */
  private follow(times: readonly Timed[], from: number, t: number): void {
    const first = times[from];
    const last = times.at(-1);
    if (!first || !last || t < first.start || t >= last.start + last.duration) {
      this.onAt({ note: null, t });
      return this.cursor.hide();
    }
    const i = Math.max(noteAt(times, t), 0);
    const at = times[i]!;
    const { timeline } = this.score;
    const bar = t >= at.start + at.duration ? timeline.pauses.find((p) => p.beforeNote === i + 1 && p.bar)?.bar : undefined;
    this.onAt({ note: t >= at.start + at.duration ? null : i, t });
    if (bar) return this.cursor.show(bar.cx, this.score.line(bar.line), null, this.voice);
    // The ear's notes are the score's; were they ever counted apart, the cursor goes.
    const note = timeline.notes[i];
    if (!note) return this.cursor.hide();
    if (this.visited.at(-1) !== note.id) this.visited.push(note.id);
    this.cursor.show(note.cx, this.score.line(note.line), note.id, this.voice);
  }
}
