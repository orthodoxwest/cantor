// The page's ear against `cantor eval`: a synthetic take with planted faults plays through the
// fake microphone, the page listens to it in its worker with the NSDF tracker and SwiftF0, and
// the take judged there must be heard and marked as `cantor eval` heard and marked it.
import { expect, test } from "@playwright/test";
import { readTake, TAKE_WAV, takeSeconds } from "./fixtures/take.mjs";

/** How far the page's heard fraction may stray from the eval's: the take is resampled from
 * the eval's 16 kHz to the page's rate (44.1 or 48 kHz), where the tracker's frames are
 * longer and fall elsewhere against the notes. `cantor-cli`'s
 * `the_browser_ear_hears_a_take_as_the_eval_does_wherever_its_frames_fall` holds the same
 * tolerances, and the same marks, at both rates wherever the frames fall. */
const HEARD_TOLERANCE = 0.02;
/** And the key, in cents. */
const KEY_TOLERANCE_CENTS = 10;
/** And each note on the ribbon, in cents from the key, where both heard it: its value and the
 * middle of its trace. Where the frames fall moves a short note's median by up to 16.6 cents
 * (over 32 phases at both rates; the cli test holds 20 at quarter hops), and the browser has
 * shown 18.7 with its capture. */
const BAND_TOLERANCE_CENTS = 25;

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${TAKE_WAV}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});

test("the page's ear hears a take as cantor eval does", async ({ page }, info) => {
  const want = readTake();
  const seconds = takeSeconds();
  test.setTimeout((seconds + 60) * 1000);
  await page.goto("/sing.html?test=1");
  await page.waitForFunction(() => window.__cantor);
  await page.getByRole("button", { name: "Listen" }).click();
  // The file ends with as much silence as it starts with; stop inside it.
  await page.waitForTimeout((seconds - 1) * 1000);
  // The live trace has followed the take.
  expect(await page.evaluate(() => window.__cantor.frames.filter((f) => f.midi !== null).length)).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Listen" }).click();
  const heard = await page.evaluate(() => window.__cantor.heard());
  expect(heard).toBeDefined();
  expect(heard!.onset).not.toBeNull();
  await expect(page.locator("#status")).toHaveText(/^Heard /);
  const offset = want.lead_in_s + heard!.onset! - want.onset_s;
  const got = JSON.parse(
    await page.evaluate(([gabc, pulse, offset]) => window.__cantor.show(gabc, pulse, offset), [
      want.gabc,
      want.pulse_s,
      offset,
    ] as const),
  );
  const marks = (v: { marks: Array<{ kind: string; first: number; last: number }> }) =>
    v.marks.map((m) => `${m.kind} ${m.first}-${m.last}`);
  // The page times the notes as the core does, so the guide and the cursor lead the singer to
  // the times the take is judged by.
  const times = await page.evaluate((pulse) => window.__cantor.timed(pulse), want.pulse_s);
  const core: Array<{ start_s: number; dur_s: number }> = got.notes;
  expect(times).toHaveLength(core.length);
  times.forEach((t, i) => {
    expect(t.start + offset).toBeCloseTo(core[i]!.start_s, 3);
    expect(t.duration).toBeCloseTo(core[i]!.dur_s, 3);
  });
  const summary = {
    heard: [want.report.heard_fraction, got.report.heard_fraction],
    marks: [marks(want.verdict), marks(got.verdict)],
    key: [want.verdict.key_cents, got.verdict.key_cents],
    sampleRate: heard!.sampleRate,
    busy: Number(heard!.busy.toFixed(3)),
    stopMs: Number(heard!.stopMs.toFixed(1)),
    frames: heard!.frames,
    seconds: heard!.seconds,
  };
  console.log(`ear: ${JSON.stringify(summary)}`);
  // The ribbon the page draws is the core's, note for note, and agrees with the eval's: each
  // band's value, and the middle of the trace drawn for it.
  type Band = { cents: number | null; trace: Array<[number, number]> };
  const drawn = await page.locator("[data-band]").evaluateAll((els) =>
    els.map((el) => {
      const cents = (el as SVGGElement).dataset.cents;
      return { cents: cents ? Number(cents) : null, traced: el.querySelector("polyline.band-trace") !== null };
    }),
  );
  const median = (trace: Array<[number, number]>) => trace.map((p) => p[1]).sort((a, b) => a - b)[trace.length >> 1]!;
  const wanted: Band[] = want.ribbon;
  const ours: Band[] = got.ribbon;
  expect(ours).toHaveLength(wanted.length);
  const both = wanted.flatMap((w, i) => {
    const g = ours[i]!;
    return w.cents !== null && g.cents !== null
      ? [Math.max(Math.abs(w.cents - g.cents), Math.abs(median(w.trace) - median(g.trace)))]
      : [];
  });
  const apart = wanted.filter((w, i) => (w.cents === null) !== (ours[i]!.cents === null)).length;
  const ribbon = { notes: wanted.length, both: both.length, apart, worst: Math.max(...both).toFixed(1) };
  console.log(`ribbon: ${JSON.stringify(ribbon)}`);
  await info.attach("ear.json", { body: JSON.stringify({ ...summary, ribbon }, null, 2), contentType: "application/json" });
  await info.attach("page.png", { body: await page.screenshot(), contentType: "image/png" });
  expect(drawn).toEqual(
    ours.map((b) => ({ cents: b.cents === null ? null : Number(b.cents.toFixed(1)), traced: b.cents !== null })),
  );
  expect(both.length).toBeGreaterThan(0);
  expect(apart).toBeLessThanOrEqual(Math.ceil(HEARD_TOLERANCE * wanted.length));
  expect(Math.max(...both)).toBeLessThanOrEqual(BAND_TOLERANCE_CENTS);
  await expect(page.locator("#key")).toHaveText(/^Your key: /);
  // A heard note's band is a button that re-bases the ribbon on it, and back.
  const first = page.getByRole("button", { name: `Measure from note ${ours.findIndex((b) => b.cents !== null) + 1}`, exact: true });
  await first.click();
  await expect(page.locator("#base-text")).toHaveText(/^Measured from note /);
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Back to your key" }).click();
  await expect(page.locator("#base")).toBeHidden();
  // The marks drawn are the core's, on exactly the notes it marked, and they are the eval's;
  // a mark tapped (or entered) shows the core's words for it, and only one is open at a time.
  expect(marks(got.verdict)).toEqual(marks(want.verdict));
  type Marked = { first: number; last: number };
  const notesOf = (marks: Marked[]) => marks.flatMap((m) => Array.from({ length: m.last - m.first + 1 }, (_, k) => m.first + k));
  const ringed = await page.locator(".mark-ring").evaluateAll((els) => els.map((el) => Number((el as SVGElement).dataset.ring)));
  expect(ringed).toEqual(notesOf(got.verdict.marks));
  expect(ringed.length).toBeGreaterThan(0);
  expect(got.told.length).toBeGreaterThanOrEqual(2);
  const last = got.told.length - 1;
  await page.locator('[data-mark="0"]').click();
  await expect(page.locator("#why")).toHaveText(got.told[0]);
  await expect(page.locator('[data-mark="0"]')).toHaveAttribute("aria-expanded", "true");
  await page.locator(`[data-mark="${last}"]`).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#why")).toHaveText(got.told[last]);
  await expect(page.locator(`[data-mark="${last}"]`)).toBeFocused();
  await expect(page.locator('[data-mark="0"]')).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(page.locator("#why")).toHaveText("");
  await expect(page.locator("#status")).toHaveText("");
  // A new take clears the last one's view, the words of a mark left open with it.
  await page.locator('[data-mark="0"]').click();
  await expect(page.locator("#why")).toHaveText(got.told[0]);
  await page.getByRole("button", { name: "Listen" }).click();
  await expect(page.locator("#why")).toHaveText("");
  await expect(page.locator(".mark-ring")).toHaveCount(0);
  await expect(page.locator("#result")).toBeHidden();
  await page.getByRole("button", { name: "Listen" }).click();
  expect(Math.abs(got.report.heard_fraction - want.report.heard_fraction)).toBeLessThanOrEqual(HEARD_TOLERANCE);
  expect(Math.abs(got.verdict.key_cents - want.verdict.key_cents)).toBeLessThanOrEqual(KEY_TOLERANCE_CENTS);
});

test("a scored take is timed to the chant and judged as cantor eval judged it", async ({ page }) => {
  const want = readTake();
  const seconds = takeSeconds();
  test.setTimeout((seconds + 90) * 1000);
  await page.goto("/sing.html?test=1");
  await page.waitForFunction(() => window.__cantor);
  // A headless browser names no headphones: the take is given its opening notes, then the
  // cursor alone leads it.
  await expect(page.locator("#mode")).toHaveText(/^A take is scored with the opening notes only/);
  await page.locator("#headphones").check();
  await expect(page.locator("#mode")).toHaveText(/in your headphones \(as you said\)/);
  await page.locator("#headphones").uncheck();
  await page.evaluate(([gabc, pulse]) => window.__cantor.practise(gabc, pulse), [want.gabc, want.pulse_s] as const);
  const take = page.getByRole("button", { name: "Sing a take" });
  await take.click();
  await expect(page.locator("#status")).toHaveText("Listen to the opening notes.");
  await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
  await expect(page.locator("#status")).toHaveText("Begin with the cursor.", { timeout: 10_000 });
  // The take is judged when the chant is over, with nothing pressed.
  await expect(page.locator("#key")).toHaveText(/^Your key: /, { timeout: (seconds + 30) * 1000 });
  await expect(page.getByRole("button", { name: "Sing a take" })).toHaveAttribute("aria-pressed", "false");
  const ringed = await page.locator(".mark-ring").evaluateAll((els) => els.map((el) => Number((el as SVGElement).dataset.ring)));
  const wanted = want.verdict.marks.flatMap((m: { first: number; last: number }) =>
    Array.from({ length: m.last - m.first + 1 }, (_, k) => m.first + k),
  );
  expect(ringed).toEqual(wanted);
});

