// The microphone into the capture worklet, which sends the take to the ear (ear/worker.ts);
// the ear tracks it as it comes, its frames return here for the live trace, and it hears the
// whole take when it stops.
import { audioContext } from "./audio";
import type { Entry, Frame, FromEar, ToEar } from "./ear/worker";

export type { Entry, Frame };

/** What the ear heard of a take. */
export type Heard = Extract<FromEar, { type: "heard" }>;

type Answer = Extract<FromEar, { id: number }>;

/** The ear's worker; one serves every take until it fails. */
class Ear {
  private worker = new Worker(new URL("./ear/worker.ts", import.meta.url), { type: "module" });
  private next = 0;
  /** The requests not yet answered, by id. */
  private waiting = new Map<number, { resolve: (m: Answer) => void; reject: (e: Error) => void }>();
  /** Why the worker failed, after which it answers nothing. */
  failed: Error | undefined;

  constructor(onFrames: (frames: Frame[]) => void) {
    this.worker.onmessage = (e: MessageEvent<FromEar>) => {
      const m = e.data;
      if (m.type === "frames") return onFrames(m.frames);
      const waiter = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.type === "error") waiter?.reject(new Error(m.message));
      else waiter?.resolve(m);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.failed = new Error(e.message || "the ear failed");
      for (const waiter of this.waiting.values()) waiter.reject(this.failed);
      this.waiting.clear();
      this.worker.terminate();
    };
  }

  /** Sends `request`, numbered, and resolves with its answer. */
  private ask<T extends Answer["type"]>(request: DistributiveOmit<ToEar, "id">, transfer: Transferable[] = []): Promise<Extract<Answer, { type: T }>> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (m: Answer) => void, reject });
      try {
        this.worker.postMessage({ ...request, id } as ToEar, transfer);
      } catch (error) {
        this.waiting.delete(id);
        reject(error as Error);
      }
    });
  }

  /** Starts a take at `sampleRate` heard through `audio`; resolves when the take has ended
   * and been heard. */
  start(sampleRate: number, audio: MessagePort): Promise<Heard> {
    return this.ask<"heard">({ type: "start", sampleRate, audio }, [audio]);
  }

  /** When the last take's first note starts, the note due `due` seconds into the take. */
  async entry(due: number): Promise<Entry> {
    return (await this.ask<"entry">({ type: "entry", due })).entry;
  }

  /** The last take scored and judged against `gabc`'s notes, `pulse` seconds a pulse, the
   * first starting `offset` seconds into the take, as JSON. */
  async judge(gabc: string, pulse: number, offset: number): Promise<string> {
    return (await this.ask<"judged">({ type: "judge", gabc, pulse, offset })).json;
  }

  /** The last take heard as a WAV file, and its length in seconds. */
  async audio(): Promise<{ wav: ArrayBuffer; seconds: number }> {
    const { wav, seconds } = await this.ask<"audio">({ type: "audio" });
    return { wav, seconds };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// The worklet is served as a module in dev and bundled as its own entry in the build.
const WORKLET_URL = import.meta.env.DEV ? "/src/worklet/processor.ts" : "/worklet.js";

export class Listener {
  listening = false;
  /** The frames of the take being sung, or of the last. */
  readonly frames: Frame[] = [];
  private stream: MediaStream | undefined;
  private nodes: AudioNode[] = [];
  private worklet: AudioWorkletNode | undefined;
  private module: Promise<void> | undefined;
  private ear: Ear | undefined;
  /** The ear's hearing of the take being sung, or of the last one. */
  heard: Promise<Heard> | undefined;
  /** How late the microphone's samples reach the page, in seconds, where the browser says. */
  inputLatency = 0;
  /** The last take's hearing, settled either way, which the next take waits for. */
  private last: Promise<unknown> = Promise.resolve();
  private generation = 0;

  /** `onFrame` hears each frame as it is tracked; `onFailed` hears why a take failed while it
   * was being sung, after which listening has stopped. */
  constructor(
    private readonly onFrame: (frame: Frame) => void,
    private readonly onFailed: (error: Error) => void,
  ) {}

  /** When the last take's first note starts, once it has been heard; see `Ear.entry`. */
  async entry(due: number): Promise<Entry> {
    if (!this.ear || !this.heard) throw new Error("nothing heard");
    await this.heard;
    return this.ear.entry(due);
  }

  /** The last take judged once it has been heard; see `Ear.judge`. */
  async judge(gabc: string, pulse: number, offset: number): Promise<string> {
    if (!this.ear || !this.heard) throw new Error("nothing heard");
    await this.heard;
    return this.ear.judge(gabc, pulse, offset);
  }

  /** The last take heard, as a file to send; see `Ear.audio`. */
  async audio(): Promise<{ wav: ArrayBuffer; seconds: number }> {
    if (!this.ear || !this.heard) throw new Error("nothing heard");
    await this.heard;
    return this.ear.audio();
  }

  async start(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.frames.length = 0;
    // Each start and stop moves the generation on; a start that finds it moved was stopped.
    const generation = ++this.generation;
    const stopped = () => generation !== this.generation;
    // The last take is heard before the next starts, so the ear hears one take at a time.
    const last = this.last;
    this.heard = undefined;
    let ctx: AudioContext;
    let stream: MediaStream;
    try {
      await last;
      ctx = await audioContext();
      this.module ??= ctx.audioWorklet.addModule(WORKLET_URL).catch((error: unknown) => {
        this.module = undefined;
        throw error;
      });
      await this.module;
      if (stopped()) return;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      // A start that was stopped gives up quietly.
      if (stopped()) return;
      this.listening = false;
      throw err;
    }
    if (stopped()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    let source: MediaStreamAudioSourceNode;
    let node: AudioWorkletNode;
    try {
      source = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, "capture");
    } catch (err) {
      this.stop();
      throw err;
    }
    const channel = new MessageChannel();
    if (this.ear?.failed) this.ear = undefined;
    this.ear ??= new Ear((frames) => {
      for (const frame of frames) {
        this.frames.push(frame);
        this.onFrame(frame);
      }
    });
    const heard = this.ear.start(ctx.sampleRate, channel.port2);
    this.heard = heard;
    this.last = heard.catch(() => undefined);
    heard.catch((error: Error) => {
      if (this.heard !== heard || !this.listening) return;
      this.stop();
      this.onFailed(error);
    });
    node.port.postMessage({ ear: channel.port1 }, [channel.port1]);
    // The node is pulled only when it reaches the destination; it outputs silence.
    source.connect(node).connect(ctx.destination);
    // Chrome reports the capture latency; the type does not list it.
    const latency = (stream.getAudioTracks()[0]?.getSettings() as { latency?: unknown } | undefined)?.latency;
    this.inputLatency = typeof latency === "number" && Number.isFinite(latency) ? latency : 0;
    this.nodes = [source, node];
    this.worklet = node;
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.generation++;
    this.worklet?.port.postMessage("stop");
    this.worklet = undefined;
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
}
