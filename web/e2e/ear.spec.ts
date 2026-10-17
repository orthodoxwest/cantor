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

type Cadenced = { verdict: { cadences: Array<{ cents: number | null }> }; summary: string[] };
/** Whether a cadence is within the band tolerance of where the judge calls it off
 * (cantor-core's `CADENCE_CENTS`), where the two ears may call it either way. */
const nearLine = (c: { cents: number | null }) => c.cents !== null && Math.abs(Math.abs(c.cents) - 100) < BAND_TOLERANCE_CENTS;
const borderline = (take: Cadenced) => take.verdict.cadences.some(nearLine);
const offPitch = (c: { cents: number | null }) => (c.cents === null ? null : Math.abs(c.cents) >= 100);

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
  await page.evaluate(() => void window.__cantor.listen());
  // The file ends with as much silence as it starts with; stop inside it.
  await page.waitForTimeout((seconds - 1) * 1000);
  // The live trace has followed the take.
  expect(await page.evaluate(() => window.__cantor.frames.filter((f) => f.midi !== null).length)).toBeGreaterThan(100);
  await page.evaluate(() => void window.__cantor.listen());
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
  await expect(page.locator("#key")).toHaveText(/^You started /);
  // A note's band is a button that chooses its phrase, to hear it alone.
  await page.getByRole("button", { name: "Choose the phrase of note 1", exact: true }).click();
  await expect(page.locator("#chosen-text")).toHaveText(/^Notes? 1/);
  await page.locator("#chosen").getByRole("button", { name: "Whole chant" }).click();
  type Marked = { first: number; last: number };
  // The endings it counts off pitch are the cadences off pitch the summary tells of, each told of
  // its note furthest off; a place with the marks unless a mark on its notes tells of it already.
  type Told = { first: number; last: number; note: number; mark: number | null; words: string };
  type Off = { first: number; last: number; note: number | null; cents: number | null };
  const endings: Told[] = got.endings ?? [];
  const off: Off[] = got.verdict.cadences.filter((c: Off) => offPitch(c));
  expect(endings.map(({ first, last, note }) => ({ first, last, note }))).toEqual(
    got.verdict.outcome === "heard" ? off.map(({ first, last, note }) => ({ first, last, note })) : [],
  );
  for (const e of endings) {
    expect(e.note).toBeGreaterThanOrEqual(e.first);
    expect(e.note).toBeLessThanOrEqual(e.last);
    // A note's mark over it tells of it already; any mark it names is on its notes.
    const covers = (m: Marked) => m.first <= e.note && e.note <= m.last;
    const over = got.verdict.marks.findIndex((m: Marked & { kind: string }) => m.kind === "note" && covers(m));
    if (over >= 0) expect(e.mark).toBe(over);
    if (e.mark !== null) {
      const m: Marked = got.verdict.marks[e.mark];
      expect(m.first <= e.last && e.first <= m.last).toBe(true);
    }
  }
  const alone = endings.filter((e) => e.mark === null);
  const count = (n: number, one: string) => (n ? [` · ${n} ${one}${n === 1 ? "" : "s"}`] : []);
  await expect(page.locator("#chosen-text")).toHaveText(["Whole chant", ...count(got.verdict.marks.length, "mark"), ...count(alone.length, "ending")].join(""));
  // The marks drawn are the core's, on exactly the notes it marked, and they are the eval's;
  // a mark tapped (or entered) shows the core's words for it in its card, and only one is open
  // at a time.
  expect(marks(got.verdict)).toEqual(marks(want.verdict));
  // So are the two sentences on the take as a whole, but for a cadence too near the line to
  // call; the page shows the core's.
  expect(got.summary).toHaveLength(2);
  const cadences = (take: Cadenced) => take.verdict.cadences.map((c) => (nearLine(c) ? "near" : offPitch(c)));
  expect(cadences(got).filter((c, i) => c !== "near" && cadences(want)[i] !== "near")).toEqual(
    cadences(want).filter((c, i) => c !== "near" && cadences(got)[i] !== "near"),
  );
  expect(got.summary[0]).toEqual(want.summary[0]);
  if (!borderline(want) && !borderline(got)) expect(got.summary).toEqual(want.summary);
  await expect(page.locator("#summary")).toHaveText(got.summary.join(" "));
  const notesOf = (marks: Marked[]) => marks.flatMap((m) => Array.from({ length: m.last - m.first + 1 }, (_, k) => m.first + k));
  const ringed = await page.locator(".mark-ring").evaluateAll((els) => els.map((el) => Number((el as SVGElement).dataset.ring)));
  expect(ringed).toEqual(notesOf(got.verdict.marks));
  expect(ringed.length).toBeGreaterThan(0);
  expect(got.told.length).toBeGreaterThanOrEqual(2);
  const last = got.told.length - 1;
  const words = page.locator("#why-words");
  await page.locator('[data-mark="0"]').click();
  await expect(words).toHaveText(got.told[0]);
  await expect(page.locator('[data-mark="0"]')).toHaveAttribute("aria-expanded", "true");
  await page.locator(`[data-mark="${last}"]`).focus();
  await page.keyboard.press("Enter");
  await expect(words).toHaveText(got.told[last]);
  await expect(page.locator(`[data-mark="${last}"]`)).toBeFocused();
  await expect(page.locator('[data-mark="0"]')).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(page.locator("#why")).toBeHidden();
  await expect(page.locator("#status")).toHaveText("");
  // The marks are written out too under the score, each once, each opening its ring on the
  // score, with the endings off pitch among them; folded by phrase, the phrases in the order
  // sung. The places are the marks, then the endings.
  const places: Array<Marked & { words: string }> = [
    ...got.verdict.marks.map((m: Marked, k: number) => ({ first: m.first, last: m.last, words: got.told[k] })),
    ...alone,
  ];
  const listed = page.locator("#marked button");
  await expect(listed).toHaveCount(places.length);
  for (const summary of await page.locator("#marked summary").all()) await summary.click();
  const opened = await listed.evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.opens)));
  expect([...opened].sort((a, b) => a - b)).toEqual(places.map((_, k) => k));
  const firsts = await page.locator("#marked > li").evaluateAll((items) =>
    items.map((item) => [...item.querySelectorAll<HTMLElement>("[data-opens]")].map((b) => Number(b.dataset.opens))),
  );
  const sungFirst = firsts.map((ks) => Math.min(...ks.map((k) => places[k]!.first)));
  expect(sungFirst).toEqual([...sungFirst].sort((a, b) => a - b));
  for (const [i, k] of opened.entries()) {
    const m = places[k]!;
    const at = m.first === m.last ? `Note ${m.first + 1}` : `Notes ${m.first + 1} to ${m.last + 1}`;
    await expect(listed.nth(i)).toHaveText(new RegExp(`^${at}(, “[^”]+”)?: `));
    expect((await listed.nth(i).textContent())!.endsWith(`: ${m.words}`)).toBe(true);
  }
  // The second mark listed opens its ring.
  const nth = opened.flatMap((k, i) => (k < got.verdict.marks.length ? [i] : []))[1]!;
  const second = opened[nth]!;
  await listed.nth(nth).click();
  await expect(words).toHaveText(got.told[second]);
  await expect(page.locator(`[data-mark="${second}"]`)).toHaveAttribute("aria-expanded", "true");
  await expect(listed.nth(nth)).toHaveAttribute("aria-expanded", "true");
  await expect(listed.nth(nth)).toBeFocused();
  // Its ring and the band that shows why are on the screen, clear of the card.
  await expect
    .poll(() =>
      page.evaluate(
        ([k, first]) => {
          const card = document.getElementById("why")!.getBoundingClientRect();
          const boxes = [`[data-mark="${k}"]`, `[data-band="${first}"]`].map((q) => document.querySelector(q)!.getBoundingClientRect());
          return boxes.every((b) => b.top >= 0 && b.bottom <= card.top + 1);
        },
        [second, got.verdict.marks[second].first as number] as const,
      ),
    )
    .toBe(true);
  await listed.nth(nth).click();
  await expect(page.locator("#why")).toBeHidden();
  await expect(listed.nth(nth)).toHaveAttribute("aria-expanded", "false");
  // A new take clears the last one's view, the card of a mark left open with it.
  await page.locator('[data-mark="0"]').click();
  await expect(words).toHaveText(got.told[0]);
  await page.evaluate(() => void window.__cantor.listen());
  await expect(page.locator("#why")).toBeHidden();
  await expect(page.locator(".mark-ring")).toHaveCount(0);
  await expect(page.locator("#result")).toBeHidden();
  await page.evaluate(() => void window.__cantor.listen());
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
  await expect(page.locator("#status")).toHaveText("Begin when the cursor appears.", { timeout: 10_000 });
  // While it is sung the page shows the cursor and the note heard, and nothing else: no words,
  // no ribbon, no marks.
  await expect(page.locator("#status")).toHaveText("", { timeout: 5000 });
  await expect(page.locator(".mode")).toBeHidden();
  await expect(page.locator("#find")).toBeDisabled();
  await expect(page.locator("#readout")).toHaveText(/^[A-G]♯?\d$/, { timeout: 5000 });
  await expect(page.locator("#result")).toBeHidden();
  await expect(page.locator(".mark-ring, .band-trace")).toHaveCount(0);
  await expect(page.locator("#why")).toBeHidden();
  // The take is judged when the chant is over, with nothing pressed.
  await expect(page.locator("#key")).toHaveText(/^You started /, { timeout: (seconds + 30) * 1000 });
  await expect(take).toHaveText("Sing a take");
  // The result comes into view above the score.
  await expect(page.locator("#result")).toBeInViewport();
  await expect(page.locator("#cut")).toBeHidden();
  await expect(page.locator("#status")).toHaveText("");
  await expect(page.locator(".mode")).toBeVisible();
  await expect(page.locator("#find")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Guide" })).toBeEnabled();
  // The first note was due when the cursor began, a moment after listening did; the take was
  // timed by the singer's first sound, which is where the file's voice begins.
  const timing = (await page.evaluate(() => window.__cantor.take()))!;
  expect(timing.due).toBeGreaterThan(1.45);
  expect(timing.due).toBeLessThan(2);
  const heard = (await page.evaluate(() => window.__cantor.heard()))!;
  expect(timing.at).toBe(timing.sound);
  expect(Math.abs(timing.sound! - heard.onset!)).toBeLessThan(0.1);
  const ringed = await page.locator(".mark-ring").evaluateAll((els) => els.map((el) => Number((el as SVGElement).dataset.ring)));
  const wanted = want.verdict.marks.flatMap((m: { first: number; last: number }) =>
    Array.from({ length: m.last - m.first + 1 }, (_, k) => m.first + k),
  );
  expect(ringed).toEqual(wanted);
  // The take's own sentences: its tone as the eval's, its cadences as the eval's but for one
  // too near the line to call.
  const told = (await page.locator("#summary").textContent()) ?? "";
  expect(told.startsWith(want.summary[0])).toBe(true);
  if (!borderline(want)) expect(told).toEqual(want.summary.join(" "));
  else expect(told).toMatch(/endings?( heard clearly)? (was|were|went)|heard clearly, and it (was|went)/);
  // The next take clears this one's view, and Stop ends it.
  await page.locator('[data-mark="0"]').click();
  await expect(page.locator("#why")).toBeVisible();
  await take.click();
  await expect(page.locator("#why")).toBeHidden();
  await expect(page.locator(".mark-ring")).toHaveCount(0);
  await expect(page.locator("#result")).toBeHidden();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator("#status")).toHaveText("The take was stopped before the chant began.");
  await expect(take).toHaveText("Sing a take");
});

test("Stop during the chant ends the take there and shows what was sung", async ({ page }) => {
  const want = readTake();
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sing.html?test=1");
  await page.waitForFunction(() => window.__cantor);
  await page.evaluate(([gabc, pulse]) => window.__cantor.practise(gabc, pulse), [want.gabc, want.pulse_s] as const);
  const take = page.getByRole("button", { name: "Sing a take" });
  await take.click();
  // Some way into the chant, the singer stops.
  await expect(page.locator("#readout")).toHaveText(/^[A-G]♯?\d$/, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.__cantor.visited.length), { timeout: 30_000 }).toBeGreaterThan(12);
  await page.getByRole("button", { name: "Stop" }).click();
  // What was sung is judged and shown, with where it stopped.
  await expect(page.locator("#cut")).toHaveText(/^You stopped the take at note \d+ of \d+, so it is judged through note \d+, where the last phrase you sang through ended\.$/, { timeout: 30_000 });
  await expect(page.locator("#key")).toHaveText(/^You started /);
  // Only the notes to the end of the last phrase finished have bands, none past the note stopped at.
  const [, at, through] = /note (\d+) of \d+, so it is judged through note (\d+)/.exec((await page.locator("#cut").textContent())!)!.map(Number);
  expect(through).toBeLessThanOrEqual(at!);
  await expect(page.locator("[data-band]")).toHaveCount(through!);
  await expect(page.locator("#result")).toBeInViewport();
  await expect(page.locator("#status")).toHaveText("");
  await expect(take).toBeEnabled();
  await expect(page.locator("#readout")).toHaveText("–");
});
