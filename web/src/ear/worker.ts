// The second ear: ear.wasm (cantor-ear) in a worker, off the audio thread and the page's.
// The pitch worklet sends it the take a block at a time over a port of its own, and SwiftF0
// tracks the blocks as they come; when the worklet ends the take, the core listens to it with
// both trackers, and the page may then ask for it judged against a chant.

interface Exports {
  memory: WebAssembly.Memory;
  ear_samples(len: number): number;
  ear_bytes(len: number): number;
  ear_output(): number;
  ear_output_len(): number;
  ear_start(sampleRate: number): number;
  ear_push(len: number): number;
  ear_stop(): number;
  ear_onset(): number;
  ear_judge(gabcLen: number, pulse: number, offset: number): number;
}

/** What the page sends. */
export type ToEar =
  | { type: "start"; sampleRate: number; audio: MessagePort }
  | { type: "judge"; gabc: string; pulse: number; offset: number };

/** What the worklet sends: a block of the take, or its end. */
export type Block = Float32Array | { end: true };

/** What the ear sends back. */
export type FromEar =
  | { type: "heard"; seconds: number; frames: number; onset: number | null; swiftFrames: number; swiftMs: number }
  | { type: "judged"; json: string }
  | { type: "error"; message: string };

const WASM_URL = `${import.meta.env.BASE_URL}ear.wasm`;
let loading: Promise<Exports> | undefined;
let sampleRate = 0;
let pushed = 0;
let swiftFrames = 0;
let swiftMs = 0;

const load = (): Promise<Exports> =>
  (loading ??= WebAssembly.instantiateStreaming(fetch(WASM_URL), {}).then((r) => r.instance.exports as unknown as Exports));

// The worker's own scope, which lib.dom types as a window.
const scope = self as unknown as {
  postMessage(message: FromEar): void;
  onmessage: ((e: MessageEvent<ToEar>) => void) | null;
};
const post = (message: FromEar) => scope.postMessage(message);

function output(ear: Exports): string {
  return new TextDecoder().decode(new Uint8Array(ear.memory.buffer, ear.ear_output(), ear.ear_output_len()));
}

function check(ear: Exports, result: number): number {
  if (result < 0) throw new Error(output(ear));
  return result;
}

function onBlock(ear: Exports, block: Block): void {
  if (block instanceof Float32Array) {
    new Float32Array(ear.memory.buffer, ear.ear_samples(block.length), block.length).set(block);
    const started = performance.now();
    const frames = check(ear, ear.ear_push(block.length));
    if (frames > swiftFrames) swiftMs += performance.now() - started;
    swiftFrames = frames;
    pushed += block.length;
    return;
  }
  const frames = check(ear, ear.ear_stop());
  const onset = ear.ear_onset();
  post({ type: "heard", seconds: pushed / sampleRate, frames, onset: onset < 0 ? null : onset, swiftFrames, swiftMs });
}

scope.onmessage = async (e: MessageEvent<ToEar>) => {
  const message = e.data;
  try {
    const ear = await load();
    if (message.type === "start") {
      sampleRate = message.sampleRate;
      pushed = swiftFrames = swiftMs = 0;
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
      new Uint8Array(ear.memory.buffer, ear.ear_bytes(gabc.length), gabc.length).set(gabc);
      const len = check(ear, ear.ear_judge(gabc.length, message.pulse, message.offset));
      post({ type: "judged", json: new TextDecoder().decode(new Uint8Array(ear.memory.buffer, ear.ear_output(), len)) });
    }
  } catch (error) {
    post({ type: "error", message: String(error instanceof Error ? error.message : error) });
  }
};
