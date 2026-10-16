// Plays the timeline as a guide voice (one oscillator per note, a soft envelope) and moves
// the cursor with it. One pulse is PULSE seconds; pauses keep their weight.
import { noteAtTime } from "neuma";
import { audioContext } from "./audio";
import type { Cursor } from "./cursor";
import { DO, midiToFreq } from "./notes";
import type { Score } from "./score";

export const PULSE = 0.5;
const ATTACK = 0.02;
const RELEASE = 0.08;
const LEVEL = 0.25;

export interface GuideOptions {
  /** Seconds, for the cursor; defaults to the audio context's clock. */
  clock?: () => number;
  onStop?: () => void;
}

export class Guide {
  playing = false;
  /** Ids of the notes the cursor has marked, in order. */
  readonly visited: number[] = [];
  private nodes: AudioNode[] = [];
  private frame = 0;

  constructor(
    private readonly score: Score,
    private readonly cursor: Cursor,
    private readonly options: GuideOptions = {},
  ) {}

  async play(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    const ctx = await audioContext();
    if (!this.playing) return;
    this.visited.length = 0;
    const master = ctx.createGain();
    master.gain.value = LEVEL;
    master.connect(ctx.destination);
    this.nodes = [master];
    const t0 = ctx.currentTime + 0.05;
    for (const note of this.score.timeline.notes) {
      const start = t0 + note.start * PULSE;
      const end = start + note.duration * PULSE;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = midiToFreq(DO + note.semitones);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(1, start + ATTACK);
      env.gain.setValueAtTime(1, Math.max(start + ATTACK, end - RELEASE));
      env.gain.linearRampToValueAtTime(0, end);
      osc.connect(env).connect(master);
      osc.start(start);
      osc.stop(end);
      this.nodes.push(osc, env);
    }
    const clock = this.options.clock ?? (() => ctx.currentTime);
    const origin = clock() + 0.05;
    const tick = () => {
      if (!this.playing) return;
      if (!this.follow((clock() - origin) / PULSE)) return this.stop();
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
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
