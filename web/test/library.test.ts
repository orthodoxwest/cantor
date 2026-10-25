import { describe, expect, it } from "vitest";
import { approval, byMass, byTitle, finds, highlight, kicker, marked, massName, terms, type LibraryChant } from "../src/library";

describe("the library's order", () => {
  it("files titles by their words, past a leading versicle sign or number", () => {
    const titles = ["℣. Rest eternal", "O God", "Of the Father", "1. Israel's King", "a light", "Behold", "3rd Sunday", "... of blessed Edmund"];
    const sorted = titles.map((title, i) => ({ title, slug: `s${i}` })).sort(byTitle).map((c) => c.title);
    expect(sorted).toEqual(["3rd Sunday", "a light", "Behold", "1. Israel's King", "O God", "... of blessed Edmund", "Of the Father", "℣. Rest eternal"]);
  });
});

describe("the Mass settings", () => {
  const piece = (kind: LibraryChant["kind"], name: string | null, title = name ?? "x"): LibraryChant => ({
    slug: `${kind}-${name}`,
    title,
    name,
    kind,
    mode: null,
    book: null,
    source: null,
    url: null,
    words: "",
    awrv: null,
  });

  it("names a movement's Mass by the number its name gives, never a Creed's", () => {
    expect(massName(piece("kyrie", "Kyrie VIII"))).toBe("Mass VIII (De Angelis)");
    expect(massName(piece("agnus", "Agnus Dei XI"))).toBe("Mass XI (Orbis factor)");
    expect(massName(piece("dismissal", "Benedicamus IX"))).toBe("Mass IX (Cum jubilo)");
    expect(massName(piece("kyrie", "Kyrie XVI"))).toBe("Mass XVI");
    expect(massName(piece("credo", "Credo III"))).toBeNull();
    expect(massName(piece("kyrie", "Kyrie"))).toBeNull();
    expect(massName(piece("antiphon", "Ite VIII"))).toBeNull();
    expect(finds(piece("gloria", "Gloria"), terms("mass gloria"))).toBe(true);
    expect(kicker({ kind: "sanctus", mode: "vi", name: "Sanctus VIII" })).toBe("Mass VIII (De Angelis) · Sanctus · Mode vi");
  });

  it("files movements by Mass, then in the order they are sung, then the rest by title", () => {
    const sorted = [
      piece("dismissal", "Ite XI"),
      piece("credo", "Credo III"),
      piece("kyrie", "Kyrie XI"),
      piece("agnus", "Agnus Dei VIII"),
      piece("kyrie", "Kyrie", "Kyrie eleison"),
      piece("kyrie", "Kyrie VIII"),
      piece("sanctus", "Sanctus XI"),
    ]
      .sort(byMass)
      .map((c) => c.name);
    expect(sorted).toEqual(["Kyrie VIII", "Agnus Dei VIII", "Kyrie XI", "Sanctus XI", "Ite XI", "Kyrie", "Credo III"]);
  });
});

describe("searching the library", () => {
  const chant = (over: Partial<LibraryChant>): LibraryChant => ({
    slug: "s",
    title: "A light to lighten the Gentiles",
    name: "Lumen gentium",
    kind: "antiphon",
    mode: "viii",
    book: null,
    source: null,
    url: null,
    words: "A light to lighten the Gentiles, and the glory of thy people Israel.",
    awrv: null,
    ...over,
  });
  const found = (q: string, c = chant({})) => finds(c, terms(q));

  it("finds a chant by the beginnings of its words, in any order, accents ignored", () => {
    expect(found("light to lighten the gentiles")).toBe(true);
    expect(found("glo isr")).toBe(true);
    expect(found("lumen")).toBe(true);
    expect(found("Israel's", chant({ words: "the glory of Israel’s people" }))).toBe(true);
    expect(found("israel", chant({ words: "the glory of Israel’s people" }))).toBe(true);
    expect(found("lúmen")).toBe(true);
    expect(found("ight")).toBe(false);
    expect(found("light darkness")).toBe(false);
  });

  it("finds a chant by its kind and mode, a mode's numeral only whole", () => {
    expect(found("antiphon viii")).toBe(true);
    expect(found("mode 8 light")).toBe(true);
    expect(found("hymn")).toBe(false);
    expect(found("ii")).toBe(false);
    expect(found("ii", chant({ mode: "ii" }))).toBe(true);
    expect(found("ii", chant({ mode: "iii" }))).toBe(false);
    expect(found("vi", chant({ title: "Vidi aquam", mode: "viii" }))).toBe(true);
    expect(found("mode vi", chant({ title: "Vidi aquam", mode: "viii" }))).toBe(false);
    expect(found("vi antiphon", chant({ title: "Vidi aquam", mode: "viii" }))).toBe(false);
    expect(found("mode vi", chant({ mode: "vi" }))).toBe(true);
  });

  it("finds everything when nothing is searched", () => {
    expect(found("  ")).toBe(true);
  });

  it("marks the terms where they begin a word", () => {
    expect(highlight("A light to lighten", terms("light"))).toBe("A <mark>light</mark> to <mark>light</mark>en");
    expect(highlight("Delight & <b>", terms("light"))).toBe("Delight &amp; &lt;b&gt;");
    expect(highlight("Psalm iii", terms("ii"))).toBe("Psalm iii");
    expect(highlight("Lighten light", terms("l light"))).toBe("<mark>Light</mark>en <mark>light</mark>");
  });
});

describe("approval for the AWRV", () => {
  it("reads it as the Worker keeps it and as the build writes it, and none as not yet reviewed", () => {
    expect([1, true, 0, false, null, undefined].map(approval)).toEqual([true, true, false, false, null, null]);
  });

  it("finds an approved piece by the words AWRV approved, and no other", () => {
    const piece = (awrv: boolean | null): LibraryChant => ({ slug: "s", title: "Behold", name: null, kind: "antiphon", mode: null, book: null, source: null, url: null, words: "", awrv });
    expect(finds(piece(true), terms("awrv approved"))).toBe(true);
    expect(finds(piece(false), terms("awrv"))).toBe(false);
    expect(finds(piece(null), terms("awrv"))).toBe(false);
    expect(marked(piece(true))).toBe("Antiphon · AWRV approved");
    expect(marked(piece(false))).toBe("Antiphon");
  });
});
