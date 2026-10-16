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

test("start note sounds the first note, then the reciting tone, and stops Play", async ({ page }) => {
  await open(page);
  const play = page.getByRole("button", { name: "Play" });
  const note = page.getByRole("button", { name: "Start note" });
  await play.click();
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await note.click();
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await expect(note).toHaveAttribute("aria-pressed", "true");
  // An antiphon has no reciting tone, so one note sounds.
  await expect.poll(() => page.evaluate(() => window.__cantor.pitch.length)).toBe(1);
  // It ends by itself.
  await expect(note).toHaveAttribute("aria-pressed", "false", { timeout: 5_000 });
  expect(await page.evaluate(() => window.__cantor.pitch)).toEqual([]);
  // Pressed again while it sounds, it stops.
  await note.click();
  await expect.poll(() => page.evaluate(() => window.__cantor.pitch.length)).toBe(1);
  await note.click();
  await expect(note).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.pitch)).toEqual([]);
});

test("listen hears A4 from the microphone", async ({ page }) => {
  await open(page);
  await page.evaluate(() => void window.__cantor.listen());
  // Within 20 cents of A4.
  await expect
    .poll(() => page.evaluate(() => window.__cantor.frames.some((f) => f.midi !== null && Math.abs(f.midi - 69) < 0.2)), {
      timeout: 15_000,
    })
    .toBe(true);
  await expect(page.locator("#readout")).toHaveText(/^A4 /);
});

test("a take started at once after another is heard on its own", async ({ page }) => {
  await open(page);
  const listen = () => page.evaluate(() => void window.__cantor.listen());
  await listen();
  await page.waitForTimeout(3000);
  await listen();
  await listen();
  // Once the second take has reached the ear, a second of it.
  await expect.poll(() => page.evaluate(() => window.__cantor.heard() !== undefined), { intervals: [50] }).toBe(true);
  await page.waitForTimeout(1000);
  await listen();
  const heard = await page.evaluate(() => window.__cantor.heard());
  expect(heard).toBeDefined();
  // The second take alone, about a second: not the first (three) nor both (four).
  expect(heard!.seconds).toBeGreaterThan(0.9);
  expect(heard!.seconds).toBeLessThan(2.5);
  await expect(page.locator("#status")).toHaveText(`Heard ${heard!.seconds.toFixed(1)} s.`);
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

test("without the renderer the guide and the take are off, and the ear still hears", async ({ page }) => {
  await page.route(
    (url) => url.pathname === "/cantor.wasm",
    (route) => route.fulfill({ status: 404 }),
  );
  await open(page);
  expect(await page.evaluate(() => window.__cantor.voice)).toBe("none");
  await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sing a take" })).toBeDisabled();
  await page.evaluate(() => void window.__cantor.listen());
  await expect(page.locator("#readout")).toHaveText(/^A4 /, { timeout: 15_000 });
});
