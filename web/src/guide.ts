// Sings the timeline with the guide voice and moves the cursor with it. The part is rendered
// a chunk at a time ahead of the audio clock, each chunk a buffer started on time, so a long
// chant never schedules more than a few seconds at once. One pulse is PULSE seconds; pauses
// keep their weight.
import { noteAtTime } from "neuma";
import { audioContext } from "./audio";
import type { Cursor } from "./cursor";
import { DO } from "./notes";
import type { Score } from "./score";
import { chunksDue, notesText, octaveShift, type Part, type Voice } from "./voice";

export const PULSE = 0.5;
const LEVEL = 0.25;
/** A chunk, and how far ahead of the clock chunks are rendered. */
const CHUNK = 0.5;
const AHEAD = 1.5;

export interface GuideOptions {
  /** The voice to sing with, and the chant's GABC, read for its language. */
  voice: Voice;
  gabc: string;
  /** Seconds, for the cursor; defaults to the audio context's clock. */
  clock?: () => number;
  onStop?: () => void;
}

export class Guide {
  playing = false;
  /** Ids of the notes the cursor has marked, in order. */
  readonly visited: number[] = [];
  /** The chunks scheduled in this play, as [from, length, RMS]. */
  readonly chunks: Array<[number, number, number]> = [];
  private nodes: AudioNode[] = [];
  private frame = 0;
  private part: Part | null = null;
  private timer = 0;
  /** When, on the audio clock, the last chunk ends. */
  private end = 0;

  constructor(
    private readonly score: Score,
    private readonly cursor: Cursor,
    private readonly options: GuideOptions,
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
    // Chunks start on whole sample frames counted from here, so they meet exactly.
    const frame0 = Math.ceil((ctx.currentTime + 0.05) * ctx.sampleRate);
    this.sing(ctx, master, frame0);
    const clock = this.options.clock ?? (() => ctx.currentTime);
    const origin = clock() + 0.05;
    const tick = () => {
      if (!this.playing) return;
      // At the end the voice is left to die away.
      if (!this.follow((clock() - origin) / PULSE)) return this.halt(Math.max(0, this.end - ctx.currentTime));
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  /** Renders the part in chunks as the clock nears them, each a buffer started on time. */
  private sing(ctx: AudioContext, master: GainNode, frame0: number): void {
    const { timeline } = this.score;
    const { voice, gabc } = this.options;
    const shift = octaveShift(
      timeline.notes.map((n) => DO + n.semitones),
      voice.centre,
    );
    const part = voice.part(gabc, notesText(timeline, PULSE, (s) => DO + s + shift));
    this.part = part;
    this.chunks.length = 0;
    const rate = ctx.sampleRate;
    const total = part.length(rate);
    this.end = (frame0 + total) / rate;
    const size = Math.round(CHUNK * rate);
    let next = 0;
    const fill = () => {
      if (!this.playing || this.part !== part) return;
      const horizon = ctx.currentTime * rate - frame0 + AHEAD * rate;
      for (const [from, len] of chunksDue(next, horizon, size, total)) {
        const samples = part.sing(rate, from, len);
        const buffer = ctx.createBuffer(1, len, rate);
        buffer.copyToChannel(samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(master);
        // A chunk rendered late (the page was busy) plays only what is still to come.
        const when = (frame0 + from) / rate;
        const late = Math.max(0, ctx.currentTime - when);
        src.start(when + late, late);
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
    this.halt(0);
  }

  /** Stops, leaving the audio `linger` seconds to finish. */
  private halt(linger: number): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    clearInterval(this.timer);
    this.part?.free();
    this.part = null;
    const nodes = this.nodes;
    this.nodes = [];
    const silence = () => nodes.forEach((node) => node.disconnect());
    if (linger > 0) window.setTimeout(silence, linger * 1000);
    else silence();
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
