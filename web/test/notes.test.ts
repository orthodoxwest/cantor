import { describe, expect, it } from "vitest";
import { describePitch, noteName } from "../src/notes";

describe("note names", () => {
  it("name the nearest note, with or without the cents from it", () => {
    expect(noteName(69)).toBe("A4");
    expect(noteName(45.4)).toBe("A2");
    expect(noteName(70.6)).toBe("B4");
    expect(describePitch(44.75)).toBe("A2 −25¢");
    expect(describePitch(69.03)).toBe("A4 +3¢");
  });
});
