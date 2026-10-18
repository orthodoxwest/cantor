// A note of the take heard against the note it was judged against: its sustained part, where
// the judge read it, a few times over with a breath between, over a soft tone held where the
// judge put the note, in the octave it was held in. A note off pitch rubs against the tone; one
// on it sits in it.
import { Drone, TONE_RMS } from "./drone";
import type { Band } from "./ribbon";

/** The take's level as it plays back, as Yours plays it. */
const LEVEL = 0.9;
/** How loud the tone is under the note, as a share of the note's loudness as it plays: soft,
 * but to be heard through the voice, however near the microphone it was sung; and the levels it
 * keeps within. */
const UNDER = 0.5;
const SOFTEST = 0.01;
const LOUDEST = 0.2;
/** How long each time the note is heard comes in and goes, so that it does not click. */
const FADE = 0.012;
/** The breath between times, in seconds. */
const BREATH = 0.18;
/** How long the tone sounds before the note is first heard, in seconds: once it is there. */
const LEAD = 0.5;
/** About how long the times heard last together, in seconds; how many, at least and at most. */
const FILL = 2.4;
const LEAST = 3;
const MOST = 8;

/** Seconds of a note's sustained part too short to be heard against a tone. */
const SHORTEST = 0.05;

/** Of `bands`, a take's, the band of note `at`, which a place's words are of, where the note can
 * be heard against where it belonged: it was heard, and held long enough to hear; none for a
 * place that is a verse not heard (`kind`), whatever of it was. */
export function heldBand(bands: readonly Band[], at: number, kind: string | undefined): (Band & { target_midi: number }) | null {
  const band = bands.find((b) => b.index === at);
  if (kind === "verse-missing" || !band || band.target_midi == null || band.to_s - band.from_s < SHORTEST) return null;
  return { ...band, target_midi: band.target_midi };
}

/** The loudness of `channels`, a take's samples at `rate` a second, from second `from` to
 * `to`: the root of their mean square, over every channel; 0 for none. */
export function loudness(channels: readonly Float32Array[], rate: number, from: number, to: number): number {
  let sum = 0;
  let count = 0;
  const start = Math.max(Math.round(from * rate), 0);
  for (const samples of channels) {
    const end = Math.min(Math.round(to * rate), samples.length);
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
    count += Math.max(end - start, 0);
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/** The tone's level under a note of loudness `rms` ([`loudness`]) as it is heard back. */
export function toneLevel(rms: number): number {
  return Math.min(LOUDEST, Math.max(SOFTEST, (UNDER * LEVEL * rms) / TONE_RMS));
}

/** How many times a note held `seconds` is heard: about [`FILL`] seconds of it, a short note
 * more often than a long one. */
export function times(seconds: number): number {
  return Math.min(MOST, Math.max(LEAST, Math.ceil(FILL / Math.max(seconds, 0.01))));
}

export class Held {
  playing = false;
  /** The seconds of the take heard, how many times, and the tone's pitch and level, while it
   * plays; for the tests. */
  now: { from: number; to: number; midi: number; times: number; level: number } | null = null;
  private sources: Array<{ source: AudioBufferSourceNode; gain: GainNode }> = [];
  private tone: Drone | null = null;
  /** Counts plays, so the end of one stopped does not end the next. */
  private plays = 0;
  private end: ((finished: boolean) => void) | null = null;

  /** Plays seconds `from` to `to` of `buffer`, a take, [`times`] over, over a tone at `midi`;
   * resolves when it has ended (true) or was stopped (false). */
  play(ctx: AudioContext, buffer: AudioBuffer, from: number, to: number, midi: number): Promise<boolean> {
    this.stop();
    const play = ++this.plays;
    this.playing = true;
    const ended = new Promise<boolean>((resolve) => (this.end = resolve));
    const length = Math.max(Math.min(to, buffer.duration) - from, 0);
    const n = times(length);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const level = toneLevel(loudness(channels, buffer.sampleRate, from, from + length));
    this.now = { from, to: from + length, midi, times: n, level };
    this.tone = new Drone(ctx, midi, level);
    const first = this.tone.began + LEAD;
    for (let k = 0; k < n; k++) {
      const at = first + k * (length + BREATH);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(LEVEL, at + FADE);
      gain.gain.setValueAtTime(LEVEL, at + Math.max(length - FADE, FADE));
      gain.gain.linearRampToValueAtTime(0, at + length);
      gain.connect(ctx.destination);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        // Over once the last time heard has gone, the tone fading after it.
        if (k === n - 1 && play === this.plays) this.halt(true);
      };
      source.start(at, from, length);
      this.sources.push({ source, gain });
    }
    return ended;
  }

  stop(): void {
    this.halt(false);
  }

  private halt(finished: boolean): void {
    this.plays++;
    for (const { source, gain } of this.sources) {
      const t = gain.context.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setTargetAtTime(0, t, FADE / 4);
      try {
        source.stop(t + FADE);
      } catch {
        // Not started, or ended already.
      }
    }
    this.sources = [];
    this.tone?.stop();
    this.tone = null;
    this.now = null;
    if (!this.playing) return;
    this.playing = false;
    this.end?.(finished);
    this.end = null;
  }
}
