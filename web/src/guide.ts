// Plays the timeline as a guide voice and moves the cursor with it: one oscillator per note
// with a soft envelope, or, given a sampled voice, the chant sung on its vowels, rendered a
// chunk at a time ahead of the audio clock. One pulse is PULSE seconds; pauses keep their
// weight.
import { noteAtTime } from "neuma";
import { audioContext } from "./audio";
import type { Cursor } from "./cursor";
import { DO, midiToFreq } from "./notes";
import type { Score } from "./score";
import { chunksDue, notesText, octaveShift, type Part, type SampledVoice } from "./voice";

export const PULSE = 0.5;
const ATTACK = 0.02;
const RELEASE = 0.08;
const LEVEL = 0.25;
/** A sampled voice's chunk, and how far ahead of the clock chunks are rendered. */
const CHUNK = 0.5;
const AHEAD = 1.5;

export interface GuideOptions {
  /** Seconds, for the cursor; defaults to the audio context's clock. */
  clock?: () => number;
  onStop?: () => void;
  /** Sings on the chant's vowels with this voice; `gabc` gives the language. */
  voice?: { voice: SampledVoice; gabc: string };
}

export class Guide {
  playing = false;
  /** Ids of the notes the cursor has marked, in order. */
  readonly visited: number[] = [];
  /** The sampled voice's chunks scheduled in this play, as [from, length, RMS]. */
  readonly chunks: Array<[number, number, number]> = [];
  private nodes: AudioNode[] = [];
  private frame = 0;
  private part: Part | null = null;
  private timer = 0;

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
    // On a sample boundary, so chunks laid end to end meet exactly.
    const t0 = Math.ceil((ctx.currentTime + 0.05) * ctx.sampleRate) / ctx.sampleRate;
    if (this.options.voice) this.sing(ctx, master, t0, this.options.voice);
    else this.oscillate(ctx, master, t0);
    const clock = this.options.clock ?? (() => ctx.currentTime);
    const origin = clock() + 0.05;
    const tick = () => {
      if (!this.playing) return;
      if (!this.follow((clock() - origin) / PULSE)) return this.stop();
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  private oscillate(ctx: AudioContext, master: GainNode, t0: number): void {
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
  }

  /** Renders the part in chunks as the clock nears them, each a buffer started on time. */
  private sing(ctx: AudioContext, master: GainNode, t0: number, { voice, gabc }: { voice: SampledVoice; gabc: string }): void {
    const { timeline } = this.score;
    const shift = octaveShift(
      timeline.notes.map((n) => DO + n.semitones),
      voice.centre,
    );
    const part = voice.part(gabc, notesText(timeline, PULSE, (s) => DO + s + shift));
    this.part = part;
    this.chunks.length = 0;
    const rate = ctx.sampleRate;
    const total = part.length(rate);
    const size = Math.round(CHUNK * rate);
    let next = 0;
    const fill = () => {
      if (!this.playing || this.part !== part) return;
      const horizon = (ctx.currentTime - t0 + AHEAD) * rate;
      for (const [from, len] of chunksDue(next, horizon, size, total)) {
        const samples = part.sing(rate, from, len);
        const buffer = ctx.createBuffer(1, len, rate);
        buffer.copyToChannel(samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(master);
        src.start(t0 + from / rate);
        this.nodes.push(src);
        let energy = 0;
        for (const x of samples) energy += x * x;
        this.chunks.push([from, len, Math.sqrt(energy / len)]);
        next = from + len;
      }
    };
    fill();
    this.timer = window.setInterval(fill, (CHUNK * 1000) / 2);
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    clearInterval(this.timer);
    this.part?.free();
    this.part = null;
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
