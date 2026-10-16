// The microphone into the pitch worklet; frames come back on the main thread.
import { audioContext } from "./audio";
import type { Frame } from "./worklet/processor";

export type { Frame };

// The worklet is served as a module in dev and bundled as its own entry in the build.
const WORKLET_URL = import.meta.env.DEV ? "/src/worklet/processor.ts" : "/worklet.js";

export class Listener {
  listening = false;
  readonly frames: Frame[] = [];
  private stream: MediaStream | undefined;
  private nodes: AudioNode[] = [];

  constructor(private readonly onFrame: (frame: Frame) => void) {}

  async start(): Promise<void> {
    if (this.listening) return;
    const ctx = await audioContext();
    await ctx.audioWorklet.addModule(WORKLET_URL);
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const source = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, "pitch");
    node.port.onmessage = (e: MessageEvent<Frame>) => {
      this.frames.push(e.data);
      this.onFrame(e.data);
    };
    // The node is pulled only when it reaches the destination; it outputs silence.
    source.connect(node).connect(ctx.destination);
    this.nodes = [source, node];
    this.listening = true;
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
}
