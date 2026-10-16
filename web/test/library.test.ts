import { describe, expect, it } from "vitest";
import { byTitle } from "../src/library";

describe("the library's order", () => {
  it("files titles by their words, past a leading versicle sign or number", () => {
    const titles = ["℣. Rest eternal", "O God", "Of the Father", "1. Israel's King", "a light", "Behold", "3rd Sunday", "... of blessed Edmund"];
    const sorted = titles.map((title, i) => ({ title, slug: `s${i}` })).sort(byTitle).map((c) => c.title);
    expect(sorted).toEqual(["3rd Sunday", "a light", "Behold", "1. Israel's King", "O God", "... of blessed Edmund", "Of the Father", "℣. Rest eternal"]);
  });
});
