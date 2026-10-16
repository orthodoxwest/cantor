import { expect, test, type Page } from "@playwright/test";
import type { Timeline } from "neuma";

declare global {
  interface Window {
    __cantor: {
      frames: Array<{ midi: number | null }>;
      timeline: Timeline;
      visited: number[];
      chunks: Array<[number, number, number]>;
      voice: boolean;
    };
  }
}

const PULSE = 0.5;

async function open(page: Page): Promise<Timeline> {
  await page.goto("/?test=1");
  await expect(page.locator("#score svg")).toBeVisible();
  return page.evaluate(() => window.__cantor.timeline);
}

test("renders every note of the timeline", async ({ page }) => {
  const timeline = await open(page);
  expect(timeline.notes.length).toBeGreaterThan(0);
  const inked = await page.locator("[data-note]").evaluateAll((els) =>
    new Set(els.flatMap((el) => el.getAttribute("data-note")!.split(" "))).size,
  );
  expect(inked).toBe(timeline.notes.length);
});

test("play moves the cursor across every note", async ({ page }) => {
  await page.clock.install();
  const timeline = await open(page);
  await page.getByRole("button", { name: "Play" }).click();
  await page.clock.runFor(PULSE * 1000);
  await expect(page.locator("#score .cantor-current")).toHaveCount(1);
  await expect(page.locator("#score .cursor")).toBeVisible();
  await page.clock.runFor((timeline.duration + 1) * PULSE * 1000);
  expect(await page.evaluate(() => window.__cantor.visited)).toEqual(timeline.notes.map((n) => n.id));
  await expect(page.locator("#score .cursor")).toBeHidden();
});

test("listen hears A4 from the microphone", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Listen" }).click();
  // Within 20 cents of A4.
  await expect
    .poll(() => page.evaluate(() => window.__cantor.frames.some((f) => f.midi !== null && Math.abs(f.midi - 69) < 0.2)), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect(page.locator("#readout")).toHaveText(/^A4 /);
});

test("a sampled voice sings the guide in chunks", async ({ page }) => {
  const { makeVoice } = await import("./fixtures/voice.mjs");
  await page.route(
    (url) => url.pathname === "/test-voice.cvox",
    (route) => route.fulfill({ body: makeVoice() }),
  );
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/?test=1&voice=/test-voice.cvox");
  await expect(page.locator("#score svg")).toBeVisible();
  expect(await page.evaluate(() => window.__cantor.voice)).toBe(true);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => page.evaluate(() => window.__cantor.chunks.length), { timeout: 10_000 }).toBeGreaterThan(2);
  const chunks = await page.evaluate(() => window.__cantor.chunks);
  // Chunks follow one another without gaps, and the voice is heard in them.
  chunks.forEach(([from], i) => i > 0 && expect(from).toBe(chunks[i - 1]![0] + chunks[i - 1]![1]));
  expect(chunks.some(([, , rms]) => rms > 0.01)).toBe(true);
  expect(errors).toEqual([]);
});
