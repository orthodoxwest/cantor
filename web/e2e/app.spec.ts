import { expect, test, type Page } from "@playwright/test";
import type { Timeline } from "neuma";

const PULSE = 0.5;

/** Installs a fake clock that moves only by `runFor`. One left to flow with real time catches
 * up with it whenever the page reads it inside a timer, and `runFor` then sets it back to the
 * next timer's due time: on a slow machine the cursor could step back. */
async function holdClock(page: Page): Promise<void> {
  const now = Date.now();
  await page.clock.install({ time: now });
  // Far enough ahead that it is still to come when the pause reaches the page.
  await page.clock.pauseAt(now + 60_000);
}

/** Waits for a play to start, so that the cursor follows the clock from here. */
async function following(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__cantor.following)).toBe(true);
}

/** Opens the practice page and waits until it has its voice (or has given up on one). */
async function open(page: Page, query = ""): Promise<Timeline> {
  await page.goto(`/sing.html?test=1${query}`);
  await expect(page.locator("#score svg")).toBeVisible();
  await page.waitForFunction(() => window.__cantor);
  return page.evaluate(() => window.__cantor.timeline);
}

/** Waits until the ring of mark `k` (or the element `k` selects, an ending's note) and the band
 * under its first note are on the screen, clear of the card over the bar. */
async function clearOfCard(page: Page, k: number | string, first: number): Promise<void> {
  const place = typeof k === "number" ? `[data-mark="${k}"]` : k;
  await expect
    .poll(() =>
      page.evaluate(
        ([place, first]) => {
          const card = document.getElementById("why")!.getBoundingClientRect();
          const boxes = [place, `[data-band="${first}"]`].map((q) => document.querySelector(q)!.getBoundingClientRect());
          return boxes.every((b) => b.top >= 0 && b.bottom <= card.top + 1);
        },
        [place, first] as const,
      ),
    )
    .toBe(true);
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
  await holdClock(page);
  const timeline = await open(page);
  await page.getByRole("button", { name: "Play" }).click();
  await following(page);
  await page.clock.runFor(PULSE * 1000);
  await expect(page.locator("#score .cantor-current")).toHaveCount(1);
  await expect(page.locator("#score .cursor")).toBeVisible();
  await page.clock.runFor((timeline.duration + 1) * PULSE * 1000);
  expect(await page.evaluate(() => window.__cantor.visited)).toEqual(timeline.notes.map((n) => n.id));
  await expect(page.locator("#score .cursor")).toBeHidden();
});

test("start note sounds the first note, then the reciting tone, and stops Play", async ({ page }) => {
  await page.clock.install();
  await open(page);
  const play = page.getByRole("button", { name: "Play" });
  const note = page.getByRole("button", { name: "Start note" });
  await play.click();
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await note.click();
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await expect(note).toHaveAttribute("aria-pressed", "true");
  // An antiphon has no reciting tone, so one note sounds: its first.
  const first = await page.evaluate(() => 60 + window.__cantor.timeline.notes[0]!.semitones);
  await expect.poll(() => page.evaluate(() => window.__cantor.pitch.map((m) => m % 12))).toEqual([first % 12]);
  // It ends by itself.
  await page.clock.runFor(3000);
  await expect(note).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.pitch)).toEqual([]);
  // Pressed again while it sounds, it stops.
  await note.click();
  await expect.poll(() => page.evaluate(() => window.__cantor.pitch.length)).toBe(1);
  await expect(note).toHaveAttribute("aria-pressed", "true");
  await note.click();
  await expect(note).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.pitch)).toEqual([]);
  // A chant with a reciting tone gives it after the first note.
  await page.evaluate(() => window.__cantor.practise("(c4) Glo(f)ry(hr) be(h) to(h) the(h) Fa(h)ther(g) (::)", 0.5));
  await note.click();
  await expect.poll(() => page.evaluate(() => window.__cantor.pitch.map((m) => m % 12))).toEqual([5, 9]);
});

test("drone holds the reciting note until pressed again, and never sounds in a take", async ({ page }) => {
  await page.clock.install();
  await open(page);
  const drone = page.getByRole("button", { name: "Drone" });
  await drone.click();
  await expect(drone).toHaveAttribute("aria-pressed", "true");
  // Lumen gentium, mode viii, ends on G: its reciting note is C.
  await expect.poll(() => page.evaluate(() => window.__cantor.drone)).not.toBeNull();
  expect((await page.evaluate(() => window.__cantor.drone))! % 12).toBe(0);
  // It goes on under Play.
  await page.getByRole("button", { name: "Play" }).click();
  await page.clock.runFor(2000);
  await expect(page.locator("#score .cursor")).toBeVisible();
  expect(await page.evaluate(() => window.__cantor.drone)).not.toBeNull();
  await drone.click();
  await expect(drone).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.drone)).toBeNull();
  // A verse of the first tone, by its own header, drones on its reciting tone, A.
  await page.evaluate(() => window.__cantor.practise("mode:1;\n%%\n(c4) Glo(f)ry(hr) be(h) to(h) the(h) Fa(g)ther(d) (::)", 0.5));
  await drone.click();
  await expect.poll(() => page.evaluate(() => (window.__cantor.drone ?? 0) % 12)).toBe(9);
  // Pressed off it fades; a take begun as it fades cuts it at once, and holds Drone off.
  const [fading, inTake] = await page.evaluate(() => {
    document.getElementById("drone")!.click();
    const fading = window.__cantor.drones;
    document.getElementById("take")!.click();
    return [fading, window.__cantor.drones];
  });
  expect(fading).toBeGreaterThan(0);
  expect(inTake).toBe(0);
  await expect(drone).toBeDisabled();
  await expect(drone).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(drone).toBeEnabled();
});

test("speed and pitch move the guide, the cursor, Start note and Drone, and stay in the address", async ({ page }) => {
  await holdClock(page);
  const timeline = await open(page);
  const first = await page.evaluate(() => window.__cantor.timeline.notes[0]!.semitones);
  const drone = page.getByRole("button", { name: "Drone" });
  await drone.click();
  await expect.poll(() => page.evaluate(() => window.__cantor.drone)).not.toBeNull();
  const droned = (await page.evaluate(() => window.__cantor.drone))!;
  await page.getByLabel("Pitch").selectOption("2");
  await expect(page.locator("#do")).toHaveText("The clef’s do is D.");
  // The drone follows at once, a tone up.
  await expect.poll(() => page.evaluate(() => window.__cantor.drone)).toBe(droned + 2);
  await page.getByRole("button", { name: "Start note" }).click();
  await expect.poll(() => page.evaluate(() => window.__cantor.pitch.map((m) => m % 12))).toEqual([(((60 + first + 2) % 12) + 12) % 12]);
  // Speed leaves the drone sounding as it was, once the retuned one's fade is done.
  await expect.poll(() => page.evaluate(() => window.__cantor.drones)).toBe(1);
  await page.getByLabel("Speed").selectOption("Slow");
  expect(await page.evaluate(() => window.__cantor.drones)).toBe(1);
  expect(await page.evaluate(() => window.__cantor.drone)).toBe(droned + 2);
  expect(new URL(page.url()).searchParams.get("speed")).toBe("0.65");
  expect(new URL(page.url()).searchParams.get("pitch")).toBe("2");
  // The guide sings slower, and the cursor takes as long to cross: at the steady pulse it
  // would be done by now, at the slow one not.
  await page.getByRole("button", { name: "Play" }).click();
  await following(page);
  await page.clock.runFor((timeline.duration * 0.5 + 0.5) * 1000);
  await expect(page.locator("#score .cursor")).toBeVisible();
  expect(await page.evaluate(() => window.__cantor.sung.map((n) => n.midi % 12)[0])).toBe((((60 + first + 2) % 12) + 12) % 12);
  await page.clock.runFor((timeline.duration * 0.2 + 1) * 1000);
  await expect(page.locator("#score .cursor")).toBeHidden();
  expect(await page.evaluate(() => window.__cantor.visited)).toEqual(timeline.notes.map((n) => n.id));
  // Changed mid-play, the play stops.
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Speed").selectOption("Steady");
  await expect(page.getByRole("button", { name: "Play" })).toHaveAttribute("aria-pressed", "false");
  // However far it is moved, the guide stays where its voice is at home.
  for (const shift of ["-7", "7", "2"]) {
    await page.getByLabel("Pitch").selectOption(shift);
    const [centre, midis] = await page.evaluate(() => [window.__cantor.centre!, window.__cantor.sung.map((n) => n.midi)] as const);
    const middle = [...midis].sort((a, b) => a - b)[Math.floor(midis.length / 2)]!;
    expect(Math.abs(middle - centre)).toBeLessThanOrEqual(6);
  }
  await page.getByLabel("Speed").selectOption("Slow");
  // A take holds them where they are.
  await page.getByRole("button", { name: "Sing a take" }).click();
  await expect(page.getByLabel("Speed")).toBeDisabled();
  await expect(page.getByLabel("Pitch")).toBeDisabled();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByLabel("Pitch")).toBeEnabled();
  // Opened again from the address, they are as left.
  await page.reload();
  await expect(page.getByLabel("Pitch")).toHaveValue("2");
  await expect(page.getByLabel("Speed")).toHaveValue("0.65");
});

test("a phrase tapped plays over and over with the cursor, a bar loops the phrase it ends", async ({ page }) => {
  await holdClock(page);
  const timeline = await open(page);
  // Lumen gentium: a mediant before note 3, a half bar before note 12, a double bar at the end.
  const ids = timeline.notes.map((n) => n.id);
  await page.locator(`#score [data-note~="${ids[5]}"]`).first().click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 10]);
  await expect(page.locator("#loop-text")).toHaveText("Play goes over notes 3 to 11 until you stop it.");
  const play = page.getByRole("button", { name: "Play" });
  await play.click();
  await following(page);
  const times = await page.evaluate(() => window.__cantor.timed(0.5));
  const length = times[10]!.start + times[10]!.duration - times[2]!.start;
  await page.clock.runFor((length + 0.3) * 1000);
  // Once round: the phrase's notes, and only those; the cursor does not go on to the half bar
  // after it.
  expect(await page.evaluate(() => window.__cantor.visited)).toEqual(ids.slice(2, 11));
  await expect(page.locator("#score .cursor")).toBeHidden();
  await expect(play).toHaveAttribute("aria-pressed", "true");
  // After a breath (two pulses: 1 s) it goes round again, the cursor back at the phrase's first note.
  await page.clock.runFor(1000 + 300);
  await following(page);
  await page.clock.runFor(300);
  await expect(page.locator("#score .cursor")).toBeVisible();
  const again = await page.evaluate(() => window.__cantor.visited);
  expect(again[0]).toBe(ids[2]);
  expect(again.length).toBeLessThan(5);
  // The note sounding is marked apart from the rest of the loop.
  const [current, other] = await page.evaluate((id) => {
    const fill = (el: Element) => getComputedStyle(el).fill;
    return [fill(document.querySelector("#score .cantor-current")!), fill(document.querySelector(`#score [data-note~="${id}"]`)!)];
  }, ids[10]);
  expect(current).not.toBe(other);
  // And the loop apart from the notes outside it.
  const fillOf = (id: number) => page.evaluate((i) => getComputedStyle(document.querySelector(`#score [data-note~="${i}"]`)!).fill, id);
  expect(await fillOf(ids[10]!)).not.toBe(await fillOf(ids[12]!));
  await play.click();
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await page.clock.runFor(5000);
  await expect(page.locator("#score .cursor")).toBeHidden();
  // A tap in the loop lets it go; a tap on the half bar loops the phrase it ends.
  await page.locator(`#score [data-note~="${ids[3]}"]`).first().click();
  expect(await page.evaluate(() => window.__cantor.loop)).toBeNull();
  const bar = timeline.pauses.find((p) => p.kind === "half")!.bar!;
  const line = timeline.lines[bar.line]!;
  await page.locator("#score").click({ position: { x: bar.cx, y: (line.top + line.bottom) / 2 } });
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 10]);
  // Tapping the next phrase stretches the loop to it; Whole chant lets it go.
  await page.locator(`#score [data-note~="${ids[15]}"]`).first().click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, ids.length - 1]);
  // A take leaves the loop alone, and the score unmarked by it.
  await page.getByRole("button", { name: "Sing a take" }).click();
  await expect(page.locator("#loop")).toBeHidden();
  const tinted = await page.evaluate(
    (id) => getComputedStyle(document.querySelector(`#score [data-note~="${id}"]`)!).fill,
    ids[5],
  );
  const plain = await page.evaluate(
    (id) => getComputedStyle(document.querySelector(`#score [data-note~="${id}"]`)!).fill,
    ids[0],
  );
  expect(tinted).toBe(plain);
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Whole chant" }).click();
  expect(await page.evaluate(() => window.__cantor.loop)).toBeNull();
});

test("beside a take, a note, a band or a mark tapped chooses its phrase, named in the bar", async ({ page }) => {
  await open(page);
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(g) (::)";
  await page.evaluate(([g]) => window.__cantor.practise(g, 0.5), [gabc] as const);
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  const fillOf = (id: number) => page.evaluate((i) => getComputedStyle(document.querySelector(`#score [data-note~="${i}"]`)!).fill, id);
  await page.evaluate(() => void window.__cantor.listen());
  await page.waitForTimeout(3000);
  await page.evaluate(() => void window.__cantor.listen());
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  await expect(page.locator("#result")).toBeVisible();
  await expect(page.locator("#reading")).toBeVisible();
  const chosen = page.locator("#chosen");
  const chosenText = page.locator("#chosen-text");
  // The bar counts the marks (the A4 heard is marked on note 3) until a phrase is chosen.
  await expect(chosenText).toHaveText("Whole chant · 1 mark");
  // A note tapped chooses its phrase, tinted on the score and named in the bar.
  await page.locator(`#score [data-note~="${ids[3]}"]`).first().click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  expect(await fillOf(ids[3]!)).not.toBe(await fillOf(ids[0]!));
  await expect(page.locator("#loop")).toBeHidden();
  await expect(chosen).toBeVisible();
  await expect(chosenText).toHaveText("Notes 3 to 6 · “al … ia”");
  // The bands do not move when tapped: a band chooses its phrase as its note does, and the
  // phrase chosen tapped again lets it go.
  const band = page.getByRole("button", { name: "Choose the phrase of note 1", exact: true });
  const before = await page.locator("[data-band] .band-held").evaluateAll((els) => els.map((el) => el.getAttribute("y1")));
  await band.click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([0, 5]);
  expect(await page.locator("[data-band] .band-held").evaluateAll((els) => els.map((el) => el.getAttribute("y1")))).toEqual(before);
  // A band in the run chosen narrows it to its phrase, and with nothing narrower lets it go.
  await page.getByRole("button", { name: "Choose the phrase of note 2", exact: true }).click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([0, 1]);
  await page.getByRole("button", { name: "Choose the phrase of note 2", exact: true }).click();
  expect(await page.evaluate(() => window.__cantor.loop)).toBeNull();
  await expect(chosenText).toHaveText("Whole chant · 1 mark");
  await page.getByRole("button", { name: "Choose the phrase of note 5", exact: true }).click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  // The bands chosen are pressed, the first of them the one tab stop; the arrows move along.
  const pressed = () => page.locator("[data-band]").evaluateAll((els) => els.map((el) => [el.getAttribute("aria-pressed"), el.getAttribute("tabindex")]));
  expect(await pressed()).toEqual([["false", "-1"], ["false", "-1"], ["true", "0"], ["true", "-1"], ["true", "-1"], ["true", "-1"]]);
  await page.getByRole("button", { name: "Choose the phrase of note 3", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Choose the phrase of note 4", exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  // Whole chant in the bar lets it go, and leaves the keyboard on Yours.
  await chosen.getByRole("button", { name: "Whole chant" }).click();
  expect(await page.evaluate(() => window.__cantor.loop)).toBeNull();
  await expect(chosen.getByRole("button", { name: "Whole chant" })).toBeHidden();
  await expect(page.locator("#hear")).toBeFocused();
  // A mark opened, on the score or in the list, chooses the phrase it is in and opens its card;
  // closed, it leaves the phrase chosen.
  const ring = page.getByRole("button", { name: "Why note 3 is marked" });
  await ring.click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  await expect(page.locator("#why")).toBeVisible();
  await expect(chosenText).toHaveText("Mark 1 of 1 · “al”");
  await ring.click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  await expect(page.locator("#why")).toBeHidden();
  await expect(chosenText).toHaveText("Notes 3 to 6 · “al … ia”");
  await chosen.getByRole("button", { name: "Whole chant" }).click();
  await page.locator("#marked summary").first().click();
  await page.locator("#marked button").first().click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  await expect(chosen).toBeVisible();
  // Another phrase chosen closes the card, so that its words do not stay with another phrase.
  await page.getByRole("button", { name: "Choose the phrase of note 1", exact: true }).click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([0, 5]);
  await expect(page.locator("#why")).toBeHidden();
  await page.locator("#marked button").first().click();
  await expect(page.locator("#why")).toBeVisible();
  // The card stays in view above the bar, however tall the chosen line makes it on a phone.
  await page.setViewportSize({ width: 390, height: 600 });
  // Once the bar's new height is measured, which is before the page is next drawn.
  await expect
    .poll(async () => {
      const why = await page.locator("#why").boundingBox();
      const bar = await page.locator(".bar").boundingBox();
      return why!.y + why!.height - bar!.y;
    })
    .toBeLessThanOrEqual(1);
  // Another take shown lets the run go, and the card: Yours plays it whole until a phrase is chosen.
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  expect(await page.evaluate(() => window.__cantor.loop)).toBeNull();
  await expect(chosenText).toHaveText("Whole chant · 1 mark");
  await expect(page.locator("#why")).toBeHidden();
});

test("a phrase after where a take was stopped is sung by the guide, and your take says it has none", async ({ page }) => {
  await open(page);
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(g) (::)";
  await page.evaluate(([g]) => window.__cantor.practise(g, 0.5), [gabc] as const);
  await page.evaluate(() => void window.__cantor.listen());
  await page.waitForTimeout(3000);
  await page.evaluate(() => void window.__cantor.listen());
  // Stopped at note 4: judged through the first phrase.
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2, 3), [gabc] as const);
  await expect(page.locator("[data-band]")).toHaveCount(2);
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  await page.locator(`#score [data-note~="${ids[3]}"]`).first().click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  await expect(page.locator("#chosen-text")).toHaveText("Notes 3 to 6 · “al … ia” · after your take stopped");
  await page.getByRole("button", { name: "Yours" }).click();
  await expect(page.locator("#status")).toHaveText("You stopped the take before this phrase, so there is none of it to hear.");
  expect(await page.evaluate(() => window.__cantor.replayed.playing)).toBe(false);
  // Nor does Compare, which would end on it.
  await page.locator("#status").evaluate((el) => (el.textContent = ""));
  await page.getByRole("button", { name: "Compare" }).click();
  await expect(page.locator("#status")).toHaveText("You stopped the take before this phrase, so there is none of it to hear.");
  expect(await page.evaluate(() => window.__cantor.following)).toBe(false);
  // Its band is still reached by the keyboard; another choice lets the words go.
  await expect(page.locator('[data-band][tabindex="0"]')).toHaveCount(1);
  await page.locator("#chosen").getByRole("button", { name: "Whole chant" }).click();
  await expect(page.locator("#status")).toHaveText("");
  // Over the whole chant, Compare plays the guide only as far as the take was judged, then the take.
  const compare = page.getByRole("button", { name: "Compare" });
  await compare.click();
  await expect(compare).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 });
  expect(await page.evaluate(() => window.__cantor.visited)).toEqual(ids.slice(0, 2));
  expect((await page.evaluate(() => window.__cantor.played)).midi).toHaveLength(2);
  expect(await page.evaluate(() => window.__cantor.replayed.visited)).toEqual(ids.slice(0, 2));
  // Stopped before its first phrase was sung through, Compare has nothing to play; Yours plays
  // what there is.
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2, 0), [gabc] as const);
  const asked = (await page.evaluate(() => window.__cantor.played)).plays;
  await compare.click();
  await expect(page.locator("#status")).toHaveText("You stopped the take before its first phrase was sung through, so there is nothing to compare yet.");
  expect((await page.evaluate(() => window.__cantor.played)).plays).toBe(asked);
  await expect(compare).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Yours" }).click();
  await expect.poll(() => page.evaluate(() => window.__cantor.replayed.playing)).toBe(true);
  await expect(page.locator("#status")).toHaveText("");
  await page.getByRole("button", { name: "Yours" }).click();
});

test("on a phone, beside a take, the bar puts Compare, Guide and Yours above Repeat, Drone and Sing a take", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await open(page);
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(g) (::)";
  await page.evaluate(([g]) => window.__cantor.practise(g, 0.5), [gabc] as const);
  await page.evaluate(() => void window.__cantor.listen());
  await page.waitForTimeout(2000);
  await page.evaluate(() => void window.__cantor.listen());
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  await expect(page.getByRole("button", { name: "Yours" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Drone" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start note" })).toBeHidden();
  // Guide leaves the take shown, and the bar as it is.
  await page.getByRole("button", { name: "Guide" }).click();
  await page.getByRole("button", { name: "Guide" }).click();
  await expect(page.getByRole("button", { name: "Drone" })).toBeVisible();
  // Two rows, in the page's own face: what plays the take back, then what practises it.
  await page.evaluate(() => document.fonts.ready);
  const rows = await page
    .locator(".bar-in > button:visible")
    .evaluateAll((els) => {
      const by = new Map<number, string[]>();
      for (const el of els) {
        const top = Math.round(el.getBoundingClientRect().top);
        by.set(top, [...(by.get(top) ?? []), el.textContent!]);
      }
      return [...by.entries()].sort(([a], [b]) => a - b).map(([, names]) => names);
    });
  expect(rows).toEqual([["Compare", "Guide", "Yours"], ["Repeat", "Drone", "Sing a take"]]);
});

test("your take plays back against the score with the cursor, and stops for the guide", async ({ page }) => {
  await open(page);
  const hear = page.getByRole("button", { name: "Yours" });
  await expect(hear).toBeHidden();
  // Two seconds heard from the microphone, judged as a two-note chant from 0.2 s.
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(2000);
  await page.evaluate(() => void window.__cantor.listen());
  const gabc = "(c4) A(h) men.(h) (::)";
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  await expect(hear).toBeVisible();
  await hear.click();
  await expect(hear).toHaveAttribute("aria-pressed", "true");
  // The cursor in the trace's colour: the singer's voice, not the guide's.
  await expect(page.locator("#score .cursor.take")).toBeVisible();
  // It ends by itself, having marked both notes in turn.
  await expect(hear).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  expect(await page.evaluate(() => window.__cantor.replayed.visited)).toEqual(ids);
  await expect(page.locator("#score .cursor")).toBeHidden();
  // Guide stops it, and keeps the take, to hear again against the guide.
  await hear.click();
  await expect.poll(() => page.evaluate(() => window.__cantor.replayed.playing)).toBe(true);
  const play = page.getByRole("button", { name: "Guide" });
  await play.click();
  expect(await page.evaluate(() => window.__cantor.replayed.playing)).toBe(false);
  await expect(page.locator("#hear")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#result")).toBeVisible();
  await expect(hear).toBeVisible();
  await expect(page.locator("#score .cursor:not(.take)")).toBeVisible();
  await play.click();
  await expect(play).toHaveAttribute("aria-pressed", "false");
  // Start note pressed while the take's audio is still being fetched stops it before it sounds.
  await expect(page.locator("#note")).toBeEnabled();
  await page.evaluate(() => {
    document.getElementById("hear")!.click();
    document.getElementById("note")!.click();
  });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__cantor.replayed.playing)).toBe(false);
  await expect(page.locator("#hear")).toHaveAttribute("aria-pressed", "false");
});

test("the screen is kept on while the guide plays and through a take, and let go after", async ({ page }) => {
  // The browser's lock, faked: whether one is held.
  await page.addInitScript(() => {
    const w = window as unknown as { held: number };
    w.held = 0;
    Object.defineProperty(navigator, "wakeLock", {
      value: {
        request: async () => {
          w.held++;
          let released = false;
          return {
            get released() {
              return released;
            },
            release: async () => {
              if (!released) w.held--;
              released = true;
            },
          };
        },
      },
    });
  });
  await open(page);
  const held = () => page.evaluate(() => (window as unknown as { held: number }).held);
  expect(await held()).toBe(0);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(held).toBe(1);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(held).toBe(0);
  await page.getByRole("button", { name: "Sing a take" }).click();
  await expect.poll(held).toBe(1);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Sing a take" })).toBeEnabled();
  await expect.poll(held).toBe(0);
});

test("the key a take was sung in is told against the guide's, which then sings in it", async ({ page }) => {
  await open(page);
  // The microphone's A4 over a chant on the A below do: the guide's pitch, an octave up.
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(2000);
  await page.evaluate(() => void window.__cantor.listen());
  const gabc = "(c4) A(h) men.(h) (::)";
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  await expect(page.locator("#key")).toHaveText("You started on the guide’s pitch.");
  await expect(page.locator("#in-key-line")).toBeHidden();
  const guide = page.getByRole("button", { name: "Guide" });
  // How far the notes the guide last sang are from where the Pitch puts them, in semitones (an
  // octave either way being the same).
  const moved = () =>
    page.evaluate(() => {
      const { sung, played } = window.__cantor;
      return played.midi.map((m, i) => ((((m - sung[i]!.midi + 6) % 12) + 12) % 12) - 6);
    });
  // Each play is let end by itself, so that a click after it starts the next.
  const ended = () => expect(guide).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  await guide.click();
  expect(await moved()).toEqual([0, 0]);
  await ended();
  // With the guide two semitones up, the same singer is two below it.
  await page.getByLabel("Pitch").selectOption("2");
  const { verdict } = JSON.parse(await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const));
  await expect(page.locator("#key")).toHaveText(
    "You started 2 semitones below the guide. That is fine: chant may be sung in any key that suits your voice, and each note is judged from the one you started in. To begin your next take there, set Pitch to “As written”.",
  );
  // Beside it the guide sings where the singer started, to the cent, until told otherwise; the
  // Pitch still leads the next take.
  const inKey = page.getByLabel("The guide sings in your key");
  await expect(inKey).toBeChecked();
  await guide.click();
  for (const by of await moved()) expect(by).toBeCloseTo(verdict.key_cents / 100 - 2, 5);
  await ended();
  // A drone holds the Pitch, so it does not sound against the guide moved from it.
  const drone = page.getByRole("button", { name: "Drone" });
  await drone.click();
  await expect.poll(() => page.evaluate(() => window.__cantor.drone)).not.toBeNull();
  await guide.click();
  await expect(drone).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.drone)).toBeNull();
  await ended();
  // Nor does one started while the guide sings moved: the guide stops for it. Pressed in the
  // page as soon as the guide is heard, long before its first note ends.
  // Asked at once, before the guide could have ended by itself.
  const stopped = await page.evaluate(async () => {
    document.getElementById("play")!.click();
    while (!window.__cantor.following) await new Promise(requestAnimationFrame);
    document.getElementById("drone")!.click();
    return [document.getElementById("play")!.getAttribute("aria-pressed"), window.__cantor.following];
  });
  expect(stopped).toEqual(["false", false]);
  await expect(drone).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => window.__cantor.drone)).not.toBeNull();
  await drone.click();
  await inKey.uncheck();
  await guide.click();
  expect(await moved()).toEqual([0, 0]);
  await guide.click();
});

test("your take plays only the phrase chosen, from a moment before it", async ({ page }) => {
  await open(page);
  // Four seconds heard, judged as a chant of two phrases from 0.2 s.
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(4000);
  await page.evaluate(() => void window.__cantor.listen());
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(g) (::)";
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  await page.getByRole("button", { name: "Choose the phrase of note 4", exact: true }).click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  const hear = page.getByRole("button", { name: "Yours" });
  await hear.click();
  await expect(hear).toHaveAttribute("aria-pressed", "true");
  await expect(hear).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  // The phrase's notes, and only those.
  expect(await page.evaluate(() => window.__cantor.replayed.visited)).toEqual(ids.slice(2));
});

test("Compare plays the guide over the phrase chosen, then after a breath your take of it, once", async ({ page }) => {
  await open(page);
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(4000);
  await page.evaluate(() => void window.__cantor.listen());
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(g) (::)";
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  await page.getByRole("button", { name: "Choose the phrase of note 4", exact: true }).click();
  const compare = page.getByRole("button", { name: "Compare" });
  const asked = (await page.evaluate(() => window.__cantor.played)).plays;
  await compare.click();
  await expect(compare).toHaveAttribute("aria-pressed", "true");
  // First the guide, its cursor in the rubric's colour, over the phrase alone.
  await expect(page.locator("#score .cursor:not(.take)")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__cantor.following), { timeout: 10_000 }).toBe(false);
  expect(await page.evaluate(() => window.__cantor.visited)).toEqual(ids.slice(2));
  // Then the take, in the trace's colour, over the same notes; then nothing more.
  await expect(page.locator("#score .cursor.take")).toBeVisible({ timeout: 5000 });
  await expect(compare).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  expect(await page.evaluate(() => window.__cantor.replayed.visited)).toEqual(ids.slice(2));
  // Ended, it has played the guide once and is let go, so nothing more can follow.
  expect((await page.evaluate(() => window.__cantor.played)).plays).toBe(asked + 1);
  expect(await page.evaluate(() => window.__cantor.following)).toBe(false);
  // Pressed again while it plays, it stops.
  await compare.click();
  await expect(page.locator("#score .cursor")).toBeVisible();
  await compare.click();
  await expect(compare).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__cantor.following)).toBe(false);
  expect(await page.evaluate(() => window.__cantor.replayed.playing)).toBe(false);
});

test("beside a take Guide plays the phrase chosen once, and Repeat over and over", async ({ page }) => {
  await open(page);
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(3000);
  await page.evaluate(() => void window.__cantor.listen());
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(g) (::)";
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  await page.getByRole("button", { name: "Choose the phrase of note 1", exact: true }).click();
  const plays = async () => (await page.evaluate(() => window.__cantor.played)).plays;
  const guide = page.getByRole("button", { name: "Guide" });
  const asked = await plays();
  await guide.click();
  await expect(guide).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  expect(await plays()).toBe(asked + 1);
  const repeat = page.getByRole("button", { name: "Repeat" });
  // Round again after a breath, still pressed, until pressed again: over the phrase chosen, and
  // with none over the whole chant.
  for (const chosen of [true, false]) {
    if (!chosen) await page.getByRole("button", { name: "Whole chant" }).click();
    const from = await plays();
    await repeat.click();
    await expect.poll(plays, { timeout: 20_000 }).toBeGreaterThanOrEqual(from + 2);
    await expect(repeat).toHaveAttribute("aria-pressed", "true");
    await repeat.click();
    await expect(repeat).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => window.__cantor.following)).toBe(false);
  }
  // It clears what the status said of a guide that failed.
  await page.evaluate(() => {
    const status = document.getElementById("status")!;
    status.textContent = "The guide voice failed. Try again.";
    status.classList.add("error");
  });
  await repeat.click();
  await expect(page.locator("#status")).toHaveText("");
  await repeat.click();
});

test("your take's audio is decoded once a take, and again after it failed", async ({ page }) => {
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
  await open(page);
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(2000);
  await page.evaluate(() => void window.__cantor.listen());
  const gabc = "(c4) A(h) men.(h) (::)";
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  const hear = page.getByRole("button", { name: "Yours" });
  await hear.click();
  await expect(page.locator("#status")).toHaveText("Your take could not be played: out of memory");
  await expect(hear).toHaveAttribute("aria-pressed", "false");
  for (const decodes of [2, 2]) {
    await hear.click();
    await expect.poll(() => page.evaluate(() => window.__cantor.replayed.playing)).toBe(true);
    await expect(hear).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
    expect(await page.evaluate(() => window.__cantor.replayed.decodes)).toBe(decodes);
  }
});

test("the bar steps from mark to mark in the order sung, each opening its card and the step to hear", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(8000);
  await page.evaluate(() => void window.__cantor.listen());
  // The A4 heard against notes written a tone, a third and a fourth below it.
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(f) (:) De(h)o(e) gra(h)ti(h)as(h) (::)";
  const { told, verdict, endings } = JSON.parse(await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const));
  expect(verdict.marks.map((m: { first: number }) => m.first)).toEqual([2, 5, 7]);
  // The ending of "alleluia", a third below where the A4 was sung, is heard off pitch.
  expect(endings.map((e: { first: number; last: number }) => [e.first, e.last])).toEqual([[4, 5]]);
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  const text = page.locator("#chosen-text");
  // Named for what they step among, marks and endings alike.
  const prev = page.getByRole("button", { name: "Previous mark or ending" });
  const next = page.getByRole("button", { name: "Next mark or ending" });
  const loop = () => page.evaluate(() => window.__cantor.loop);
  await expect(text).toHaveText("Whole chant · 3 marks, 1 ending off pitch");
  await next.click();
  await expect(text).toHaveText("Mark 1 of 3 · “al”");
  expect(await loop()).toEqual([2, 5]);
  await expect(page.locator("#why-words")).toHaveText(told[0]);
  await expect(page.locator("#why-step")).toHaveText("Written a whole tone below the note before.");
  await expect(prev).toHaveAttribute("aria-disabled", "true");
  await clearOfCard(page, 0, 2);
  // The card's words are where a screen reader hears them, outside the card that appeared.
  await expect(page.locator("#why-said")).toHaveText(told[0]);
  // The steps keep their places as the line changes under them.
  const at = await next.boundingBox();
  // The ending comes in the order sung, between the marks, choosing its own notes.
  await next.click();
  await expect(text).toHaveText("Ending 1 of 1 · “lu … ia”");
  expect(await next.boundingBox()).toEqual(at);
  expect(await loop()).toEqual([4, 5]);
  await expect(page.locator("#why-words")).toHaveText(endings[0].words);
  await expect(page.locator("#why")).toHaveAttribute("aria-label", "The ending open");
  await expect(page.getByRole("button", { name: "Close the ending" })).toBeVisible();
  await expect(page.locator("#why-step")).toHaveText("Its first note is written on the same pitch as the note before.");
  await clearOfCard(page, `#score [data-note~="${ids[4]}"]`, 4);
  await next.click();
  await expect(text).toHaveText("Mark 2 of 3 · “ia”");
  expect(await next.boundingBox()).toEqual(at);
  await expect(page.locator("#why")).toHaveAttribute("aria-label", "The mark open");
  expect(await loop()).toEqual([2, 5]);
  await next.click();
  await expect(text).toHaveText("Mark 3 of 3 · “o”");
  expect(await loop()).toEqual([6, 10]);
  await expect(page.locator("#why-words")).toHaveText(told[2]);
  await expect(page.locator("#why-step")).toHaveText("Written a fourth below the note before.");
  // At the end it goes no further, and keeps the keyboard.
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await expect(text).toHaveText("Mark 3 of 3 · “o”");
  await expect(next).toBeFocused();
  await prev.click();
  await expect(text).toHaveText("Mark 2 of 3 · “ia”");
  // The card, clear of the bar, plays the step into its note: the guide's, then the take's.
  const card = await page.locator("#why").boundingBox();
  expect(card!.y + card!.height).toBeLessThanOrEqual((await page.locator(".bar").boundingBox())!.y + 1);
  const step = page.getByRole("button", { name: "Hear the step" });
  await step.click();
  await expect(step).toHaveAttribute("aria-pressed", "true");
  await expect(step).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 });
  expect(await page.evaluate(() => window.__cantor.visited)).toEqual(ids.slice(4, 6));
  expect(await page.evaluate(() => window.__cantor.replayed.visited)).toEqual(ids.slice(4, 6));
  // A step does not play on under a card that has moved to another mark, in the same phrase or
  // not, nor under one closed.
  for (const move of [() => prev.click(), () => next.click(), () => page.getByRole("button", { name: "Close the mark" }).click()]) {
    await step.click();
    await expect(step).toHaveAttribute("aria-pressed", "true");
    await move();
    // Hidden with its card, or not.
    await expect(page.locator("#step")).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => [window.__cantor.following, window.__cantor.replayed.playing])).toEqual([false, false]);
    if (await page.locator("#why").isHidden()) break;
    await expect(text).toHaveText(/^(Mark|Ending) /);
  }
  // Closed, it leaves the phrase chosen and the keyboard on the mark's ring.
  await expect(page.locator("#why")).toBeHidden();
  await expect(text).toHaveText("Notes 3 to 6 · “al … ia”");
  await expect(page.locator('[data-mark="1"]')).toBeFocused();
  // The steps go on from the mark closed; from a phrase tapped, into it, or back before it.
  await next.click();
  await expect(text).toHaveText("Mark 3 of 3 · “o”");
  await page.locator("#chosen").getByRole("button", { name: "Whole chant" }).click();
  await page.getByRole("button", { name: "Choose the phrase of note 3", exact: true }).click();
  await expect(text).toHaveText("Notes 3 to 6 · “al … ia”");
  await next.click();
  await expect(text).toHaveText("Mark 1 of 3 · “al”");
  // A phrase let go and tapped afresh is stepped into from its start, whichever of its places
  // was open before.
  await next.click();
  await expect(text).toHaveText("Ending 1 of 1 · “lu … ia”");
  await next.click();
  await expect(text).toHaveText("Mark 2 of 3 · “ia”");
  await page.locator("#chosen").getByRole("button", { name: "Whole chant" }).click();
  await page.getByRole("button", { name: "Choose the phrase of note 3", exact: true }).click();
  await expect(text).toHaveText("Notes 3 to 6 · “al … ia”");
  await next.click();
  await expect(text).toHaveText("Mark 1 of 3 · “al”");
});

test("the marks are listed under the score, a folded row for each phrase they are in", async ({ page }) => {
  await open(page);
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(8000);
  await page.evaluate(() => void window.__cantor.listen());
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(f) (:) De(h)o(e) gra(h)ti(h)as(h) (::)";
  const { told, endings } = JSON.parse(await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const));
  // Under the score, not between it and the take's sentences.
  expect(await page.evaluate(() => !!(document.getElementById("score")!.compareDocumentPosition(document.getElementById("places")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.locator("#marked summary")).toHaveText(["alleluia 2 marks, an ending off pitch", "Deo gratias 1 mark"]);
  await expect(page.locator("#marked button").first()).toBeHidden();
  await page.locator("#marked summary").first().click();
  // The ending among the marks, in the order sung, in the core's words.
  await expect(page.locator("#marked button:visible")).toHaveText([`Note 3, “al”: ${told[0]}`, `Notes 5 to 6, “lu”: ${endings[0].words}`, `Note 6, “ia”: ${told[1]}`]);
  await page.locator("#marked button").nth(2).click();
  await expect(page.locator("#chosen-text")).toHaveText("Mark 2 of 3 · “ia”");
  await clearOfCard(page, 1, 5);
  await page.locator("#marked button").nth(1).click();
  await expect(page.locator("#chosen-text")).toHaveText("Ending 1 of 1 · “lu … ia”");
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([4, 5]);
});

test("the summary's sentence of endings off pitch goes to the first of them", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.evaluate(() => void window.__cantor.listen());
  await expect.poll(() => page.evaluate(() => window.__cantor.frames.length)).toBeGreaterThan(0);
  await page.waitForTimeout(8000);
  await page.evaluate(() => void window.__cantor.listen());
  // The A4 heard against both endings, a tone below it.
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(g) (::)";
  const { summary, endings } = JSON.parse(await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const));
  expect(endings.map((e: { first: number; last: number }) => [e.first, e.last])).toEqual([[0, 1], [4, 5]]);
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  // The core's two sentences, the second a button.
  await expect(page.locator("#summary")).toHaveText(summary.join(" "));
  const said = page.locator("#summary").getByRole("button", { name: summary[1] });
  // From the foot of the page, where the score is out of sight.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await said.click();
  await expect(page.locator("#chosen-text")).toHaveText("Ending 1 of 2 · “A … men”");
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([0, 1]);
  await expect(page.locator("#why-words")).toHaveText(endings[0].words);
  await clearOfCard(page, `#score [data-note~="${ids[0]}"]`, 0);
  // It keeps the keyboard, and goes to the first again once another is open.
  await expect(said).toBeFocused();
  await page.getByRole("button", { name: "Next mark or ending" }).click();
  await expect(page.locator("#chosen-text")).toHaveText(/^(Mark|Ending) /);
  await said.click();
  await expect(page.locator("#chosen-text")).toHaveText("Ending 1 of 2 · “A … men”");
});

test("a tap inside the run chosen narrows it, between breaths, then to a neume of a melisma, then lets it go", async ({ page }) => {
  await open(page);
  // A melisma on "lu" after a breath: its neumes written apart by a slash.
  const gabc = "(c4) Al(gh/ji)le(hg) (,) lu(ghg/fe) ia(f) (::)";
  await page.evaluate(([g]) => window.__cantor.practise(g, 0.5), [gabc] as const);
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  const loop = () => page.evaluate(() => window.__cantor.loop);
  const tap = () => page.locator(`#score [data-note~="${ids[7]}"]`).first().click();
  await tap();
  expect(await loop()).toEqual([0, 11]);
  await expect(page.locator("#loop-text")).toHaveText("Play goes over notes 1 to 12 until you stop it. Tap a note in it to play less of it.");
  await tap();
  expect(await loop()).toEqual([6, 11]);
  await tap();
  expect(await loop()).toEqual([6, 8]);
  await expect(page.locator("#loop-text")).toHaveText("Play goes over notes 7 to 9 until you stop it.");
  // Nothing narrower is left: the tap lets it go.
  await tap();
  expect(await loop()).toBeNull();
  // A syllable of one neume is no melisma: in a run between breaths, a tap lets it go.
  await page.locator(`#score [data-note~="${ids[4]}"]`).first().click();
  await page.locator(`#score [data-note~="${ids[4]}"]`).first().click();
  expect(await loop()).toEqual([0, 5]);
  await page.locator(`#score [data-note~="${ids[4]}"]`).first().click();
  expect(await loop()).toBeNull();
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
  await expect(page.locator("#status")).toHaveText(/The guide voice failed\. Try again\./, { timeout: 10_000 });
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
