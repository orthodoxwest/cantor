import { Chant, init, toneNames } from "neuma";
import { beforeAll, describe, expect, it } from "vitest";
import { meinrad, toneLine } from "../src/meinrad";
import psalter from "../../content/psalter.json";

beforeAll(() => init());

const probe = (psalms: typeof psalter.psalms) => psalms.map((p) => p.verses.join("\n")).join("\n");
/** The probe the page learns tone lines from. */
const PROBE = probe(psalter.psalms.slice(0, 10));
const line = (tone: string, text = PROBE) => toneLine(Chant.fromTone(tone, { initial: 0 }).source, tone, text);
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

  it("takes an open slot between accents as open though most halves sing it once", () => {
    // 5.a: hr 'i gr 'h fr f.
    expect(places(line("5.a")!.termination)).toBe("h:tenor i:accent g:open h:accent f:open f:ending");
  });

  it("keeps tone 4's intonation, whose pes is sung on the tenor's note", () => {
    expect(places(line("4.g")!.mediant)).toBe(
      "h:intonation gh:intonation h:tenor g:preparatory h:preparatory i:accent h:open h:ending",
    );
  });

  it("learns from the probe what the whole psalter gives, for every built-in tone", () => {
    const all = probe(psalter.psalms);
    for (const tone of toneNames()) {
      const l = line(tone);
      expect(l, tone).not.toBeNull();
      expect(l, tone).toEqual(line(tone, all));
      for (const half of [l!.mediant, l!.termination]) {
        expect(half.filter((s) => s.role === "tenor"), tone).toHaveLength(1);
        expect(half.some((s) => s.role === "accent"), tone).toBe(true);
        expect(half.at(-1)!.role, tone).toBe("ending");
      }
      expect(l!.mediant[0]!.role, tone).toBe("intonation");
    }
  }, 120_000);

  it("reads text with parentheses, which GABC escapes", () => {
    expect(line("8.G", "O praise the Lord (all ye heathen) * praise him, all ye nations.")).toEqual(
      line("8.G", "O praise the Lord, all ye heathen * praise him, all ye nations."),
    );
  });

  it("gives null when nothing can be matched", () => {
    expect(line("8.G", "")).toBeNull();
  });
});

describe("meinrad", () => {
  it("types the tone line as a Meinrad-set psalter does", () => {
    // The intonation to the tenor, a bar, the tenor three times, a quarter bar, the cadence
    // with its accent sign and hollow open note, and so on to the double bar.
    expect(meinrad(line("8.G")!)).toBe(
      "Bcgvvhvvkcv]ckckckc[c\uEBF4lcv\uEAB8cvkc]ckckckc[cjcvkcv\uEBF4hcv\uEAB5cvgc}",
    );
  });

  it("types flats, figures and dots", () => {
    const keys = meinrad(line("1.D")!)!;
    // A flat on b, set off by a narrow space, before the accent; the intonation's pes; and the
    // final climacus: virga, a hair of space, diamonds.
    expect(keys).toContain("c\uEC07z\uEBF4j");
    expect(keys.startsWith("BcfvvGhvvh")).toBe(true);
    expect(keys.endsWith("5x$#@c}")).toBe(true);
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
