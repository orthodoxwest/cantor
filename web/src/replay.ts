// The singer's last take played back against the score, the cursor on each note where it was
// due in the take: from the audio the ear keeps for sending, through a buffer source and a gain.
import type { Cursor } from "./cursor";
import type { Score } from "./score";
import { noteAt, timed, type Timed } from "./timing";

const LEVEL = 0.9;
/** How fast a take stopped falls silent, in seconds. */
const FADE = 0.004;

export class Replay {
  playing = false;
  /** Ids of the notes the cursor has marked in the latest play, in order. */
  readonly visited: number[] = [];
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private frame = 0;
  private timer = 0;
  /** Counts plays, so one stopped while its audio is decoded does not go on. */
  private plays = 0;
  private end: ((finished: boolean) => void) | null = null;

  constructor(
    private readonly score: Score,
    private readonly cursor: Cursor,
    private readonly onStop: () => void,
  ) {}

  /** Plays `wav`, a take judged at `pulse` seconds a pulse with its pulse 0 at `offset` seconds
   * of the take; resolves when it has ended (true) or was stopped (false). */
  async play(ctx: AudioContext, wav: ArrayBuffer, pulse: number, offset: number): Promise<boolean> {
    this.stop();
    const play = ++this.plays;
    this.playing = true;
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(wav.slice(0));
    } catch (error) {
      if (play === this.plays) this.stop();
      throw error;
    }
    if (play !== this.plays) return false;
    const gain = ctx.createGain();
    gain.gain.value = LEVEL;
    gain.connect(ctx.destination);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    this.source = source;
    this.gain = gain;
    const times = timed(this.score.timeline.notes, pulse);
    this.visited.length = 0;
    const startAt = ctx.currentTime + 0.05;
    // The cursor shows what is heard: the take's sound reaches the ear late by the output's latency.
    const late = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    const ended = new Promise<boolean>((resolve) => (this.end = resolve));
    source.onended = () => {
      if (play === this.plays) this.halt(true);
    };
    source.start(startAt);
    const step = () => {
      if (play !== this.plays) return false;
      this.follow(times, ctx.currentTime - startAt - late - offset);
      return true;
    };
    const tick = () => {
      if (step()) this.frame = requestAnimationFrame(tick);
    };
    this.timer = window.setInterval(step, 250);
    tick();
    return ended;
  }

  stop(): void {
    this.halt(false);
  }

  private halt(finished: boolean): void {
    this.plays++;
    cancelAnimationFrame(this.frame);
    clearInterval(this.timer);
    const { source, gain } = this;
    if (source && gain) {
      const release = () => {
        source.disconnect();
        gain.disconnect();
      };
      if (finished) release();
      else {
        // Faded out in a few milliseconds rather than cut, so that it does not click.
        const t = gain.context.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.setTargetAtTime(0, t, FADE);
        source.onended = release;
        source.stop(t + 8 * FADE);
      }
    }
    this.source = this.gain = null;
    if (!this.playing) return;
    this.playing = false;
    this.cursor.hide();
    this.end?.(finished);
    this.end = null;
    this.onStop();
  }

  /** Puts the cursor where the take is, `t` seconds after its pulse 0: on the note due then, at
   * the bar in a pause, hidden before the first note and after the last. */
  private follow(times: readonly Timed[], t: number): void {
    const first = times[0];
    const last = times.at(-1);
    if (!first || !last || t < first.start || t >= last.start + last.duration) return this.cursor.hide();
    const i = Math.max(noteAt(times, t), 0);
    const at = times[i]!;
    const { timeline } = this.score;
    const bar = t >= at.start + at.duration ? timeline.pauses.find((p) => p.beforeNote === i + 1 && p.bar)?.bar : undefined;
    if (bar) return this.cursor.show(bar.cx, this.score.line(bar.line), null);
    const note = timeline.notes[i]!;
    if (this.visited.at(-1) !== note.id) this.visited.push(note.id);
    this.cursor.show(note.cx, this.score.line(note.line), note.id);
  }
}
