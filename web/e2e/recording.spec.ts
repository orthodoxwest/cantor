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

/** Keeps, for each sound the page starts of the recording (its eight seconds), from how far into
 * it and for how long. */
async function startsOf(page: Page): Promise<() => Promise<Array<[number, number]>>> {
  await page.addInitScript(() => {
    const w = window as unknown as { starts: Array<[number, number]> };
    w.starts = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      if (Math.abs((this.buffer?.duration ?? 0) - 8) < 0.01) w.starts.push([offset ?? 0, duration ?? Infinity]);
      return start.call(this, when, offset, duration);
    };
  });
  return () => page.evaluate(() => (window as unknown as { starts: Array<[number, number]> }).starts);
}

/** Keeps every line the status says, in order, from the page's start; and lets it be cleared. */
async function statusLog(page: Page): Promise<{ said: () => Promise<string[]>; clear: () => Promise<void> }> {
  await page.addInitScript(() => {
    const w = window as unknown as { said: string[] };
    w.said = [];
    document.addEventListener("DOMContentLoaded", () => {
      const status = document.getElementById("status")!;
      new MutationObserver(() => w.said.push(status.textContent ?? "")).observe(status, { childList: true, characterData: true, subtree: true });
    });
  });
  return {
    said: () => page.evaluate(() => (window as unknown as { said: string[] }).said),
    clear: () => page.evaluate(() => void ((window as unknown as { said: string[] }).said.length = 0)),
  };
}

/** Shows a take of the chant on the page judged, beside which the voices are offered. */
async function besideTake(page: Page): Promise<void> {
  await page.evaluate(() => void window.__cantor.listen());
  await page.waitForTimeout(1500);
  await page.evaluate(() => void window.__cantor.listen());
  await page.evaluate((gabc) => window.__cantor.show(gabc, 0.5, 0.2), PHRASES);
  await expect(page.locator("#key")).toBeVisible();
}

/** Waits for the recording's play to end on its own. */
async function played(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__cantor.recorded.playing), { timeout: 10_000 }).toBe(false);
}

test("a chant's recording plays over the phrase chosen, once, the cursor in its colour where it sang each note", async ({ page }) => {
  const starts = await startsOf(page);
  const { fetches, ids } = await voiced(page);
  const recording = page.getByRole("button", { name: "Recording" });
  await expect(recording).toBeVisible();
  await expect(recording).toHaveAttribute("title", "The recording of this chant over the phrase chosen, or the whole chant from its first note, once, in the key it was sung in");
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
  // Sounded from a moment before the phrase's first note, 5 s in, to a moment after its last.
  const [phrase] = await starts();
  expect(phrase![0]).toBeCloseTo(4.7, 2);
  expect(phrase![0] + phrase![1]).toBeCloseTo(7.3, 2);
  // The whole chant, from just before its first note, 4 s in, past what is spoken before it;
  // its sound fetched once.
  await page.getByRole("button", { name: "Whole chant" }).click();
  await recording.click();
  await played(page);
  expect(await page.evaluate(() => window.__cantor.recorded.visited)).toEqual(ids);
  const whole = (await starts())[1]!;
  expect(whole[0]).toBeCloseTo(3.7, 2);
  expect(whole[0] + whole[1]).toBeCloseTo(7.3, 2);
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
  // A drone would cover it: the recording stops the drone, and the drone the recording.
  await page.getByRole("button", { name: "Play" }).click();
  const drone = page.getByRole("button", { name: "Drone" });
  await drone.click();
  await expect(drone).toHaveAttribute("aria-pressed", "true");
  await recording.click();
  await expect(page.locator("#score .cursor.recording")).toBeVisible();
  await expect(drone).toHaveAttribute("aria-pressed", "false");
  await drone.click();
  await expect(drone).toHaveAttribute("aria-pressed", "true");
  await expect(recording).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.recorded.playing)).toBe(false);
});

test("while the recording's sound is first fetched the status says so, until it comes or its play is stopped, and a play stopped meanwhile does not start when it comes", async ({ page }) => {
  const log = await statusLog(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const { fetches } = await voiced(page, async (route) => {
    await held;
    await route.fulfill({ body: sine(8), contentType: "audio/flac" });
  });
  const recording = page.getByRole("button", { name: "Recording" });
  const status = page.locator("#status");
  await recording.click();
  await expect(status).toHaveText("Fetching the recording…");
  await expect(status).not.toHaveClass(/error/);
  // Stopped, pressed again or by another voice, the line goes with it.
  await recording.click();
  await expect(recording).toHaveAttribute("aria-pressed", "false");
  await expect(status).toHaveText("");
  await recording.click();
  await expect(status).toHaveText("Fetching the recording…");
  await page.getByRole("button", { name: "Start note" }).click();
  await expect(recording).toHaveAttribute("aria-pressed", "false");
  await expect(status).toHaveText("");
  release();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__cantor.recorded.playing)).toBe(false);
  await expect(page.locator("#score .cursor.recording")).toBeHidden();
  await expect(status).toHaveText("");
  // Kept, it plays at once the next time, with nothing to say.
  await log.clear();
  await recording.click();
  await expect(page.locator("#score .cursor.recording")).toBeVisible();
  expect(await log.said()).not.toContain("Fetching the recording…");
  await expect(status).toHaveText("");
  expect(fetches()).toBe(1);
});

test("a recording stopped while its sound is fetched says nothing of it when it cannot be had", async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await voiced(page, async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { error: "unavailable" } });
  });
  const recording = page.getByRole("button", { name: "Recording" });
  const status = page.locator("#status");
  await recording.click();
  await expect(status).toHaveText("Fetching the recording…");
  await recording.click();
  await expect(status).toHaveText("");
  release();
  await page.waitForTimeout(500);
  await expect(status).toHaveText("");
});

test("without the guide, the recording plays and leaves what the status says of the guide", async ({ page }) => {
  await page.route("**/cantor.wasm", (route) => route.abort());
  await voiced(page);
  const status = page.locator("#status");
  await expect(status).toHaveText("The guide voice could not load.");
  await page.getByRole("button", { name: "Recording" }).click();
  await expect(page.locator("#score .cursor.recording")).toBeVisible();
  await expect(status).toHaveText("The guide voice could not load.");
  await expect(status).toHaveClass(/error/);
});

test("the recording, in its own key, plays on when the guide's key is changed", async ({ page }) => {
  await voiced(page);
  const recording = page.getByRole("button", { name: "Recording" });
  await recording.click();
  await expect(page.locator("#score .cursor.recording")).toBeVisible();
  await page.evaluate(() => {
    const box = document.getElementById("in-key") as HTMLInputElement;
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change"));
  });
  expect(await page.evaluate(() => window.__cantor.recorded.playing)).toBe(true);
  await expect(recording).toHaveAttribute("aria-pressed", "true");
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
  // What could not be played is not said while it plays.
  await expect(page.locator("#status")).toHaveText("");
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
  await besideTake(page);
  expect(await top("Recording")).toBe(await top("Compare"));
  expect(await top("Yours")).toBe(await top("Compare"));
  expect(await top("Repeat")).toBeGreaterThan(await top("Compare"));
  expect(await fits()).toBe(true);
  // In a take, which it is not heard in, it goes.
  await page.getByRole("button", { name: "Sing a take" }).click();
  await expect(page.locator("#recording")).toBeHidden();
  expect(await top("Stop")).toBe(await top("Play"));
  // And comes back when the take is over, to be pressed.
  await expect(page.locator("#recording")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#recording")).toBeEnabled();
});

for (const width of [700, 768, 1024]) {
  test(`at ${width} px the bar keeps Recording in a row of its voices, and fits`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await voiced(page);
    const top = (name: string) => page.getByRole("button", { name, exact: true }).evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const tops = async (names: string[]) => Promise.all(names.map(top));
    const fits = () => page.evaluate(() => [...document.querySelectorAll(".bar .btn")].every((el) => (el as HTMLElement).offsetParent === null || el.getBoundingClientRect().right <= innerWidth));
    // Before a take, one row, the readout, which has nothing to say, gone.
    expect(new Set(await tops(["Play", "Recording", "Start note", "Drone", "Sing a take"])).size).toBe(1);
    await expect(page.locator("#readout")).toBeHidden();
    expect(await fits()).toBe(true);
    // Beside a take, the four voices, then the rest.
    await besideTake(page);
    const voices = await tops(["Compare", "Guide", "Yours", "Recording"]);
    expect(new Set(voices).size).toBe(1);
    const rest = await tops(["Repeat", ...(width >= 768 ? ["Start note"] : []), "Drone", "Sing a take"]);
    expect(new Set(rest).size).toBe(1);
    expect(rest[0]).toBeGreaterThan(voices[0]!);
    expect(await fits()).toBe(true);
    // In a take it goes, and the bar is as it is without it.
    await page.getByRole("button", { name: "Sing a take" }).click();
    await expect(page.locator("#recording")).toBeHidden();
    const shown = await page.locator(".bar-in > button").evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => [el.id, Math.round(el.getBoundingClientRect().top)] as const));
    expect(shown.map(([id]) => id)).toEqual(["play", "note", "drone", "take"]);
    expect(new Set(shown.map(([, at]) => at)).size).toBe(1);
    expect(await fits()).toBe(true);
    await expect(page.locator("#recording")).toBeVisible({ timeout: 15_000 });
  });
}

test("at 650 px, as on a phone turned on its side, the bar keeps to one row before a take", async ({ page }) => {
  await page.setViewportSize({ width: 650, height: 360 });
  await voiced(page);
  const top = (name: string) => page.getByRole("button", { name, exact: true }).evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const tops = await Promise.all(["Play", "Recording", "Start note", "Drone", "Sing a take"].map(top));
  expect(new Set(tops).size).toBe(1);
});

test("at 1024 px, in Sing again, the bar keeps its buttons to one row", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await voiced(page);
  // A take long enough to have a key, which a run is sung again in.
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(4500);
  await page.evaluate(() => void window.__cantor.listen());
  await page.evaluate((gabc) => window.__cantor.show(gabc, 0.5, 0.2), PHRASES);
  await expect(page.locator("#key")).toBeVisible();
  await page.getByRole("button", { name: "Choose the phrase of note 4", exact: true }).click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  const take = page.locator("#take");
  await expect(take).toHaveText("Sing again");
  await take.click();
  await expect(page.locator("#recording")).toBeHidden();
  const shown = await page.locator(".bar-in > button").evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(shown.length).toBeGreaterThan(2);
  expect(new Set(shown).size).toBe(1);
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
