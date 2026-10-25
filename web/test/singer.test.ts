import type { TimelineNote } from "neuma";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunksDue, fromTimeline, mix, notesText, octaveBelow, octaveShift, Part, sing, Singing, type SungNote, VoiceTable } from "../src/singer";

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

  it("recite at speech pace, as the core times a take", () => {
    const run = [
      { semitones: 9, start: 4, duration: 1, recitation: true, word: 0, syllable: 0, syllableText: "Glo" },
      { semitones: 9, start: 5, duration: 1, recitation: true, word: 0, syllable: 1, syllableText: "ry" },
      { semitones: 7, start: 7, duration: 2, word: 1, syllable: 2, syllableText: "be" },
    ] as unknown as TimelineNote[];
    const notes = fromTimeline(run, 0.5, (s) => 48 + s, 4);
    // Each recited note lasts 0.6 of its pulse; the pause of a pulse before "be" stays whole.
    const want = [
      [0, 0.3],
      [0.3, 0.3],
      [1.1, 1],
    ];
    notes.forEach((n, i) => {
      expect(n.start).toBeCloseTo(want[i]![0]!, 9);
      expect(n.duration).toBeCloseTo(want[i]![1]!, 9);
    });
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

describe("octaveBelow and mix", () => {
  it("sing the same notes an octave lower, at the same times", () => {
    const notes = [{ midi: 60, start: 0.5, duration: 1, word: 0, syllable: 0, text: "Glo" }];
    expect(octaveBelow(notes)).toEqual([{ ...notes[0], midi: 48 }]);
    expect(notes[0]!.midi).toBe(60);
  });

  it("leave the voice as it is and add the octave below at 0.7", () => {
    const one = new Float32Array([0.5, -0.25]);
    expect(mix([one])).toBe(one);
    const mixed = mix([one, new Float32Array([0.5, 0.25])]);
    expect(mixed[0]).toBeCloseTo(0.85, 6);
    expect(mixed[1]).toBeCloseTo(-0.075, 6);
    expect([...one]).toEqual([0.5, -0.25]);
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
  // A part 4 s long at 8 kHz on an audio context that records what is scheduled; the first
  // fill schedules three chunks. The `failAt`th chunk fails: the renderer traps, which leaves
  // it unable to free anything, as cantor.wasm's traps do, or the audio graph refuses it.
  function setup(failAt: number, failure: "trap" | "audio") {
    let calls = 0;
    let trapped = false;
    const freed: number[] = [];
    const wasm = {
      memory: new WebAssembly.Memory({ initial: 1 }),
      // The second part one test adds, 8, lasts 5 s.
      cantor_part_length: (handle: number) => (handle === 8 ? 40_000 : 32_000),
      cantor_sing: () => {
        if (++calls === failAt && failure === "trap") {
          trapped = true;
          throw new WebAssembly.RuntimeError("unreachable");
        }
        return 0;
      },
      cantor_part_free: (handle: number) => {
        if (trapped) throw new WebAssembly.RuntimeError("already borrowed");
        freed.push(handle);
      },
    };
    const node = () => ({ disconnected: false, connect: (n: unknown) => n, disconnect() { this.disconnected = true; } });
    const nodes: Array<ReturnType<typeof node>> = [];
    const made = <T extends ReturnType<typeof node>>(n: T) => (nodes.push(n), n);
    const ctx = {
      sampleRate: 8000,
      currentTime: 0,
      destination: node(),
      createGain: () => made({ ...node(), gain: { value: 1 } }),
      createBuffer: () => {
        if (calls === failAt && failure === "audio") throw new RangeError("refused");
        return { copyToChannel() {} };
      },
      createBufferSource: () => made({ ...node(), buffer: null, start() {} }),
    };
    const renderer = { wasm, voice: 1, centre: 55, trapped: false };
    const part = new Part(renderer as unknown as ConstructorParameters<typeof Part>[0], 7);
    return { ctx, part, renderer, freed, nodes, calls: () => calls };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sings two parts as one, for as long as the longer lasts, and lets both go", () => {
    const { ctx, part, renderer, freed, nodes } = setup(0, "trap");
    const longer = new Part(renderer as unknown as ConstructorParameters<typeof Part>[0], 8);
    const singing = new Singing(ctx as unknown as AudioContext, [part, longer], undefined);
    expect(singing.end).toBeCloseTo(singing.start + 5, 9);
    // The gain and one source a chunk.
    expect(nodes).toHaveLength(1 + singing.chunks.length);
    singing.stop();
    expect(freed).toEqual([7, 8]);
  });

  // A table that hands out the setup's parts, 7 then 8, and records the notes each was made
  // for; `failSecond` makes the second refuse.
  function table(doubled: boolean, renderer: ReturnType<typeof setup>["renderer"], failSecond = false) {
    const asked: number[][] = [];
    const t = {
      doubled,
      renew: async () => {},
      part: (notes: readonly SungNote[]) => {
        asked.push(notes.map((n) => n.midi));
        if (asked.length === 2 && failSecond) throw new WebAssembly.RuntimeError("unreachable");
        return new Part(renderer as unknown as ConstructorParameters<typeof Part>[0], 6 + asked.length);
      },
    };
    return { table: t as unknown as VoiceTable, asked };
  }
  const notes: SungNote[] = [{ midi: 60, start: 0, duration: 1, word: 0, syllable: 0, text: "A" }];

  it("sings the made voice doubled an octave below, and a cantor's voice alone", async () => {
    for (const doubled of [true, false]) {
      const { ctx, renderer, freed } = setup(0, "trap");
      const { table: t, asked } = table(doubled, renderer);
      const singing = await sing(ctx as unknown as AudioContext, notes, { table: t });
      expect(asked).toEqual(doubled ? [[60], [48]] : [[60]]);
      singing.stop();
      expect(freed).toEqual(doubled ? [7, 8] : [7]);
    }
  });

  it("lets the first part go when the octave below cannot be made", async () => {
    const { ctx, renderer, freed } = setup(0, "trap");
    const { table: t } = table(true, renderer, true);
    await expect(sing(ctx as unknown as AudioContext, notes, { table: t })).rejects.toThrow();
    expect(freed).toEqual([7]);
  });

  for (const failure of ["trap", "audio"] as const) {
    // A trapped renderer is not asked to free the part; it is replaced whole.
    const freedAfter = failure === "trap" ? [] : [7];

    it(`silences what is scheduled when the first fill fails (${failure})`, () => {
      const { ctx, part, renderer, freed, nodes } = setup(2, failure);
      expect(() => new Singing(ctx as unknown as AudioContext, [part], undefined)).toThrow();
      // The gain and the one chunk scheduled.
      expect(nodes).toHaveLength(2);
      expect(nodes.every((n) => n.disconnected)).toBe(true);
      expect(freed).toEqual(freedAfter);
      expect(renderer.trapped).toBe(failure === "trap");
    });

    it(`silences what is scheduled and reports when a later fill fails (${failure})`, () => {
      vi.useFakeTimers();
      const { ctx, part, freed, nodes, calls } = setup(4, failure);
      const errors: unknown[] = [];
      const singing = new Singing(ctx as unknown as AudioContext, [part], undefined, (e) => errors.push(e));
      expect(singing.chunks).toHaveLength(3);
      ctx.currentTime = 1;
      vi.advanceTimersByTime(250);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(failure === "trap" ? WebAssembly.RuntimeError : RangeError);
      expect(nodes).toHaveLength(4);
      expect(nodes.every((n) => n.disconnected)).toBe(true);
      expect(freed).toEqual(freedAfter);
      vi.advanceTimersByTime(5000);
      expect(calls()).toBe(4);
      expect(() => singing.stop()).not.toThrow();
      expect(freed).toEqual(freedAfter);
    });
  }
});
