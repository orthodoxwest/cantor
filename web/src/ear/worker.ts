// The ear: ear.wasm (cantor-ear) in a worker, off the audio thread and the page's. The pitch
// worklet sends it the take a block at a time over a port of its own; the core tracks each
// frame as soon as its samples are in and the frames go to the page for the live trace, while
// SwiftF0 runs on the take behind it. When the worklet ends the take, the core listens to the
// whole of it with both, and the page may then ask for it judged against a chant, or for its
// audio as a file to send.
import { takeFile } from "../wav";

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
 * MIDI number) or null (also under the live floor, see cantor-core's listen), the clarity of
 * its period and its RMS. */
export interface Frame {
  t: number;
  midi: number | null;
  clarity: number;
  rms: number;
}

/** Numbers per frame in ear.wasm's frame buffer. */
const FRAME_FIELDS = 4;

/** What the page sends, each request numbered by `id`. */
export type ToEar =
  | { type: "start"; id: number; sampleRate: number; audio: MessagePort }
  | { type: "judge"; id: number; gabc: string; pulse: number; offset: number }
  | { type: "audio"; id: number };

/** What the worklet sends: a block of the take with the context time of its first sample, or
 * the take's end. */
export type Block = { t: number; samples: Float32Array } | { end: true };

/** What the ear sends back: frames as they are tracked; then the take heard (its length and
 * rate, frame count, first sound in seconds from its start, its first sample's time on the
 * audio clock (null when none came), the share of its length spent
 * hearing it as it came, and the milliseconds spent finishing it); then, when asked, the take
 * judged. Each answer, or the error in its place, carries the `id` of the request it answers. */
export type FromEar =
  | { type: "frames"; frames: Frame[] }
  | {
      type: "heard";
      id: number;
      seconds: number;
      sampleRate: number;
      frames: number;
      onset: number | null;
      startedAt: number | null;
      busy: number;
      stopMs: number;
    }
  | { type: "judged"; id: number; json: string }
  | { type: "audio"; id: number; wav: ArrayBuffer; seconds: number }
  | { type: "error"; id: number; message: string };

/** The longest gap in the audio filled with silence, in seconds; a longer one ends the take. */
const MAX_GAP_S = 10;

const WASM_URL = `${import.meta.env.BASE_URL}ear.wasm`;
let loading: Promise<Exports> | undefined;
/** The take being heard: its request and the port it arrives on. */
let hearing: { id: number; audio: MessagePort } | undefined;
let sampleRate = 0;
/** The context time of the take's first sample. */
let start: number | undefined;
let pushed = 0;
let trackMs = 0;
/** The take's samples as heard, silence filled in, kept (as 16-bit) to send when asked. */
let kept: Int16Array[] = [];

/** ear.wasm, loaded once; a load that fails is tried again on the next request. */
function load(): Promise<Exports> {
  if (loading) return loading;
  const loaded = WebAssembly.instantiateStreaming(fetch(WASM_URL), {}).then((r) => r.instance.exports as unknown as Exports);
  loaded.catch(() => {
    if (loading === loaded) loading = undefined;
  });
  return (loading = loaded);
}

// The worker's own scope, which lib.dom types as a window.
const scope = self as unknown as {
  postMessage(message: FromEar, transfer?: Transferable[]): void;
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

/** `samples` as 16-bit, the depth they are sent at. */
function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767);
  return out;
}

/** Adds `samples` to the take and sends the page the frames they complete. */
function push(ear: Exports, samples: Float32Array): void {
  // Each call may grow the memory, detaching its old buffer, so the buffer is read after.
  const at = ear.ear_samples(samples.length);
  new Float32Array(ear.memory.buffer, at, samples.length).set(samples);
  const began = performance.now();
  const n = check(ear, ear.ear_push(samples.length));
  trackMs += performance.now() - began;
  pushed += samples.length;
  kept.push(toInt16(samples));
  if (n === 0) return;
  const t0 = start ?? 0;
  const fieldsAt = ear.ear_frames();
  const fields = new Float32Array(ear.memory.buffer, fieldsAt, n * FRAME_FIELDS);
  const frames: Frame[] = [];
  for (let i = 0; i < fields.length; i += FRAME_FIELDS) {
    const midi = fields[i + 1]!;
    frames.push({ t: t0 + fields[i]!, midi: Number.isNaN(midi) ? null : midi, clarity: fields[i + 2]!, rms: fields[i + 3]! });
  }
  post({ type: "frames", frames });
}

function onBlock(ear: Exports, id: number, block: Block): void {
  if ("samples" in block) {
    start ??= block.t;
    // A stretch the worklet never heard (a dropped quantum) is silence, so later frames keep
    // their times.
    const gap = Math.round((block.t - start) * sampleRate) - pushed;
    if (gap > MAX_GAP_S * sampleRate) throw new Error(`the audio stopped for ${(gap / sampleRate).toFixed(1)} s`);
    if (gap > 0) push(ear, new Float32Array(gap));
    push(ear, block.samples);
    return;
  }
  endTake();
  const began = performance.now();
  const frames = check(ear, ear.ear_stop());
  const stopMs = performance.now() - began;
  const onset = ear.ear_onset();
  post({
    type: "heard",
    id,
    seconds: pushed / sampleRate,
    sampleRate,
    frames,
    onset: onset < 0 ? null : onset,
    startedAt: start ?? null,
    busy: pushed ? trackMs / 1000 / (pushed / sampleRate) : 0,
    stopMs,
  });
}

/** Stops hearing the take being heard. */
function endTake(): void {
  hearing?.audio.close();
  hearing = undefined;
}

/** Reports `error` as the answer to request `id`. A trap leaves the instance unusable (a
 * panic aborts mid-borrow), so the next request loads a fresh one. */
function failed(id: number, error: unknown): void {
  if (error instanceof WebAssembly.RuntimeError) loading = undefined;
  post({ type: "error", id, message: String(error instanceof Error ? error.message : error) });
}

scope.onmessage = async (e: MessageEvent<ToEar>) => {
  const message = e.data;
  try {
    const ear = await load();
    if (message.type === "start") {
      if (hearing) failed(hearing.id, new Error("another take started before this one ended"));
      endTake();
      check(ear, ear.ear_start(message.sampleRate));
      const take = { id: message.id, audio: message.audio };
      hearing = take;
      sampleRate = message.sampleRate;
      start = undefined;
      pushed = trackMs = 0;
      kept = [];
      take.audio.onmessage = (b: MessageEvent<Block>) => {
        if (hearing !== take) return;
        try {
          onBlock(ear, take.id, b.data);
        } catch (error) {
          endTake();
          failed(take.id, error);
        }
      };
    } else if (message.type === "audio") {
      if (hearing || pushed === 0) throw new Error("no take has been heard");
      const samples = new Float32Array(pushed);
      let at = 0;
      for (const block of kept) {
        for (let i = 0; i < block.length; i++) samples[at + i] = block[i]! / 32767;
        at += block.length;
      }
      const { wav } = takeFile(samples, sampleRate);
      scope.postMessage({ type: "audio", id: message.id, wav, seconds: pushed / sampleRate }, [wav]);
    } else {
      const gabc = new TextEncoder().encode(message.gabc);
      const at = ear.ear_bytes(gabc.length);
      new Uint8Array(ear.memory.buffer, at, gabc.length).set(gabc);
      const len = check(ear, ear.ear_judge(gabc.length, message.pulse, message.offset));
      post({ type: "judged", id: message.id, json: output(ear, len) });
    }
  } catch (error) {
    if (message.type === "start") message.audio.close();
    failed(message.id, error);
  }
};
