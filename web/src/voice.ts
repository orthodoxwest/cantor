// The guide voice: cantor-core's renderer (cantor.wasm) singing either the neutral vowel it
// makes itself or a voice file of recorded vowels, which is private and loaded at runtime
// from a URL the page is given. The page renders the part a chunk at a time, ahead of the
// audio clock.
import type { Timeline } from "neuma";

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

/** The notes in the form cantor.wasm reads: one per line, MIDI, start and duration in
 * seconds, word and syllable indexes, and the syllable's text, tab-separated. */
export function notesText(timeline: Timeline, pulse: number, midiOf: (semitones: number) => number): string {
  return timeline.notes
    .map((n) =>
      [midiOf(n.semitones), n.start * pulse, n.duration * pulse, n.word, n.syllable, n.syllableText.replace(/[\t\n]/g, " ")].join("\t"),
    )
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

export class Voice {
  private constructor(
    private readonly wasm: Exports,
    private readonly voice: number,
  ) {}

  /** The neutral voice: every syllable on one made vowel. */
  static async neutral(wasmUrl = WASM_URL): Promise<Voice> {
    const wasm = await instantiate(fetchBytes(wasmUrl));
    return new Voice(wasm, wasm.cantor_voice_neutral());
  }

  /** The voice file at `voiceUrl`. */
  static async load(voiceUrl: string, wasmUrl = WASM_URL): Promise<Voice> {
    const [wasm, file] = await Promise.all([instantiate(fetchBytes(wasmUrl)), fetchBytes(voiceUrl)]);
    write(wasm, new Uint8Array(file));
    const voice = wasm.cantor_voice_new();
    if (!voice) throw new Error(`${voiceUrl}: not a voice file`);
    return new Voice(wasm, voice);
  }

  /** The pitch (MIDI) the voice is at home at. */
  get centre(): number {
    return this.wasm.cantor_voice_centre(this.voice);
  }

  /** A part to sing: the GABC is read for its language, the notes are the timeline's. */
  part(gabc: string, notes: string): Part {
    const g = new TextEncoder().encode(gabc);
    const n = new TextEncoder().encode(notes);
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

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
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
