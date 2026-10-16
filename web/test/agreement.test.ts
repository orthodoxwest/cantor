// The pointing evaluation on a small hand-pointed set written for the test, mostly as the
// pointer points it today: a gate on the method and on the pointer's choices for these
// verses, not a measure of its accuracy (the real corpus is private;
// scripts/pointing-eval.mjs measures that locally).
import { init } from "neuma";
import { beforeAll, describe, expect, it } from "vitest";
import { compareVerse, plain, shapes, summarize, toneShapes } from "../../scripts/agreement.mjs";

beforeAll(() => init());

// Tone 8 G: one accent at the mediant, two preparatory syllables and an accent at the end.
const HAND = [
  "O praise the Lord, all ye · héathen; * praise him, · all ye nátions.",
  "For his merciful kindness is ever more and more to·wárds us; * and the truth of the Lord endureth for · ever. Práise the Lord.",
  "The Lord is my · shépherd; * therefore can · I lack nóthing.",
  "He shall feed me in a green · pásture, * and lead me forth beside the wa·ters of cómfort.",
  "He shall convert my · sóul, * and bring me forth in the paths of righteousness, · for his Náme's sake.",
  "Thou shalt prepare a table before me against them that · tróuble me; * thou hast anointed my head with oil, and my cup · shall be fúll.",
];

const TONES = `name: 8.G
clef: c4
mediant: g h jr 'k jr j.
termination: jr i j 'h gr g.

name: 1.D
clef: c4
mediant: f gh hr 'ixi hr 'g hr h.
termination: hr g f 'gh gr gvFED.
`;

describe("pointing evaluation", () => {
  it("reads a hand-pointed verse's plain text and cadence shapes", () => {
    expect(plain(HAND[3]!)).toBe("He shall feed me in a green pasture, * and lead me forth beside the wa-ters of comfort.");
    expect(plain("thine ene·mies thy fóotstool")).toBe("thine ene-mies thy footstool");
    expect(shapes(HAND[3]!)).toEqual({ mediant: [1, 0], termination: [1, 2] });
    expect(shapes("O God, thou · árt – mý God; * early · wíll I séek thee.")).toEqual({ mediant: null, termination: [2, 0] });
  });

  it("reads a tone file's cadence shapes", () => {
    expect(toneShapes(TONES)).toEqual([
      { name: "8.G", mode: "8", mediant: [1, 0], termination: [1, 2] },
      { name: "1.D", mode: "1", mediant: [2, 0], termination: [1, 2] },
    ]);
  });

  it("agrees with the hand on every half-verse but one", () => {
    const results = HAND.flatMap((v) => compareVerse(v, "8", toneShapes(TONES)));
    expect(results).toHaveLength(12);
    expect(results.every((r) => r.builtin)).toBe(true);
    expect(results.map((r, i) => (r.agree ? null : `${Math.floor(i / 2)}:${r.part}`)).filter(Boolean)).toEqual(["5:termination"]);
    expect(summarize(results).agreement).toBeCloseTo(11 / 12);
  });

  it("counts a disagreement", () => {
    const [mediant] = compareVerse("The Lord is · mý shepherd; * therefore can · I lack nóthing.", "8", toneShapes(TONES));
    expect(mediant).toMatchObject({ part: "mediant", agree: false });
  });
});
