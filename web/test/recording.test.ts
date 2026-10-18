import { afterEach, describe, expect, it, vi } from "vitest";
import { recordedTimes, recordingSound } from "../src/recording";
import type { Band } from "../src/ribbon";

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

describe("recordingSound", () => {
  afterEach(() => vi.unstubAllGlobals());

  const context = () => {
    const decoded = { duration: 1 } as AudioBuffer;
    return { ctx: { decodeAudioData: vi.fn(async () => decoded) } as unknown as BaseAudioContext, decoded };
  };

  it("fetches and decodes the sound once, and keeps it for the next time", async () => {
    const fetched = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetched);
    const sound = recordingSound("/api/chants/sung/recording");
    const { ctx, decoded } = context();
    expect(await sound(ctx)).toBe(decoded);
    expect(await sound(ctx)).toBe(decoded);
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched).toHaveBeenCalledWith("/api/chants/sung/recording");
  });

  it("says what the library answered when it gives none, and asks again the next time", async () => {
    const fetched = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetched);
    const sound = recordingSound("/api/chants/sung/recording");
    const { ctx, decoded } = context();
    await expect(sound(ctx)).rejects.toThrow("the library answered 404");
    fetched.mockImplementation(async () => new Response(new Uint8Array([1])));
    expect(await sound(ctx)).toBe(decoded);
    expect(fetched).toHaveBeenCalledTimes(2);
  });
});
