// Captures the microphone for the ear (see ear/worker.ts): given a port to it, sends it the
// take a BLOCK at a time, each with the context time of its first sample, and on "stop" the
// rest and the take's end. It tracks nothing itself, so the audio thread never waits on the
// core.
import type { Block } from "../ear/worker";

const BLOCK = 1024;

class CaptureProcessor extends AudioWorkletProcessor {
  private stopped = false;
  private ear: MessagePort | undefined;
  private block = new Float32Array(BLOCK);
  private filled = 0;
  /** The context time of the block's first sample. */
  private t = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<"stop" | { ear: MessagePort }>) => {
      if (e.data === "stop") {
        this.stopped = true;
        this.send();
        this.ear?.postMessage({ end: true } satisfies Block);
      } else {
        this.ear = e.data.ear;
      }
    };
  }

  /** Sends the ear the samples collected since the last block. */
  private send(): void {
    if (!this.ear || this.filled === 0) return;
    const samples = this.block.slice(0, this.filled);
    this.ear.postMessage({ t: this.t, samples } satisfies Block, [samples.buffer]);
    this.filled = 0;
  }

  override process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input || !this.ear) return true;
    // After a quantum the worklet never heard, the block so far goes on its own, so every
    // block's samples are contiguous from its time.
    if (this.filled > 0 && Math.abs(currentTime - (this.t + this.filled / sampleRate)) > 0.5 / sampleRate) this.send();
    for (let i = 0; i < input.length; i++) {
      if (this.filled === 0) this.t = currentTime + i / sampleRate;
      this.block[this.filled++] = input[i]!;
      if (this.filled === BLOCK) this.send();
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
