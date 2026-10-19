// A mark's card plays the note its words are of as it was sung, a few times over, against a soft
// tone where the judge put the note, in the octave it was held in (Against the note).
import { expect, test, type Page } from "@playwright/test";

/** The A4 heard against notes written a tone, a third and a fourth below it: an ending off
 * pitch at note 1, and marks at notes 2, 5 and 7. */
const GABC = "(c4) A(h) men(g) (:) al(g)le(h)lu(h)ia(f) (:) De(h)o(e) gra(h)ti(h)as(h) (::)";

interface Band {
  index: number;
  from_s: number;
  to_s: number;
  target_midi: number | null;
}
/** A take judged, as the page's hook gives it: its bands, its marks, its endings. */
interface Taken {
  ribbon: Band[];
  verdict: { marks: Array<{ first: number; last: number }> };
  endings: Array<{ note: number }>;
}
/** A sound the page started: when, from how far into its buffer and for how long, the buffer's
 * length, and whether it loops (the tone's does). */
interface Start {
  when: number;
  offset: number;
  duration: number;
  length: number;
  loop: boolean;
}

/** Keeps every sound the page starts from its buffers, and lets the list be cleared. */
async function startsOf(page: Page): Promise<{ starts: () => Promise<Start[]>; clear: () => Promise<void> }> {
  await page.addInitScript(() => {
    const w = window as unknown as { starts: Start[] };
    w.starts = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
      w.starts.push({ when: when ?? 0, offset: offset ?? 0, duration: duration ?? Infinity, length: this.buffer?.duration ?? 0, loop: this.loop });
      return start.call(this, when, offset, duration);
    };
  });
  return {
    starts: () => page.evaluate(() => (window as unknown as { starts: Start[] }).starts),
    clear: () => page.evaluate(() => void ((window as unknown as { starts: Start[] }).starts.length = 0)),
  };
}

/** Opens the page, listens for `seconds` and shows the take of `gabc` judged. */
async function taken(page: Page, gabc = GABC, seconds = 8): Promise<Taken> {
  await page.goto("/sing.html?test=1");
  await page.waitForFunction(() => window.__cantor);
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(seconds * 1000);
  await page.evaluate(() => void window.__cantor.listen());
  return JSON.parse(await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const));
}

/** Steps on to mark `n`, its card open; and, given its syllable, checks that it is `syllable`. */
async function toMark(page: Page, n: number, syllable?: string): Promise<void> {
  const text = page.locator("#chosen-text");
  while (!(await text.textContent())?.startsWith(`Mark ${n} of `)) await page.getByRole("button", { name: "Next mark or ending" }).click();
  if (syllable) await expect(text).toHaveText(new RegExp(`^Mark ${n} of \\d · “${syllable}”$`));
}

/** How many times a note held `seconds` is heard. */
const timesOf = (seconds: number) => Math.min(8, Math.max(3, Math.ceil(2.4 / seconds)));

const held = (page: Page) => page.evaluate(() => window.__cantor.held);

/** Waits for the note heard against where it belonged to end, and its tone to fall silent. */
async function ended(page: Page): Promise<void> {
  await expect.poll(async () => (await held(page)).playing, { timeout: 10_000 }).toBe(false);
  await expect.poll(() => page.evaluate(() => window.__cantor.drones)).toBe(0);
}

/** Checks that the starts of one play of `band` against where it belonged are the tone, then
 * the note `times` over, each a breath after the last, half a second after the tone came in;
 * the buffer they are of. */
function heardAgainst(starts: Start[], band: Band): number {
  const tones = starts.filter((s) => s.loop);
  const notes = starts.filter((s) => !s.loop);
  expect(tones).toHaveLength(1);
  const length = band.to_s - band.from_s;
  expect(notes).toHaveLength(timesOf(length));
  notes.forEach((s, k) => {
    expect(s.offset).toBeCloseTo(band.from_s, 4);
    expect(s.duration).toBeCloseTo(length, 4);
    expect(s.when - tones[0]!.when).toBeCloseTo(0.5 + k * (length + 0.18), 6);
    expect(s.length).toBe(notes[0]!.length);
  });
  return notes[0]!.length;
}

test("a mark's note plays a few times over against a tone where it belonged, and the card keeps it on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const { starts, clear } = await startsOf(page);
  const { ribbon, endings } = await taken(page);
  const next = page.getByRole("button", { name: "Next mark or ending" });
  const against = page.getByRole("button", { name: "Against the note" });
  await expect(against).toBeHidden();
  // The ending first, its note off: written a tone below the A sung, it belonged at G.
  await next.click();
  await expect(page.locator("#chosen-text")).toHaveText("Ending 1 of 1 · “A … men”");
  expect(endings[0]!.note).toBe(1);
  const ending = ribbon[1]!;
  expect(Math.abs(ending.target_midi! - 67)).toBeLessThan(0.05);
  await expect(against).toHaveAttribute("title", "Your note, a few times over, against a soft tone where it belonged, in the octave you sang it");
  // On a narrow phone the step's words have a row, the card's three buttons the next, in the card.
  const boxes = await page.evaluate(() =>
    ["why", "why-step", "step", "against", "unopen"].map((id) => {
      const { left, right, top } = document.getElementById(id)!.getBoundingClientRect();
      return { left, right, top };
    }),
  );
  const [card, words, step, , close] = boxes;
  expect(boxes.slice(2).every((b) => b.top === step!.top && b.top > words!.top && b.left >= card!.left && b.right <= card!.right + 0.5)).toBe(true);
  expect(close!.right).toBeCloseTo(card!.right, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await clear();
  await against.click();
  await expect(against).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await held(page)).playing).toBe(true);
  expect((await held(page)).now).toEqual({ from: ending.from_s, to: ending.to_s, midi: ending.target_midi, times: timesOf(ending.to_s - ending.from_s), level: 0.2 });
  // It ends by itself, the tone with it.
  await expect(against).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  await ended(page);
  const take = heardAgainst(await starts(), ending);
  // The marks of the take's audio too: the A where a fourth below, E, belonged.
  await page.setViewportSize({ width: 1024, height: 844 });
  for (const [mark, syllable, at, target] of [
    [1, "al", 2, 67],
    [3, "o", 7, 64],
  ] as const) {
    await toMark(page, mark, syllable);
    const band = ribbon[at]!;
    expect(Math.abs(band.target_midi! - target)).toBeLessThan(0.05);
    // Wide, the card keeps one row.
    const [words, step, both] = await Promise.all(["#why-step", "#step", "#against"].map((q) => page.locator(q).boundingBox()));
    expect(both!.y).toBe(step!.y);
    expect(words!.y).toBeGreaterThan(step!.y);
    expect(words!.y + words!.height).toBeLessThan(step!.y + step!.height);
    await clear();
    await against.click();
    await expect.poll(async () => (await held(page)).now?.midi).toBe(band.target_midi);
    await ended(page);
    expect(heardAgainst(await starts(), band)).toBe(take);
  }
});

test("pressed again, by another voice, or under a card moved or closed, it stops; and it stops the others", async ({ page }) => {
  await taken(page);
  const next = page.getByRole("button", { name: "Next mark or ending" });
  const against = page.getByRole("button", { name: "Against the note" });
  const yours = page.getByRole("button", { name: "Yours" });
  const drone = page.getByRole("button", { name: "Drone" });
  const playing = async () => (await held(page)).playing;
  const start = async () => {
    await against.click();
    await expect(against).toHaveAttribute("aria-pressed", "true");
    await expect.poll(playing).toBe(true);
  };
  await next.click();
  await next.click();
  await expect(page.locator("#chosen-text")).toHaveText("Mark 1 of 3 · “al”");
  await start();
  await against.click();
  await expect(against).toHaveAttribute("aria-pressed", "false");
  await ended(page);
  // Yours stops it, and it stops Yours.
  await start();
  await yours.click();
  await expect(against).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => window.__cantor.replayed.playing)).toBe(true);
  await ended(page);
  await start();
  await expect(yours).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.replayed.playing)).toBe(false);
  // The drone would cover the take: each stops the other.
  await drone.click();
  await expect(drone).toHaveAttribute("aria-pressed", "true");
  await expect(against).toHaveAttribute("aria-pressed", "false");
  expect(await playing()).toBe(false);
  await start();
  await expect(drone).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => window.__cantor.drone)).toBeNull();
  // It does not play on under a card moved to another mark, nor one closed.
  await next.click();
  await expect(page.locator("#chosen-text")).toHaveText("Mark 2 of 3 · “ia”");
  await expect(against).toHaveAttribute("aria-pressed", "false");
  expect(await playing()).toBe(false);
  await start();
  await page.getByRole("button", { name: "Close the mark" }).click();
  await expect(page.locator("#why")).toBeHidden();
  await expect(page.locator("#against")).toHaveAttribute("aria-pressed", "false");
  expect(await playing()).toBe(false);
  await ended(page);
});

test("a take's audio that cannot be decoded says so, and is heard the next time", async ({ page }) => {
  // The first decode fails, as a browser short of memory might.
  await page.addInitScript(() => {
    const decode = AudioContext.prototype.decodeAudioData;
    let failed = false;
    AudioContext.prototype.decodeAudioData = function (this: AudioContext, data: ArrayBuffer) {
      if (failed) return decode.call(this, data);
      failed = true;
      return Promise.reject(new Error("out of memory"));
    } as typeof decode;
  });
  await taken(page);
  const against = page.getByRole("button", { name: "Against the note" });
  await page.getByRole("button", { name: "Next mark or ending" }).click();
  await against.click();
  await expect(page.locator("#status")).toHaveText("Your take could not be played: out of memory");
  await expect(against).toHaveAttribute("aria-pressed", "false");
  expect((await held(page)).playing).toBe(false);
  await against.click();
  await expect.poll(async () => (await held(page)).playing).toBe(true);
  await ended(page);
});

test("a mark of a run sung again is heard from the run, where it was sung again; not in a take", async ({ page }) => {
  test.setTimeout(60_000);
  const { starts, clear } = await startsOf(page);
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(g) (::)";
  await page.goto("/sing.html?test=1");
  await page.waitForFunction(() => window.__cantor);
  await page.evaluate(([g]) => window.__cantor.practise(g, 0.5), [gabc] as const);
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(4500);
  await page.evaluate(() => void window.__cantor.listen());
  const whole: Taken = JSON.parse(await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const));
  const against = page.getByRole("button", { name: "Against the note" });
  const [first] = whole.verdict.marks;
  await toMark(page, 1);
  await against.click();
  await expect.poll(async () => (await held(page)).playing).toBe(true);
  await ended(page);
  const take = heardAgainst(await starts(), whole.ribbon[first!.first]!);
  // In a run sung again, it is off.
  const sing = page.locator("#take");
  await sing.click();
  await expect(sing).toHaveText("Stop");
  await expect(page.locator("#against")).toBeDisabled();
  await sing.click();
  await expect(sing).toHaveText("Sing again");
  await expect(page.locator("#against")).toBeEnabled();
  await page.evaluate(() => void window.__cantor.listenAgain());
  await page.waitForTimeout(3000);
  await page.evaluate(() => void window.__cantor.listenAgain());
  const sung: Taken = JSON.parse((await page.evaluate(() => window.__cantor.showAgain(2, 5, 0.5, 0.2)))!);
  // The first mark of the run, after those of the take before it.
  const [mark] = sung.verdict.marks;
  const before = whole.verdict.marks.filter((m) => m.last < 2).length;
  await toMark(page, before + 1);
  const band = sung.ribbon.find((b) => b.index === mark!.first)!;
  expect(band.from_s).not.toBe(whole.ribbon[mark!.first]!.from_s);
  await clear();
  await against.click();
  await expect.poll(async () => (await held(page)).now).toEqual({ from: band.from_s, to: band.to_s, midi: band.target_midi, times: timesOf(band.to_s - band.from_s), level: 0.2 });
  await ended(page);
  // From the run's audio, not the take's.
  expect(heardAgainst(await starts(), band)).not.toBe(take);
});
