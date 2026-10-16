import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/share";

describe("share", () => {
  it("round-trips the state, edited text included", async () => {
    const text = "1 The Lord is · Kíng * and hath put on glori·ous appárel.\n".repeat(200);
    const state = { psalm: "119-iv", tone: "8.G", gloria: false, transpose: -3, text };
    const hash = await encode(state);
    expect(hash).toMatch(/^#psalm=119-iv&tone=8\.G&gloria=0&pitch=-3&text=[\w-]+$/);
    expect(await decode(hash)).toEqual(state);
  });

  it("leaves defaults and unedited text out", async () => {
    const hash = await encode({ psalm: "23", tone: "8.G", gloria: true, transpose: 0 });
    expect(hash).toBe("#psalm=23&tone=8.G");
    expect(await decode(hash)).toEqual({ psalm: "23", tone: "8.G", gloria: true, transpose: 0, text: undefined });
  });

  it("ignores what it didn't write", async () => {
    expect(await decode("")).toBeNull();
    expect(await decode("#psalm=23")).toBeNull();
    const bad = await decode("#psalm=23&tone=8.G&pitch=99&text=%%%");
    expect(bad).toEqual({ psalm: "23", tone: "8.G", gloria: true, transpose: 0, text: undefined });
  });
});
