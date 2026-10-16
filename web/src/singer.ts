// The guide's singer: cantor-core's renderer (cantor.wasm) singing a list of notes on a voice
// table, either the neutral vowel it makes itself or a voice file of recorded vowels, which is
// private and loaded at runtime from a URL the page is given. `sing` renders the part a chunk
// at a time just ahead of the audio clock, so a long chant never schedules more than a couple
// of seconds at once. It needs no score or cursor, so any page can sing a list of notes.
import type { TimelineNote } from "neuma";

interface Exports {
  memory: WebAssembly.Memory;
  cantor_input(len: number): number;
  cantor_voice_new(): number;
  cantor_voice_neutral(): number;
  cantor_voice_centre(voice: number): number;
  cantor_part_new(gabcLen: number): number;
  cantor_part_free(part: number): void;
  cantor_part_length(part: number, sampleRate: number): number;
  cantor_sing(voice: number, part: number, sampleRate: number, from: number, len: number): number;
}

const WASM_URL = `${import.meta.env.BASE_URL}cantor.wasm`;
/** A chunk, and how far ahead of the clock chunks are rendered. */
const CHUNK = 0.5;
const AHEAD = 1.5;
const LEVEL = 0.25;

/** A note to sing: its pitch (MIDI), start and length in seconds, the indexes of the word and
 * syllable it belongs to, and the syllable's text. Notes of one syllable share its indexes. */
export interface SungNote {
  midi: number;
  start: number;
  duration: number;
  word: number;
  syllable: number;
  text: string;
}

/** A timeline's notes to sing: pulse `from` at 0 s, a pulse `pulse` seconds, pitches by
 * `midiOf(semitones)`. */
export function fromTimeline(
  notes: readonly TimelineNote[],
  pulse: number,
  midiOf: (semitones: number) => number,
  from = 0,
): SungNote[] {
  return notes.map((n) => ({
    midi: midiOf(n.semitones),
    start: (n.start - from) * pulse,
    duration: n.duration * pulse,
    word: n.word,
    syllable: n.syllable,
    text: n.syllableText,
  }));
}

/** The notes in the form cantor.wasm reads: one per line, MIDI, start and duration in
 * seconds, word and syllable indexes, and the syllable's text, tab-separated. */
export function notesText(notes: readonly SungNote[]): string {
  return notes
    .map((n) => [n.midi, n.start, n.duration, n.word, n.syllable, n.text.replace(/[\t\n]/g, " ")].join("\t"))
    .join("\n");
}

/** Whole octaves that bring `midis`' middle note nearest `centre`. */
export function octaveShift(midis: number[], centre: number): number {
  if (midis.length === 0) return 0;
  const sorted = [...midis].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)]!;
  return 12 * Math.round((centre - middle) / 12) || 0;
}

/** The chunks to render now: those starting before `horizon` samples, from `next` on, each
 * `size` samples long, the last cut at `total`. */
export function chunksDue(next: number, horizon: number, size: number, total: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let from = next; from < total && from < horizon; from += size) out.push([from, Math.min(size, total - from)]);
  return out;
}

/** A set of sung vowels to sing with. */
export class VoiceTable {
  private constructor(
    private readonly wasm: Exports,
    private readonly voice: number,
  ) {}

  /** The neutral voice: every syllable on one made vowel. */
  static async neutral(wasmUrl = WASM_URL): Promise<VoiceTable> {
    const wasm = await instantiate(fetchBytes(wasmUrl));
    return new VoiceTable(wasm, wasm.cantor_voice_neutral());
  }

  /** The voice file at `voiceUrl`, given up on after `timeoutMs`. */
  static async load(voiceUrl: string, wasmUrl = WASM_URL, timeoutMs = 20_000): Promise<VoiceTable> {
    const [wasm, file] = await Promise.all([
      instantiate(fetchBytes(wasmUrl)),
      fetchBytes(voiceUrl, AbortSignal.timeout(timeoutMs)),
    ]);
    write(wasm, new Uint8Array(file));
    const voice = wasm.cantor_voice_new();
    if (!voice) throw new Error(`${voiceUrl}: not a voice file`);
    return new VoiceTable(wasm, voice);
  }

  /** The pitch (MIDI) the voice is at home at. */
  get centre(): number {
    return this.wasm.cantor_voice_centre(this.voice);
  }

  /** A part to sing. `gabc` is read only for its `language:` header; without one the language
   * is guessed from its words, or, when it is empty, from the notes' own. */
  part(notes: readonly SungNote[], gabc = ""): Part {
    const g = new TextEncoder().encode(gabc);
    const n = new TextEncoder().encode(notesText(notes));
    const bytes = new Uint8Array(g.length + n.length);
    bytes.set(g);
    bytes.set(n, g.length);
    write(this.wasm, bytes);
    return new Part(this.wasm, this.voice, this.wasm.cantor_part_new(g.length));
  }
}

export class Part {
  constructor(
    private readonly wasm: Exports,
    private readonly voice: number,
    private handle: number,
  ) {}

  /** Samples the whole part lasts at `sampleRate`. */
  length(sampleRate: number): number {
    return this.wasm.cantor_part_length(this.handle, sampleRate);
  }

  /** `len` samples from sample `from`, a copy of the module's output. */
  sing(sampleRate: number, from: number, len: number): Float32Array<ArrayBuffer> {
    const ptr = this.wasm.cantor_sing(this.voice, this.handle, sampleRate, from, len);
    return new Float32Array(this.wasm.memory.buffer, ptr, len).slice();
  }

  free(): void {
    this.wasm.cantor_part_free(this.handle);
    this.handle = 0;
  }
}

export interface SingOptions {
  /** The voice table; the neutral one when omitted. */
  table?: VoiceTable;
  /** Read only for its language: a chant's GABC, or just `language: English;\n%%\n`. Without
   * a header the language is guessed from the notes' words. */
  gabc?: string;
  /** Where the voice goes; a gain at a comfortable level into the destination when omitted. */
  output?: AudioNode;
}

/** A part being sung; `stop` silences it. */
export class Singing {
  /** The chunks scheduled so far, as [from, length, RMS]. */
  readonly chunks: Array<[number, number, number]> = [];
  /** When the first sample plays, and when the voice has died away, on the audio clock. */
  readonly start: number;
  readonly end: number;
  private readonly nodes: AudioNode[] = [];
  private part: Part | null;
  private timer = 0;

  constructor(
    private readonly ctx: AudioContext,
    part: Part,
    output: AudioNode | undefined,
  ) {
    this.part = part;
    const rate = ctx.sampleRate;
    // Chunks start on whole sample frames counted from here, so they meet exactly.
    const frame0 = Math.ceil((ctx.currentTime + 0.05) * rate);
    const total = part.length(rate);
    this.start = frame0 / rate;
    this.end = (frame0 + total) / rate;
    let out = output;
    if (!out) {
      const gain = ctx.createGain();
      gain.gain.value = LEVEL;
      gain.connect(ctx.destination);
      this.nodes.push(gain);
      out = gain;
    }
    const size = Math.round(CHUNK * rate);
    let next = 0;
    const fill = () => {
      if (!this.part) return;
      const horizon = ctx.currentTime * rate - frame0 + AHEAD * rate;
      for (const [from, len] of chunksDue(next, horizon, size, total)) {
        const samples = this.part.sing(rate, from, len);
        const buffer = ctx.createBuffer(1, len, rate);
        buffer.copyToChannel(samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(out);
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
      if (next >= total) this.release();
    };
    fill();
    if (this.part) this.timer = window.setInterval(fill, (CHUNK * 1000) / 2);
  }

  /** Stops rendering and silences the voice, at once or once what is scheduled has played. */
  stop(letRing = false): void {
    this.release();
    const nodes = this.nodes.splice(0);
    const silence = () => nodes.forEach((node) => node.disconnect());
    const left = this.end - this.ctx.currentTime;
    if (letRing && left > 0) window.setTimeout(silence, left * 1000);
    else silence();
  }

  private release(): void {
    clearInterval(this.timer);
    this.part?.free();
    this.part = null;
  }
}

/** Sings `notes` (times in seconds from a moment from now) on the audio context. */
export async function sing(ctx: AudioContext, notes: readonly SungNote[], options: SingOptions = {}): Promise<Singing> {
  const table = options.table ?? (await neutralTable());
  return new Singing(ctx, table.part(notes, options.gabc), options.output);
}

let neutral: Promise<VoiceTable> | undefined;

/** The neutral voice table, loaded once for the page. */
export function neutralTable(): Promise<VoiceTable> {
  neutral ??= VoiceTable.neutral().catch((error: unknown) => {
    neutral = undefined;
    throw error;
  });
  return neutral;
}

async function fetchBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.arrayBuffer();
}

async function instantiate(module: Promise<ArrayBuffer>): Promise<Exports> {
  const { instance } = await WebAssembly.instantiate(await module, {});
  return instance.exports as unknown as Exports;
}

function write(wasm: Exports, bytes: Uint8Array): void {
  const ptr = wasm.cantor_input(bytes.length);
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
}
