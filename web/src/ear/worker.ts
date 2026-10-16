// The ear: ear.wasm (cantor-ear) in a worker, off the audio thread and the page's. The pitch
// worklet sends it the take a block at a time over a port of its own; the core tracks each
// frame as soon as its samples are in and the frames go to the page for the live trace. When
// the worklet ends the take, the core listens to the whole of it, and the page may then ask
// for it judged against a chant.

interface Exports {
  memory: WebAssembly.Memory;
  ear_samples(len: number): number;
  ear_bytes(len: number): number;
  ear_output(): number;
  ear_output_len(): number;
  ear_start(sampleRate: number): number;
  ear_push(len: number): number;
  ear_frames(): number;
  ear_stop(): number;
  ear_onset(): number;
  ear_judge(gabcLen: number, pulse: number, offset: number): number;
}

/** A tracked frame: its centre in seconds of the audio context's clock, the pitch heard (as a
 * MIDI number) or null, the clarity of its period and its RMS. */
export interface Frame {
  t: number;
  midi: number | null;
  clarity: number;
  rms: number;
}

/** Numbers per frame in ear.wasm's frame buffer. */
const FRAME_FIELDS = 4;

/** What the page sends. */
export type ToEar =
  | { type: "start"; sampleRate: number; audio: MessagePort }
  | { type: "judge"; gabc: string; pulse: number; offset: number };

/** What the worklet sends: a block of the take with the context time of its first sample, or
 * the take's end. */
export type Block = { t: number; samples: Float32Array } | { end: true };

/** What the ear sends back: frames as they are tracked; then the take heard (its length,
 * frame count, first sound in seconds from its start, and the milliseconds spent tracking a
 * frame and finishing the take); then, when asked, the take judged. */
export type FromEar =
  | { type: "frames"; frames: Frame[] }
  | { type: "heard"; seconds: number; frames: number; onset: number | null; msPerFrame: number; stopMs: number }
  | { type: "judged"; json: string }
  | { type: "error"; message: string };

const WASM_URL = `${import.meta.env.BASE_URL}ear.wasm`;
let loading: Promise<Exports> | undefined;
let sampleRate = 0;
/** The context time of the take's first sample. */
let start: number | undefined;
let pushed = 0;
let tracked = 0;
let trackMs = 0;

const load = (): Promise<Exports> =>
  (loading ??= WebAssembly.instantiateStreaming(fetch(WASM_URL), {}).then((r) => r.instance.exports as unknown as Exports));

// The worker's own scope, which lib.dom types as a window.
const scope = self as unknown as {
  postMessage(message: FromEar): void;
  onmessage: ((e: MessageEvent<ToEar>) => void) | null;
};
const post = (message: FromEar) => scope.postMessage(message);

/** The output buffer, `len` bytes of it unless given. */
function output(ear: Exports, len = ear.ear_output_len()): string {
  const at = ear.ear_output();
  return new TextDecoder().decode(new Uint8Array(ear.memory.buffer, at, len));
}

function check(ear: Exports, result: number): number {
  if (result < 0) throw new Error(output(ear));
  return result;
}

function onBlock(ear: Exports, block: Block): void {
  if ("samples" in block) {
    start ??= block.t;
    const { samples } = block;
    // Each call may grow the memory, detaching its old buffer, so the buffer is read after.
    const at = ear.ear_samples(samples.length);
    new Float32Array(ear.memory.buffer, at, samples.length).set(samples);
    const began = performance.now();
    const n = check(ear, ear.ear_push(samples.length));
    trackMs += performance.now() - began;
    tracked += n;
    pushed += samples.length;
    if (n === 0) return;
    const fieldsAt = ear.ear_frames();
    const fields = new Float32Array(ear.memory.buffer, fieldsAt, n * FRAME_FIELDS);
    const frames: Frame[] = [];
    for (let i = 0; i < fields.length; i += FRAME_FIELDS) {
      const midi = fields[i + 1]!;
      frames.push({ t: start + fields[i]!, midi: Number.isNaN(midi) ? null : midi, clarity: fields[i + 2]!, rms: fields[i + 3]! });
    }
    post({ type: "frames", frames });
    return;
  }
  const began = performance.now();
  const frames = check(ear, ear.ear_stop());
  const stopMs = performance.now() - began;
  const onset = ear.ear_onset();
  post({
    type: "heard",
    seconds: pushed / sampleRate,
    frames,
    onset: onset < 0 ? null : onset,
    msPerFrame: tracked ? trackMs / tracked : 0,
    stopMs,
  });
}

scope.onmessage = async (e: MessageEvent<ToEar>) => {
  const message = e.data;
  try {
    const ear = await load();
    if (message.type === "start") {
      sampleRate = message.sampleRate;
      start = undefined;
      pushed = tracked = trackMs = 0;
      check(ear, ear.ear_start(sampleRate));
      message.audio.onmessage = (b: MessageEvent<Block>) => {
        try {
          onBlock(ear, b.data);
        } catch (error) {
          post({ type: "error", message: String(error instanceof Error ? error.message : error) });
        }
      };
    } else {
      const gabc = new TextEncoder().encode(message.gabc);
      const at = ear.ear_bytes(gabc.length);
      new Uint8Array(ear.memory.buffer, at, gabc.length).set(gabc);
      const len = check(ear, ear.ear_judge(gabc.length, message.pulse, message.offset));
      post({ type: "judged", json: output(ear, len) });
    }
  } catch (error) {
    post({ type: "error", message: String(error instanceof Error ? error.message : error) });
  }
};
