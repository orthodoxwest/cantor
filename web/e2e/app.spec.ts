import { expect, test, type Page } from "@playwright/test";
import type { Timeline } from "neuma";

const PULSE = 0.5;

/** Opens the practice page and waits until it has its voice (or has given up on one). */
async function open(page: Page, query = ""): Promise<Timeline> {
  await page.goto(`/sing.html?test=1${query}`);
  await expect(page.locator("#score svg")).toBeVisible();
  await page.waitForFunction(() => window.__cantor);
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

for (const [voice, query] of [
  ["neutral", ""],
  ["recorded", "&voice=/test-voice.cvox"],
] as const) {
  test(`the guide sings with the ${voice} voice in chunks`, async ({ page }) => {
    const { makeVoice } = await import("./fixtures/voice.mjs");
    await page.route(
      (url) => url.pathname === "/test-voice.cvox",
      (route) => route.fulfill({ body: makeVoice() }),
    );
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await open(page, query);
    expect(await page.evaluate(() => window.__cantor.voice)).toBe(voice);
    await page.getByRole("button", { name: "Play" }).click();
    await expect.poll(() => page.evaluate(() => window.__cantor.chunks.length), { timeout: 10_000 }).toBeGreaterThan(2);
    const chunks = await page.evaluate(() => window.__cantor.chunks);
    // Chunks follow one another without gaps, and the voice is heard in them.
    chunks.forEach(([from], i) => i > 0 && expect(from).toBe(chunks[i - 1]![0] + chunks[i - 1]![1]));
    expect(chunks.some(([, , rms]) => rms > 0.01)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("a renderer that traps stops the guide, which sings again on the next play", async ({ page }) => {
  const { trapFourthChunk } = await import("./fixtures/trap.mjs");
  await page.addInitScript(trapFourthChunk);
  await open(page);
  const play = page.getByRole("button", { name: "Play" });
  await play.click();
  await expect(page.locator("#status")).toHaveText(/failed\. Press Play to try again/, { timeout: 10_000 });
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#score .cursor")).toBeHidden();
  await play.click();
  await expect(page.locator("#status")).toHaveText("");
  // A fresh renderer sings past where the last one trapped.
  await expect.poll(() => page.evaluate(() => window.__cantor.chunks.length), { timeout: 10_000 }).toBeGreaterThan(3);
});

test("a voice file with nothing to sing falls back to the neutral vowel", async ({ page }) => {
  const empty = Buffer.alloc(12);
  empty.write("CVOX", 0);
  empty.writeUInt16LE(1, 4);
  empty.writeUInt32LE(24000, 8);
  await page.route(
    (url) => url.pathname === "/empty.cvox",
    (route) => route.fulfill({ body: empty }),
  );
  await open(page, "&voice=/empty.cvox");
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
  expect(await page.evaluate(() => window.__cantor.voice)).toBe("neutral");
});

test("without the renderer the guide is off and listening still works", async ({ page }) => {
  await page.route(
    (url) => url.pathname === "/cantor.wasm",
    (route) => route.fulfill({ status: 404 }),
  );
  await open(page);
  expect(await page.evaluate(() => window.__cantor.voice)).toBe("none");
  await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
  await page.getByRole("button", { name: "Listen" }).click();
  await expect(page.locator("#readout")).toHaveText(/^A4 /, { timeout: 15_000 });
});
