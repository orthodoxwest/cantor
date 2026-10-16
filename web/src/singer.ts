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

/** A renderer and the voice loaded into it. A call that traps leaves the renderer's state
 * mid-use for good (it aborts without unwinding), so after one nothing more is asked of it. */
interface Renderer {
  wasm: Exports;
  voice: number;
  centre: number;
  trapped: boolean;
}

/** Calls into `r`, marking it trapped if the call throws. */
function call<T>(r: Renderer, f: (wasm: Exports) => T): T {
  try {
    return f(r.wasm);
  } catch (error) {
    r.trapped = true;
    throw error;
  }
}

/** A set of sung vowels to sing with. */
export class VoiceTable {
  private constructor(
    private renderer: Renderer,
    private readonly open: () => Promise<Renderer>,
  ) {}

  /** The neutral voice: every syllable on one made vowel. */
  static async neutral(wasmUrl = WASM_URL): Promise<VoiceTable> {
    const module = await compile(wasmUrl);
    const open = async () => renderer(await instantiate(module), (wasm) => wasm.cantor_voice_neutral());
    return new VoiceTable(await open(), open);
  }

  /** The voice file at `voiceUrl`, given up on after `timeoutMs`. */
  static async load(voiceUrl: string, wasmUrl = WASM_URL, timeoutMs = 20_000): Promise<VoiceTable> {
    const [module, file] = await Promise.all([compile(wasmUrl), fetchBytes(voiceUrl, AbortSignal.timeout(timeoutMs))]);
    const bytes = new Uint8Array(file);
    const open = async () =>
      renderer(await instantiate(module), (wasm) => {
        write(wasm, bytes);
        const voice = wasm.cantor_voice_new();
        if (!voice) throw new Error(`${voiceUrl}: not a voice file`);
        return voice;
      });
    return new VoiceTable(await open(), open);
  }

  /** The pitch (MIDI) the voice is at home at. */
  get centre(): number {
    return this.renderer.centre;
  }

  /** Replaces a renderer that has trapped with a fresh one, so the voice sings again. */
  async renew(): Promise<void> {
    if (this.renderer.trapped) this.renderer = await this.open();
  }

  /** A part to sing. `gabc` is read only for its `language:` header; without one the language
   * is guessed from its words, or, when it is empty, from the notes' own. */
  part(notes: readonly SungNote[], gabc = ""): Part {
    const g = new TextEncoder().encode(gabc);
    const n = new TextEncoder().encode(notesText(notes));
    const bytes = new Uint8Array(g.length + n.length);
    bytes.set(g);
    bytes.set(n, g.length);
    const r = this.renderer;
    return new Part(
      r,
      call(r, (wasm) => {
        write(wasm, bytes);
        return wasm.cantor_part_new(g.length);
      }),
    );
  }
}

export class Part {
  constructor(
    private readonly renderer: Renderer,
    private handle: number,
  ) {}

  /** Samples the whole part lasts at `sampleRate`. */
  length(sampleRate: number): number {
    return call(this.renderer, (wasm) => wasm.cantor_part_length(this.handle, sampleRate));
  }

  /** `len` samples from sample `from`, a copy of the module's output. */
  sing(sampleRate: number, from: number, len: number): Float32Array<ArrayBuffer> {
    const { voice } = this.renderer;
    const ptr = call(this.renderer, (wasm) => wasm.cantor_sing(voice, this.handle, sampleRate, from, len));
    return new Float32Array(this.renderer.wasm.memory.buffer, ptr, len).slice();
  }

  /** Lets the part go; a renderer that has trapped is left alone, to be replaced whole. */
  free(): void {
    const handle = this.handle;
    this.handle = 0;
    if (handle && !this.renderer.trapped) call(this.renderer, (wasm) => wasm.cantor_part_free(handle));
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
  /** Told when a chunk could not be sung after the start, once the voice is silenced; without
   * it the error is thrown. One that fails at the start rejects `sing` instead. */
  onError?: (error: unknown) => void;
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
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ctx: AudioContext,
    part: Part,
    output: AudioNode | undefined,
    onError?: (error: unknown) => void,
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
        this.nodes.push(src);
        src.buffer = buffer;
        src.connect(out);
        // A chunk rendered late (the page was busy) plays only what is still to come.
        const when = (frame0 + from) / rate;
        const late = Math.max(0, ctx.currentTime - when);
        src.start(when + late, late);
        let energy = 0;
        for (const x of samples) energy += x * x;
        this.chunks.push([from, len, Math.sqrt(energy / len)]);
        next = from + len;
      }
      if (next >= total) this.release();
    };
    // A chunk that cannot be sung (the renderer trapped, the audio graph refused it) silences
    // what is scheduled and lets the part go; the next `sing` replaces a trapped renderer.
    try {
      fill();
    } catch (error) {
      this.stop();
      throw error;
    }
    if (!this.part) return;
    this.timer = setInterval(() => {
      try {
        fill();
      } catch (error) {
        this.stop();
        if (!onError) throw error;
        onError(error);
      }
    }, (CHUNK * 1000) / 2);
  }

  /** Stops rendering and silences the voice, at once or once what is scheduled has played. */
  stop(letRing = false): void {
    const nodes = this.nodes.splice(0);
    const silence = () => nodes.forEach((node) => node.disconnect());
    const left = this.end - this.ctx.currentTime;
    if (letRing && left > 0) setTimeout(silence, left * 1000);
    else silence();
    this.release();
  }

  private release(): void {
    clearInterval(this.timer);
    const part = this.part;
    this.part = null;
    try {
      part?.free();
    } catch (error) {
      console.error("singer:", error);
    }
  }
}

/** Sings `notes` (times in seconds from a moment from now) on the audio context. */
export async function sing(ctx: AudioContext, notes: readonly SungNote[], options: SingOptions = {}): Promise<Singing> {
  const table = options.table ?? (await neutralTable());
  await table.renew();
  return new Singing(ctx, table.part(notes, options.gabc), options.output, options.onError);
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

async function compile(url: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await fetchBytes(url));
}

async function instantiate(module: WebAssembly.Module): Promise<Exports> {
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports as unknown as Exports;
}

/** A renderer for `wasm` with the voice `load` puts in it. */
function renderer(wasm: Exports, load: (wasm: Exports) => number): Renderer {
  const voice = load(wasm);
  return { wasm, voice, centre: wasm.cantor_voice_centre(voice), trapped: false };
}

function write(wasm: Exports, bytes: Uint8Array): void {
  const ptr = wasm.cantor_input(bytes.length);
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
}
