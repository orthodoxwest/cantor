import type { TimelineNote } from "neuma";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordedTimes, recordingSound, renderedTimes } from "../src/recording";
import type { Band } from "../src/ribbon";
import { RECITATION } from "../src/timing";

const band = (index: number, from: number, to: number, whole?: [number, number]): Band => ({
  index,
  from_s: from,
  to_s: to,
  ...(whole ? { start_s: whole[0], end_s: whole[1] } : {}),
  cents: 0,
  trace: [],
});

describe("recordedTimes", () => {
  it("times each note where the recording sang the whole of it", () => {
    expect(recordedTimes([band(0, 4.1, 4.4, [4, 4.5]), band(1, 4.6, 4.9, [4.5, 5.25])], 2)).toEqual([
      { start: 4, duration: 0.5 },
      { start: 4.5, duration: 0.75 },
    ]);
  });

  it("times a note of bands seeded with only its sustained part over that part", () => {
    expect(recordedTimes([band(0, 4.25, 4.75), band(1, 5.125, 5.5, [5, 5.75])], 2)).toEqual([
      { start: 4.25, duration: 0.5 },
      { start: 5, duration: 0.75 },
    ]);
  });

  it("has none for bands that are not the chant's notes, one a note in order", () => {
    expect(recordedTimes([band(0, 1, 2)], 2)).toBeNull();
    expect(recordedTimes([band(0, 1, 2), band(1, 2, 3)], 1)).toBeNull();
    expect(recordedTimes([band(1, 1, 2), band(0, 2, 3)], 2)).toBeNull();
    expect(recordedTimes([], 0)).toBeNull();
  });
});

describe("renderedTimes", () => {
  const note = (start: number, duration: number, recitation = false) => ({ start, duration, recitation }) as TimelineNote;

  it("times each note as the page does at the pulse it was sung at, from the second its first pulse falls at", () => {
    // A recited note, a pause of a pulse, then a sung note of two.
    const times = renderedTimes([note(0, 1, true), note(2, 2)], { pulse: 0.5, zero: 0.08 })!;
    expect(times[0]!.start).toBeCloseTo(0.08, 9);
    expect(times[0]!.duration).toBeCloseTo(RECITATION * 0.5, 9);
    expect(times[1]!.start).toBeCloseTo(0.08 + RECITATION * 0.5 + 0.5, 9);
    expect(times[1]!.duration).toBeCloseTo(1, 9);
  });

  it("has none for a chant of no notes, or a rendering not timed as one is", () => {
    expect(renderedTimes([], { pulse: 0.5, zero: 0 })).toBeNull();
    for (const timing of [{ pulse: 0, zero: 0 }, { pulse: -0.5, zero: 0 }, { pulse: Number.NaN, zero: 0 }, { pulse: Infinity, zero: 0 }, { pulse: 0.5, zero: Number.NaN }])
      expect(renderedTimes([note(0, 1)], timing)).toBeNull();
  });
});

describe("recordingSound", () => {
  afterEach(() => vi.unstubAllGlobals());

  const context = () => {
    const decoded = { duration: 1 } as AudioBuffer;
    return { ctx: { decodeAudioData: vi.fn(async () => decoded) } as unknown as BaseAudioContext, decoded };
  };

  it("fetches and decodes the sound once, and keeps it for the next time", async () => {
    const fetched = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetched);
    const { sound, kept } = recordingSound("/api/chants/sung/recording");
    const { ctx, decoded } = context();
    expect(kept()).toBe(false);
    const first = sound(ctx);
    expect(kept()).toBe(false);
    expect(await first).toBe(decoded);
    expect(kept()).toBe(true);
    expect(await sound(ctx)).toBe(decoded);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched).toHaveBeenCalledWith("/api/chants/sung/recording");
  });

  it("says what the library answered when it gives none, and asks again the next time", async () => {
    const fetched = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetched);
    const { sound, kept } = recordingSound("/api/chants/sung/recording");
    const { ctx, decoded } = context();
    await expect(sound(ctx)).rejects.toThrow("the library answered 404");
    expect(kept()).toBe(false);
    fetched.mockImplementation(async () => new Response(new Uint8Array([1])));
    expect(await sound(ctx)).toBe(decoded);
    expect(kept()).toBe(true);
    expect(fetched).toHaveBeenCalledTimes(2);
  });
});
