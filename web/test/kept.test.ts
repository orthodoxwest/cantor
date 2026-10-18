import { afterEach, describe, expect, it, vi } from "vitest";
import { english, hours, notesOf, pack, unpack, whenSung } from "../src/kept";
import type { Band } from "../src/ribbon";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("whenSung", () => {
  const now = new Date(2026, 9, 17, 14, 5).getTime();

  it("names the day by today or yesterday, with the time", () => {
    expect(whenSung(new Date(2026, 9, 17, 9, 30).getTime(), now, "en-GB", "h23")).toBe("today at 9:30");
    expect(whenSung(new Date(2026, 9, 16, 23, 59).getTime(), now, "en-GB", "h23")).toBe("yesterday at 23:59");
    // Midnight is the day's start, not a day's length ago.
    expect(whenSung(new Date(2026, 9, 17, 0, 0).getTime(), new Date(2026, 9, 17, 23, 59).getTime(), "en-GB", "h23")).toBe("today at 0:00");
  });

  it("writes the time on the clock the browser's own language keeps", () => {
    expect(whenSung(new Date(2026, 9, 17, 14, 0).getTime(), now, "en-GB", "h12")).toMatch(/^today at 2:00\spm$/);
    expect(whenSung(new Date(2026, 9, 17, 14, 0).getTime(), now, "en-US", "h23")).toBe("today at 14:00");
    for (const [language, cycle] of [
      ["ko-KR", "h12"],
      ["ar-EG", "h12"],
      ["de-DE", "h23"],
      ["ja-JP", "h23"],
    ] as const) {
      vi.stubGlobal("navigator", { language, languages: [language] });
      expect(hours(), language).toBe(cycle);
    }
  });

  it("names an earlier day by its date, with its year when it is not this year's", () => {
    expect(whenSung(new Date(2026, 9, 3, 12, 0).getTime(), now, "en-GB")).toBe("on 3 October");
    expect(whenSung(new Date(2025, 11, 31, 12, 0).getTime(), now, "en-GB")).toBe("on 31 December 2025");
    expect(whenSung(new Date(2026, 9, 3, 12, 0).getTime(), now, "en-US")).toBe("on October 3");
  });

  it("is in English whatever the browser's own language", () => {
    vi.stubGlobal("navigator", { language: "de-DE", languages: ["de-DE"] });
    expect(english()).toBe("en-GB");
    expect(whenSung(new Date(2026, 9, 3, 12, 0).getTime(), now)).toBe("on 3 October");
    expect(whenSung(new Date(2026, 9, 17, 9, 30).getTime(), now)).toBe("today at 9:30");
    // The English it lists, where it lists one.
    vi.stubGlobal("navigator", { language: "fr-CA", languages: ["fr-CA", "en-CA"] });
    expect(english()).toBe("en-CA");
  });
});

describe("the notes a take is kept on", () => {
  it("are each note's pitch, in order", () => {
    expect(notesOf([{ semitones: 5 }, { semitones: 7 }, { semitones: -1.5 }])).toBe("5 7 -1.5");
    expect(notesOf([])).toBe("");
  });
});

describe("a take kept", () => {
  it("comes back as it was put, its trace's seconds and cents in order", () => {
    const bands: Band[] = [
      { index: 0, from_s: 0.6, to_s: 1.2, start_s: 0.5, end_s: 1.3, cents: -12.5, trace: [[0.5, -150], [0.75, -10], [1.25, 4]] },
      { index: 2, from_s: 2.1, to_s: 2.4, cents: null, trace: [] },
    ];
    const stored = pack("chant", { at: 1_760_700_000_000, notes: "5 7 9", bands });
    expect(stored.bands[0]!.trace).toBeInstanceOf(Float32Array);
    expect(stored.chant).toBe("chant");
    const back = unpack(stored);
    expect(back.at).toBe(1_760_700_000_000);
    expect(back.notes).toBe("5 7 9");
    expect(back.bands.map(({ trace, ...rest }) => rest)).toEqual(bands.map(({ trace, ...rest }) => rest));
    // Packed as 32-bit floats: as near as they hold.
    expect(back.bands[0]!.trace).toEqual([
      [Math.fround(0.5), -150],
      [Math.fround(0.75), -10],
      [Math.fround(1.25), 4],
    ]);
    expect(back.bands[1]!.trace).toEqual([]);
  });
});
