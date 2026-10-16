import type { TimelineNote } from "neuma";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunksDue, fromTimeline, notesText, octaveShift, Part, Singing } from "../src/singer";

describe("fromTimeline and notesText", () => {
  it("time a run from its first pulse and write one tab-separated line per note", () => {
    const run = [
      { semitones: 7, start: 4, duration: 1, word: 3, syllable: 5, syllableText: "Al" },
      { semitones: 9, start: 5, duration: 2, word: 3, syllable: 6, syllableText: "le\tlu" },
    ] as unknown as TimelineNote[];
    const notes = fromTimeline(run, 0.5, (s) => 48 + s, 4);
    expect(notes[1]).toEqual({ midi: 57, start: 0.5, duration: 1, word: 3, syllable: 6, text: "le\tlu" });
    expect(notesText(notes)).toBe("55\t0\t0.5\t3\t5\tAl\n57\t0.5\t1\t3\t6\tle lu");
  });
});

describe("octaveShift", () => {
  it("moves the middle note by whole octaves toward the voice", () => {
    expect(octaveShift([60, 62, 67], 55)).toBe(-12);
    expect(octaveShift([55, 57], 55)).toBe(0);
    expect(octaveShift([40, 41, 43], 55)).toBe(12);
    expect(octaveShift([], 55)).toBe(0);
  });
});

describe("chunksDue", () => {
  it("covers the part once, chunk by chunk, up to the horizon", () => {
    expect(chunksDue(0, 250, 100, 1000)).toEqual([
      [0, 100],
      [100, 100],
      [200, 100],
    ]);
    expect(chunksDue(300, 250, 100, 1000)).toEqual([]);
    expect(chunksDue(900, 5000, 100, 950)).toEqual([[900, 50]]);
  });
});

describe("Singing", () => {
  // A part 4 s long at 8 kHz whose renderer traps on its `failAt`th chunk, on an audio context
  // that records what is scheduled. The first fill schedules three chunks.
  function setup(failAt: number) {
    let calls = 0;
    const freed: number[] = [];
    const wasm = {
      memory: new WebAssembly.Memory({ initial: 1 }),
      cantor_part_length: () => 32_000,
      cantor_sing: () => {
        if (++calls === failAt) throw new WebAssembly.RuntimeError("unreachable");
        return 0;
      },
      cantor_part_free: (handle: number) => freed.push(handle),
    };
    const node = () => ({ disconnected: false, connect: (n: unknown) => n, disconnect() { this.disconnected = true; } });
    const sources: Array<ReturnType<typeof node>> = [];
    const ctx = {
      sampleRate: 8000,
      currentTime: 0,
      destination: node(),
      createGain: () => ({ ...node(), gain: { value: 1 } }),
      createBuffer: () => ({ copyToChannel() {} }),
      createBufferSource: () => {
        const src = { ...node(), buffer: null, start() {} };
        sources.push(src);
        return src;
      },
    };
    const part = new Part(wasm as unknown as ConstructorParameters<typeof Part>[0], 1, 7);
    return { ctx, part, freed, sources, calls: () => calls };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("silences and frees the part when the first fill fails", () => {
    const { ctx, part, freed, sources } = setup(2);
    expect(() => new Singing(ctx as unknown as AudioContext, part, undefined)).toThrow("unreachable");
    expect(sources).toHaveLength(1);
    expect(sources.every((s) => s.disconnected)).toBe(true);
    expect(freed).toEqual([7]);
  });

  it("silences, frees the part and reports when a later fill fails", () => {
    vi.useFakeTimers();
    const { ctx, part, freed, sources, calls } = setup(4);
    const errors: unknown[] = [];
    const singing = new Singing(ctx as unknown as AudioContext, part, undefined, (e) => errors.push(e));
    expect(singing.chunks).toHaveLength(3);
    ctx.currentTime = 1;
    vi.advanceTimersByTime(250);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(sources).toHaveLength(3);
    expect(sources.every((s) => s.disconnected)).toBe(true);
    expect(freed).toEqual([7]);
    vi.advanceTimersByTime(5000);
    expect(calls()).toBe(4);
    singing.stop();
    expect(freed).toEqual([7]);
  });
});
