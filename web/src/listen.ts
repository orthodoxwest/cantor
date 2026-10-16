// The microphone into the pitch worklet; frames come back on the main thread for the live
// trace, and the take goes on to the second ear (ear/worker.ts), which hears it with both
// trackers when it stops.
import { audioContext } from "./audio";
import type { FromEar, ToEar } from "./ear/worker";
import type { Frame } from "./worklet/processor";

export type { Frame };

/** What the second ear heard of a take. */
export type Heard = Extract<FromEar, { type: "heard" }>;

/** The second ear's worker; one serves every take. */
class Ear {
  private worker = new Worker(new URL("./ear/worker.ts", import.meta.url), { type: "module" });
  private waiting: Array<(m: FromEar) => void> = [];

  constructor() {
    this.worker.onmessage = (e: MessageEvent<FromEar>) => this.waiting.shift()?.(e.data);
  }

  private next<T extends FromEar["type"]>(type: T): Promise<Extract<FromEar, { type: T }>> {
    return new Promise((resolve, reject) =>
      this.waiting.push((m) => (m.type === type ? resolve(m as Extract<FromEar, { type: T }>) : reject(new Error(m.type === "error" ? m.message : m.type)))),
    );
  }

  /** Starts a take at `sampleRate` heard through `audio`; resolves when the take has ended
   * and been heard. */
  start(sampleRate: number, audio: MessagePort): Promise<Heard> {
    this.worker.postMessage({ type: "start", sampleRate, audio } satisfies ToEar, [audio]);
    return this.next("heard");
  }

  /** The last take scored and judged against `gabc`'s notes, `pulse` seconds a pulse, the
   * first starting `offset` seconds into the take, as JSON. */
  async judge(gabc: string, pulse: number, offset: number): Promise<string> {
    this.worker.postMessage({ type: "judge", gabc, pulse, offset } satisfies ToEar);
    return (await this.next("judged")).json;
  }
}

// The worklet is served as a module in dev and bundled as its own entry in the build.
const WORKLET_URL = import.meta.env.DEV ? "/src/worklet/processor.ts" : "/worklet.js";

export class Listener {
  listening = false;
  readonly frames: Frame[] = [];
  private stream: MediaStream | undefined;
  private nodes: AudioNode[] = [];
  private worklet: AudioWorkletNode | undefined;
  private module: Promise<void> | undefined;
  private ear: Ear | undefined;
  /** The second ear's hearing of the take being sung, or of the last one. */
  heard: Promise<Heard> | undefined;

  constructor(private readonly onFrame: (frame: Frame) => void) {}

  /** The last take judged by the second ear; see `Ear.judge`. */
  judge(gabc: string, pulse: number, offset: number): Promise<string> {
    if (!this.ear) return Promise.reject(new Error("nothing heard"));
    return this.ear.judge(gabc, pulse, offset);
  }

  async start(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    const ctx = await audioContext();
    this.module ??= ctx.audioWorklet.addModule(WORKLET_URL);
    await this.module;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      this.listening = false;
      throw err;
    }
    if (!this.listening) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    const source = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, "pitch");
    node.port.onmessage = (e: MessageEvent<Frame>) => {
      this.frames.push(e.data);
      this.onFrame(e.data);
    };
    const channel = new MessageChannel();
    this.ear ??= new Ear();
    this.heard = this.ear.start(ctx.sampleRate, channel.port2);
    node.port.postMessage({ ear: channel.port1 }, [channel.port1]);
    // The node is pulled only when it reaches the destination; it outputs silence.
    source.connect(node).connect(ctx.destination);
    this.nodes = [source, node];
    this.worklet = node;
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.worklet?.port.postMessage("stop");
    this.worklet = undefined;
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
}
