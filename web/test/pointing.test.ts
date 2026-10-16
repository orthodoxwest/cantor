import { init, psalmDisplay } from "neuma";
import { beforeAll, describe, expect, it } from "vitest";
import { GLORIA, moveAccents, nucleus, pointText, psalmText } from "../src/pointing";

beforeAll(() => init());

const PS117 = [
  "O praise the Lord, all ye heathen * praise him, all ye nations.",
  "For his merciful kindness is ever more and more towards us * and the truth of the Lord endureth for ever. Praise the Lord.",
];

/** The syllables of one half as the display gives them: text and span. */
function syllables(text: string, tone: string, verse: number, part: string) {
  return psalmDisplay(text, tone)
    .verses[verse]!.runs.flatMap((r) => (r.kind === "syllable" && r.part === part ? [r] : []))
    .map((r) => ({ text: r.text, start: r.sourceUtf16Start, end: r.sourceUtf16End, accent: r.accent }));
}

describe("psalmText", () => {
  it("numbers verses from the first and adds the Gloria unnumbered", () => {
    expect(psalmText(["a * b", "c * d"], 9, true).split("\n")).toEqual(["9 a * b", "10 c * d", ...GLORIA]);
    expect(psalmText(["a * b"], 1, false)).toBe("1 a * b");
  });
});

describe("pointText", () => {
  it("marks every half and keeps a hand-pointed half as written", () => {
    const { text } = pointText(psalmText(PS117, 1, false), "8.G");
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.match(/·/g)).toHaveLength(2);
    const hand = "1 O praise the · Lórd, all ye heathen * praise him, all · ye nátions.";
    expect(pointText(hand, "8.G").text).toBe(hand);
  });
});

describe("moveAccents", () => {
  const tone = "8.G";
  const text = "1 O praise the Lord, all ye heathen * praise him, all · ye nátions.";

  it("moves a one-accent cadence and recounts its preparatory syllables", () => {
    const before = pointText(text, tone).text;
    const half = syllables(before, tone, 0, "termination");
    const him = half.find((s) => s.text === "him,")!;
    const after = moveAccents(before, tone, 0, "termination", [him]);
    // Tone 8 G's termination prepares the accent with two syllables.
    expect(after.split("*")[1]).toBe(" · praise hím, all ye nations.");
    expect(after.split("*")[0]).toBe(before.split("*")[0]);
    const moved = syllables(after, tone, 0, "termination").filter((s) => s.accent);
    expect(moved.map((s) => s.text)).toEqual(["hím,"]);
  });

  it("splits a word with the point when the cadence starts inside it", () => {
    const before = pointText("1 The Lord is King * and hath put on glorious apparel.", tone).text;
    expect(before).toBe("1 The Lord is · Kíng * and hath put on glori·ous appárel.");
    const glo = syllables(before, tone, 0, "termination").find((s) => s.text === "glo")!;
    const moved = moveAccents(before, tone, 0, "termination", [glo]);
    expect(moved).toBe("1 The Lord is · Kíng * and hath · put on glórious apparel.");
    const pa = syllables(moved, tone, 0, "termination").find((s) => s.text === "pa")!;
    expect(moveAccents(moved, tone, 0, "termination", [pa])).toBe(before);
  });

  it("puts the acute on the syllable's first vowel", () => {
    const before = pointText(text, tone).text;
    const praise = syllables(before, tone, 0, "termination").find((s) => s.text === "praise")!;
    expect(moveAccents(before, tone, 0, "termination", [praise])).toContain("práise");
  });

  it("places both accents of a two-accent cadence", () => {
    // Tone 1 D's mediant has two accents.
    const t = "1.D";
    const before = pointText(psalmText(PS117, 1, false), t).text;
    const half = syllables(before, t, 1, "mediant");
    const at = (word: string) => half.find((s) => s.text === word)!;
    const after = moveAccents(before, t, 1, "mediant", [at("kind"), at("more")]);
    const accents = syllables(after, t, 1, "mediant").filter((s) => s.accent).map((s) => s.text);
    expect(accents).toEqual(["kínd", "móre"]);
    expect(after.split("\n")[0]).toBe(before.split("\n")[0]);
  });

  it("rejects an accent outside its half", () => {
    const before = pointText(text, tone).text;
    const lord = syllables(before, tone, 0, "mediant")[0]!;
    expect(() => moveAccents(before, tone, 0, "termination", [lord])).toThrow();
  });

  it("takes the marks before a half's first syllable with it", () => {
    const before = pointText("1 O God * my God.", tone).text;
    expect(before).toBe("1 O · Gód * – – · mý God.");
    let text = before;
    for (let i = 0; i < 4; i++) {
      const half = syllables(text, tone, 0, "termination");
      text = moveAccents(text, tone, 0, "termination", [half.find((s) => s.text === (i % 2 ? "my" : "God."))!]);
      expect(text.match(/·/g)).toHaveLength(2);
    }
  });

  it("puts every accent back where it was without changing the text", () => {
    for (const [verse, tone] of [
      ["1 He gave them hailstones for rain * and flames of fire in their land.", "4.E"],
      ["1 I will go into thine house with burnt-offerings * and will pay thee my vows.", "8.G"],
    ] as const) {
      const text = pointText(verse, tone).text;
      for (const part of ["mediant", "termination"] as const) {
        const accents = syllables(text, tone, 0, part).filter((s) => s.accent);
        expect(moveAccents(text, tone, 0, part, accents)).toBe(text);
      }
    }
  });

  it("moves an accent along a split word without printing a hyphen in it", () => {
    for (const verse of [
      "1 Why do the heathen so furiously rage together * and why do the people imagine a vain thing?",
      "4 It is the Lord that ruleth the sea; the voice of the Lord is mighty in operation * the voice of the Lord is a glorious voice.",
    ]) {
      const text = pointText(verse, "8.G").text;
      const half = syllables(text, "8.G", 0, "mediant");
      const accent = half.findIndex((s) => s.accent);
      for (const step of [-1, 1]) {
        const moved = moveAccents(text, "8.G", 0, "mediant", [half[accent + step]!]);
        expect(moved.split("*")[0]).not.toMatch(/\p{L}-\p{L}/u);
      }
    }
  });
});

describe("nucleus", () => {
  it("accents the vowel a pointed psalter does", () => {
    const accent = (s: string) => s.slice(0, nucleus(s)) + "'" + s.slice(nucleus(s));
    expect(["ye", "you", "pie", "true", "guide", "qui", "sion", "strength", "Lord"].map(accent)).toEqual([
      "y'e", "y'ou", "p'ie", "tr'ue", "g'uide", "qu'i", "si'on", "str'ength", "L'ord",
    ]);
    expect(nucleus("s")).toBe(-1);
  });
});
