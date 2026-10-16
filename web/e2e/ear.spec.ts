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
    await page.evaluate(([gabc, pulse, offset]) => window.__cantor.judge(gabc, pulse, offset), [
      want.gabc,
      want.pulse_s,
      offset,
    ] as const),
  );
  const marks = (v: { marks: Array<{ kind: string; first: number; last: number }> }) =>
    v.marks.map((m) => `${m.kind} ${m.first}-${m.last}`);
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
  await info.attach("ear.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  await info.attach("page.png", { body: await page.screenshot(), contentType: "image/png" });
  expect(Math.abs(got.report.heard_fraction - want.report.heard_fraction)).toBeLessThanOrEqual(HEARD_TOLERANCE);
  expect(marks(got.verdict)).toEqual(marks(want.verdict));
  expect(Math.abs(got.verdict.key_cents - want.verdict.key_cents)).toBeLessThanOrEqual(KEY_TOLERANCE_CENTS);
});
