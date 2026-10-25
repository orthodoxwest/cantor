import { Chant, init, toneNames } from "neuma";
import { beforeAll, describe, expect, it } from "vitest";
import { meinrad, toneLine } from "../src/meinrad";
import { pointText, psalmText } from "../src/pointing";
import psalter from "../../content/psalter.json";

beforeAll(() => init());

const PS23 = psalter.psalms.find((p) => p.id === "23")!;
const line = (tone: string) => {
  const text = pointText(psalmText(PS23.verses, 1, true), tone).text;
  return toneLine(Chant.fromTone(tone, { initial: 0 }).source, text, tone);
};
const places = (slots: Array<{ neume: string; role: string }>) => slots.map((s) => `${s.neume}:${s.role}`).join(" ");

describe("toneLine", () => {
  it("names each slot's place in the tone from the verses that sing it", () => {
    const l = line("8.G")!;
    expect(l.clef).toBe("c4");
    expect(places(l.mediant)).toBe("g:intonation h:intonation j:tenor k:accent j:open j:ending");
    expect(places(l.termination)).toBe("j:tenor i:preparatory j:preparatory h:accent g:open g:ending");
  });

  it("keeps an accent's place where a half leaves out the open slot after it", () => {
    // 1.D-: hr g f 'g gr gvFED, the open g often not sung.
    expect(places(line("1.D-")!.termination)).toBe("h:tenor g:preparatory f:preparatory g:accent g:open gvFED:ending");
  });

  it("takes an open slot no verse sings as open, and the final note as the final", () => {
    // 1.D2: hr g f gr 'gf d., and "cóm(gf)fort(d) me.(d)" sings the final twice.
    expect(places(line("1.D2")!.termination)).toBe("h:tenor g:preparatory f:preparatory g:open gf:accent d:ending");
  });

  it("matches every built-in tone", () => {
    for (const tone of toneNames()) {
      const l = line(tone);
      expect(l, tone).not.toBeNull();
      for (const half of [l!.mediant, l!.termination]) {
        expect(half.filter((s) => s.role === "tenor"), tone).toHaveLength(1);
        expect(half.some((s) => s.role === "accent"), tone).toBe(true);
        expect(half.at(-1)!.role, tone).toBe("ending");
      }
    }
  });
});

describe("meinrad", () => {
  it("types the tone line as the booklets do", () => {
    // As the Lauds booklet types viii.1 under its c3 clef, here in c4: the intonation to the
    // tenor, a bar, the tenor three times, a quarter bar, the cadence with its accent sign and
    // hollow open note, and so on to the double bar.
    expect(meinrad(line("8.G")!)).toBe(
      "Bcgvvhvvkcv]ckckckc[clcvcvkc]ckckckc[cjcvkcvhcvcvgc}",
    );
  });

  it("types flats, figures and dots", () => {
    const keys = meinrad(line("1.D")!)!;
    // A flat on b before the accent, the intonation's pes, and the final climacus: virga, diamonds.
    expect(keys).toContain("cj");
    expect(keys.startsWith("BcfvvGhvvh")).toBe(true);
    expect(keys.endsWith("5$#@c}")).toBe(true);
    // Clivis with a dot at the height of each note: "gf." dots the f.
    expect(meinrad(line("1.f")!)!.endsWith("tf,c}")).toBe(true);
    // Torculus: punctum, the clivis's upper note, punctum.
    expect(meinrad(line("1.g2")!)!.endsWith("gygc}")).toBe(true);
    // The f3 clef, and the c3.
    expect(meinrad(line("2.D")!)!.startsWith("X")).toBe(true);
    expect(meinrad(line("5.a")!)!.startsWith("V")).toBe(true);
  });

  it("types every built-in tone", () => {
    for (const tone of toneNames()) expect(meinrad(line(tone)!), tone).toMatch(/^[BVX]c.*c\}$/);
  });

  it("gives null for what the keyboard doesn't type", () => {
    const l = line("8.G")!;
    expect(meinrad({ ...l, clef: "c1" })).toBeNull();
    expect(meinrad({ ...l, mediant: l.mediant.map((s) => (s.role === "accent" ? { ...s, neume: "m" } : s)) })).toBeNull();
    expect(meinrad({ ...l, mediant: l.mediant.map((s) => (s.role === "accent" ? { ...s, neume: "ky" } : s)) })).toBeNull();
  });
});
