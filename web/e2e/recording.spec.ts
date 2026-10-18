// A chant with an aligned recording (a private chant, from the Worker, stood in for here): after
// a take, the ribbon draws the recording's trace under the singer's, and says what it is.
import { expect, test, type Page, type Route } from "@playwright/test";

const GABC = "(c4) A(h) men.(h) (::)";
const band = (index: number, from: number) => ({ index, from_s: from, to_s: from + 0.4, cents: 5, trace: [[from + 0.1, 5], [from + 0.3, 8]] });

/** Opens `chant` on the page and shows a take of it judged. */
async function judgedTake(page: Page, chant: string): Promise<void> {
  await page.route("**/api/chants/sung", (route) =>
    route.fulfill({ json: { slug: "sung", title: "Amen", name: null, mode: null, kind: null, book: null, source: null, url: null, words: "Amen", gabc: GABC, recording: [band(0, 4), band(1, 4.5)] } }),
  );
  await page.route("**/api/chants/plain", (route) =>
    route.fulfill({ json: { slug: "plain", title: "Amen", name: null, mode: null, kind: null, book: null, source: null, url: null, words: "Amen", gabc: GABC } }),
  );
  await page.goto(`/sing.html?test=1&chant=${chant}`);
  await page.waitForFunction(() => window.__cantor);
  await page.evaluate(() => void window.__cantor.listen());
  await page.waitForTimeout(2000);
  await page.evaluate(() => void window.__cantor.listen());
  await page.evaluate(([gabc]) => window.__cantor.show(gabc, 0.5, 0.2), [GABC] as const);
  await expect(page.locator("#key")).toHaveText(/^You started /);
}

test("a chant's recording is drawn under the singer's trace", async ({ page }) => {
  await judgedTake(page, "sung");
  await expect(page.locator("polyline.band-recorded")).toHaveCount(2);
  await expect(page.locator("#recorded")).toBeVisible();
  // Under the singer's: drawn first in each band.
  const order = await page.locator("[data-band] polyline").evaluateAll((els) => els.map((el) => el.getAttribute("class")));
  expect(order.indexOf("band-recorded")).toBe(0);
});

test("a chant with no recording draws the singer's trace alone", async ({ page }) => {
  await judgedTake(page, "plain");
  await expect(page.locator("polyline.band-trace")).toHaveCount(2);
  await expect(page.locator("polyline.band-recorded")).toHaveCount(0);
  await expect(page.locator("#recorded")).toBeHidden();
});

// A chant whose recording's sound is kept: Recording plays it over the phrase chosen, as a third
// voice beside the guide and the take.
const PHRASES = "(c4) A(h) men(h) (;) al(g)le(h)lu(h)ia.(g) (::)";
/** Six notes, one each half second from 4 s into the recording, after what is spoken first. */
const RECORDED = Array.from({ length: 6 }, (_, i) => band(i, 4 + 0.5 * i));

/** `seconds` of a quiet sine as a 16-bit mono WAV, which the page decodes as it would the
 * recording's FLAC. */
function sine(seconds: number, rate = 16000): Buffer {
  const n = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + 2 * n);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + 2 * n, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(2 * rate, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(2 * n, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + 2 * i);
  return out;
}

/** Opens a chant with `recording` and, unless `audio` is null, its sound served as `audio`
 * answers; counts the fetches of the sound. */
async function voiced(page: Page, audio: ((route: Route) => Promise<void>) | null = (route) => route.fulfill({ body: sine(8), contentType: "audio/flac" })): Promise<{ fetches: () => number; ids: number[] }> {
  let fetches = 0;
  await page.route("**/api/chants/voiced", (route) =>
    route.fulfill({
      json: { slug: "voiced", title: "Amen", name: null, mode: null, kind: null, book: null, source: null, url: null, words: "Amen alleluia", gabc: PHRASES, recording: RECORDED, ...(audio ? { audio: "/api/chants/voiced/recording" } : {}) },
    }),
  );
  if (audio)
    await page.route("**/api/chants/voiced/recording", (route) => {
      fetches++;
      return audio(route);
    });
  await page.goto("/sing.html?test=1&chant=voiced");
  await page.waitForFunction(() => window.__cantor);
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  return { fetches: () => fetches, ids };
}

/** Waits for the recording's play to end on its own. */
async function played(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__cantor.recorded.playing), { timeout: 10_000 }).toBe(false);
}

test("a chant's recording plays over the phrase chosen, once, the cursor in its colour where it sang each note", async ({ page }) => {
  const { fetches, ids } = await voiced(page);
  const recording = page.getByRole("button", { name: "Recording" });
  await expect(recording).toBeVisible();
  await expect(recording).toHaveAttribute("title", "The recording of this chant over the phrase chosen, once, in the key it was sung in");
  // The second phrase: notes 3 to 6.
  await page.locator(`#score [data-note~="${ids[3]}"]`).first().click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  await recording.click();
  await expect(recording).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#score .cursor.recording")).toBeVisible();
  await expect(page.locator("#score.hearing-recording")).toHaveCount(1);
  await played(page);
  await expect(recording).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.recorded.visited)).toEqual(ids.slice(2, 6));
  await expect(page.locator("#score .cursor")).toBeHidden();
  await expect(page.locator("#score.hearing-recording")).toHaveCount(0);
  // The whole chant, from its first note, its sound fetched once.
  await page.getByRole("button", { name: "Whole chant" }).click();
  await recording.click();
  await played(page);
  expect(await page.evaluate(() => window.__cantor.recorded.visited)).toEqual(ids);
  expect(fetches()).toBe(1);
  // Pressed again while it plays, it stops; the guide stops it too.
  await recording.click();
  await expect(page.locator("#score .cursor.recording")).toBeVisible();
  await recording.click();
  await expect(recording).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.recorded.playing)).toBe(false);
  await recording.click();
  await expect(page.locator("#score .cursor.recording")).toBeVisible();
  await page.getByRole("button", { name: "Play" }).click();
  await expect(recording).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.recorded.playing)).toBe(false);
});

test("a recording whose sound cannot be had says so, and is asked for again the next time", async ({ page }) => {
  let missing = true;
  const { fetches } = await voiced(page, (route) => (missing ? route.fulfill({ status: 404, json: { error: "not found" } }) : route.fulfill({ body: sine(8), contentType: "audio/flac" })));
  const recording = page.getByRole("button", { name: "Recording" });
  await recording.click();
  await expect(page.locator("#status")).toHaveText("The recording could not be played: the library answered 404");
  await expect(recording).toHaveAttribute("aria-pressed", "false");
  missing = false;
  await recording.click();
  await expect(page.locator("#score .cursor.recording")).toBeVisible();
  expect(fetches()).toBe(2);
});

test("a recording is not offered without its sound, nor beside another chant put on the page", async ({ page }) => {
  await voiced(page, null);
  await expect(page.locator("#recording")).toBeHidden();
  await page.unrouteAll();
  await voiced(page);
  await expect(page.locator("#recording")).toBeVisible();
  await page.evaluate(() => window.__cantor.practise("(c4) Lo(g) (::)", 0.5));
  await expect(page.locator("#recording")).toBeHidden();
  await page.evaluate((gabc) => window.__cantor.practise(gabc, 0.5), PHRASES);
  await expect(page.locator("#recording")).toBeVisible();
});

test("on a phone the bar has Play and Recording, then the rest, and fits", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await voiced(page);
  const top = (name: string) => page.getByRole("button", { name, exact: true }).evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(await top("Recording")).toBe(await top("Play"));
  expect(await top("Start note")).toBeGreaterThan(await top("Play"));
  expect(await top("Sing a take")).toBe(await top("Start note"));
  const fits = () => page.evaluate(() => [...document.querySelectorAll(".bar .btn")].every((el) => (el as HTMLElement).offsetParent === null || el.getBoundingClientRect().right <= innerWidth));
  expect(await fits()).toBe(true);
  // Beside a take: Compare, Guide, Yours and Recording, then Repeat, Drone and Sing a take.
  await page.evaluate(() => void window.__cantor.listen());
  await page.waitForTimeout(1500);
  await page.evaluate(() => void window.__cantor.listen());
  await page.evaluate((gabc) => window.__cantor.show(gabc, 0.5, 0.2), PHRASES);
  await expect(page.locator("#key")).toBeVisible();
  expect(await top("Recording")).toBe(await top("Compare"));
  expect(await top("Yours")).toBe(await top("Compare"));
  expect(await top("Repeat")).toBeGreaterThan(await top("Compare"));
  expect(await fits()).toBe(true);
  // In a take, which it is not heard in, it goes.
  await page.getByRole("button", { name: "Sing a take" }).click();
  await expect(page.locator("#recording")).toBeHidden();
  expect(await top("Stop")).toBe(await top("Repeat"));
  // And comes back when the take is over.
  await expect(page.locator("#recording")).toBeVisible({ timeout: 15_000 });
});

test("on a phone, a take with no take shown keeps the bar to one row", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await voiced(page);
  const top = (name: string) => page.getByRole("button", { name, exact: true }).evaluate((el) => Math.round(el.getBoundingClientRect().top));
  await page.getByRole("button", { name: "Sing a take" }).click();
  await expect(page.locator("#recording")).toBeHidden();
  expect(await top("Stop")).toBe(await top("Play"));
  await expect(page.locator("#recording")).toBeVisible({ timeout: 15_000 });
});
