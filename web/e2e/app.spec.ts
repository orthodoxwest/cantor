import { expect, test, type Page } from "@playwright/test";
import type { Timeline } from "neuma";

const PULSE = 0.5;

/** Installs a fake clock that moves only by `runFor`. One left to flow with real time catches
 * up with it whenever the page reads it inside a timer, and `runFor` then sets it back to the
 * next timer's due time: on a slow machine the cursor could step back. */
async function holdClock(page: Page): Promise<void> {
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
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
  // After a breath it goes round again, the cursor back at the phrase's first note.
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

test("a loop is not shown beside a take's result, even one too short to draw", async ({ page }) => {
  await open(page);
  const gabc = "(c4) A(h) men(h) (:) al(g)le(h)lu(h)ia(g) (::)";
  await page.evaluate(([g]) => window.__cantor.practise(g, 0.5), [gabc] as const);
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  await page.locator(`#score [data-note~="${ids[3]}"]`).first().click();
  expect(await page.evaluate(() => window.__cantor.loop)).toEqual([2, 5]);
  const fillOf = (id: number) => page.evaluate((i) => getComputedStyle(document.querySelector(`#score [data-note~="${i}"]`)!).fill, id);
  expect(await fillOf(ids[3]!)).not.toBe(await fillOf(ids[0]!));
  await page.evaluate(() => void window.__cantor.listen());
  await page.waitForTimeout(2000);
  await page.evaluate(() => void window.__cantor.listen());
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  await expect(page.locator("#result")).toBeVisible();
  await expect(page.locator("#loop")).toBeHidden();
  expect(await fillOf(ids[3]!)).toBe(await fillOf(ids[0]!));
});

test("your take plays back against the score with the cursor, and stops for Play", async ({ page }) => {
  await open(page);
  const hear = page.getByRole("button", { name: "Your take" });
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
  await expect(page.locator("#score .cursor")).toBeVisible();
  // It ends by itself, having marked both notes in turn.
  await expect(hear).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
  const ids = await page.evaluate(() => window.__cantor.timeline.notes.map((n) => n.id));
  expect(await page.evaluate(() => window.__cantor.replayed.visited)).toEqual(ids);
  await expect(page.locator("#score .cursor")).toBeHidden();
  // Play stops it.
  await hear.click();
  await expect.poll(() => page.evaluate(() => window.__cantor.replayed.playing)).toBe(true);
  await page.getByRole("button", { name: "Play" }).click();
  expect(await page.evaluate(() => window.__cantor.replayed.playing)).toBe(false);
  await expect(page.locator("#hear")).toHaveAttribute("aria-pressed", "false");
  // Play clears the take, and with it the way to hear it.
  await expect(hear).toBeHidden();
  // Start note pressed while the take's audio is still being fetched stops it before it sounds.
  await page.evaluate(([g]) => window.__cantor.show(g, 0.5, 0.2), [gabc] as const);
  await expect(page.locator("#note")).toBeEnabled();
  await page.evaluate(() => {
    document.getElementById("hear")!.click();
    document.getElementById("note")!.click();
  });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.__cantor.replayed.playing)).toBe(false);
  await expect(page.locator("#hear")).toHaveAttribute("aria-pressed", "false");
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
