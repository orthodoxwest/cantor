// Collects the input into a ring and runs the pitch detector every HOP samples, posting one
// frame per run to the main thread. Stand-in until the Rust core's wasm build replaces it.
import { detectPitch } from "../pitch";

const RING = 2048;
const HOP = 256;

/** What the worklet posts: time in seconds of the context's clock, then the detector's result. */
export interface Frame {
  t: number;
  midi: number | null;
  clarity: number;
  rms: number;
}

class PitchProcessor extends AudioWorkletProcessor {
  private ring = new Float32Array(RING);
  private frame = new Float32Array(RING);
  private write = 0;
  private sinceHop = 0;

  override process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.ring[this.write] = input[i]!;
      this.write = (this.write + 1) % RING;
    }
    this.sinceHop += input.length;
    if (this.sinceHop >= HOP) {
      this.sinceHop -= HOP;
      // Oldest sample first.
      this.frame.set(this.ring.subarray(this.write), 0);
      this.frame.set(this.ring.subarray(0, this.write), RING - this.write);
      const frame: Frame = { t: currentTime, ...detectPitch(this.frame, sampleRate) };
      this.port.postMessage(frame);
    }
    return true;
  }
}

registerProcessor("pitch", PitchProcessor);
