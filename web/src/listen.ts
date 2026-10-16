// The microphone into the capture worklet, which sends the take to the ear (ear/worker.ts);
// the ear tracks it as it comes, its frames return here for the live trace, and it hears the
// whole take when it stops.
import { audioContext } from "./audio";
import type { Frame, FromEar, Pending, ToEar } from "./ear/worker";

export type { Frame };

/** What the ear heard of a take. */
export type Heard = Extract<FromEar, { type: "heard" }>;

/** The ear's worker; one serves every take. */
class Ear {
  private worker = new Worker(new URL("./ear/worker.ts", import.meta.url), { type: "module" });
  /** What waits on the worker: at most one take heard and one judging. */
  private waiting: { [K in Pending]?: { resolve: (m: Extract<FromEar, { type: K }>) => void; reject: (e: Error) => void } } = {};

  constructor(onFrames: (frames: Frame[]) => void) {
    this.worker.onmessage = (e: MessageEvent<FromEar>) => {
      const m = e.data;
      if (m.type === "frames") return onFrames(m.frames);
      if (m.type === "error") {
        if (m.for) this.settle(m.for)?.reject(new Error(m.message));
        else console.error("ear:", m.message);
        return;
      }
      if (m.type === "heard") this.settle("heard")?.resolve(m);
      else this.settle("judged")?.resolve(m);
    };
    // The worker failed to load or run: nothing it was asked will be answered.
    this.worker.onerror = (e) => {
      for (const kind of ["heard", "judged"] as const) this.settle(kind)?.reject(new Error(e.message || "the ear failed"));
    };
  }

  private settle<K extends Pending>(kind: K) {
    const waiter = this.waiting[kind];
    delete this.waiting[kind];
    return waiter;
  }

  private wait<K extends Pending>(kind: K): Promise<Extract<FromEar, { type: K }>> {
    this.settle(kind)?.reject(new Error(`superseded by another ${kind === "heard" ? "take" : "judging"}`));
    return new Promise((resolve, reject) => {
      (this.waiting as Record<K, unknown>)[kind] = { resolve, reject };
    });
  }

  /** Starts a take at `sampleRate` heard through `audio`; resolves when the take has ended
   * and been heard. */
  start(sampleRate: number, audio: MessagePort): Promise<Heard> {
    const heard = this.wait("heard");
    this.worker.postMessage({ type: "start", sampleRate, audio } satisfies ToEar, [audio]);
    return heard;
  }

  /** The last take scored and judged against `gabc`'s notes, `pulse` seconds a pulse, the
   * first starting `offset` seconds into the take, as JSON. */
  async judge(gabc: string, pulse: number, offset: number): Promise<string> {
    const judged = this.wait("judged");
    this.worker.postMessage({ type: "judge", gabc, pulse, offset } satisfies ToEar);
    return (await judged).json;
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
  /** The ear's hearing of the take being sung, or of the last one. */
  heard: Promise<Heard> | undefined;

  constructor(private readonly onFrame: (frame: Frame) => void) {}

  /** The last take judged once it has been heard; see `Ear.judge`. */
  async judge(gabc: string, pulse: number, offset: number): Promise<string> {
    if (!this.ear || !this.heard) throw new Error("nothing heard");
    await this.heard;
    return this.ear.judge(gabc, pulse, offset);
  }

  async start(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.heard = undefined;
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
    const node = new AudioWorkletNode(ctx, "capture");
    const channel = new MessageChannel();
    this.ear ??= new Ear((frames) => {
      for (const frame of frames) {
        this.frames.push(frame);
        this.onFrame(frame);
      }
    });
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
