import { describe, expect, it } from "vitest";
import { byTitle, finds, highlight, terms, type LibraryChant } from "../src/library";

describe("the library's order", () => {
  it("files titles by their words, past a leading versicle sign or number", () => {
    const titles = ["℣. Rest eternal", "O God", "Of the Father", "1. Israel's King", "a light", "Behold", "3rd Sunday", "... of blessed Edmund"];
    const sorted = titles.map((title, i) => ({ title, slug: `s${i}` })).sort(byTitle).map((c) => c.title);
    expect(sorted).toEqual(["3rd Sunday", "a light", "Behold", "1. Israel's King", "O God", "... of blessed Edmund", "Of the Father", "℣. Rest eternal"]);
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
