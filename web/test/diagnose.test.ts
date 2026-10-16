import { describe, expect, it } from "vitest";
import { asText, browserOf, echoes, level, median, ms, processing } from "../src/diagnose";

describe("browserOf", () => {
  it("names the common phones' and desktops' browsers", () => {
    expect(browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1")).toBe("Safari 18.1 on iOS 18.1");
    expect(browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1")).toBe("Chrome 130 (Safari's engine) on iOS 17.6");
    expect(browserOf("Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36")).toBe("Chrome 141 on Android 15");
    expect(browserOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("Safari 18.0 on macOS 10.15.7");
    expect(browserOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", true)).toBe("Safari 18.0 on an iPad (as a Mac)");
    expect(browserOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0")).toBe("Firefox 132 on Windows");
    expect(browserOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0")).toBe("Edge 141 on Windows");
    expect(browserOf("curl/8.0")).toBe("An unknown browser on an unknown system");
  });
});

describe("echoes", () => {
  const frame = (t: number, midi: number | null) => ({ t, midi, rms: 0.1 });
  it("times each beep to the first frame at its pitch, within the window", () => {
    const frames = [frame(0.9, 81), frame(1.1, 69), frame(1.15, 81.3), frame(1.2, 81), frame(2.5, null), frame(3.9, 81)];
    expect(echoes(frames, [1, 2.4, 3], 81, 0.8)).toEqual([expect.closeTo(0.15, 9), null, null]);
  });
});

describe("words", () => {
  it("gives levels, latencies and processing as the table shows them", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(level(0.1)).toBe("-20 dBFS");
    expect(level(0)).toBe("silence");
    expect(level(null)).toBe("not heard");
    expect(ms(0.0123)).toBe("12 ms");
    expect(ms(undefined)).toBe("not said");
    expect(processing(false, [true, false])).toBe("off");
    expect(processing(true, [true])).toBe("on, though the page asked for it off; the browser says it cannot be");
    expect(processing(true, undefined)).toBe("on, though the page asked for it off");
    expect(processing(undefined, undefined)).toBe("not said");
    expect(asText([["A", "1"], ["Longer", "2"]])).toBe("A       1\nLonger  2");
  });
});
