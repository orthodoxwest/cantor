// The second ear in the page against `cantor eval`: a synthetic take with planted faults
// plays through the fake microphone, the page listens with both trackers in its worker, and
// the take judged there must be heard and marked as the eval heard and marked it.
import { expect, test } from "@playwright/test";
import { readTake, TAKE_WAV, takeSeconds } from "./fixtures/take.mjs";

/** How far the page's heard fraction may stray from the eval's: resampled to the page's rate
 * and back, the NSDF tracker runs at another rate. */
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

test("the page's two ears hear a take as cantor eval does", async ({ page }, info) => {
  const want = readTake();
  const seconds = takeSeconds();
  test.setTimeout((seconds + 60) * 1000);
  await page.goto("/sing.html?test=1");
  await page.waitForFunction(() => window.__cantor);
  await page.getByRole("button", { name: "Listen" }).click();
  // The file ends with as much silence as it starts with; stop inside it.
  await page.waitForTimeout((seconds - 1) * 1000);
  await page.getByRole("button", { name: "Listen" }).click();
  const heard = await page.evaluate(() => window.__cantor.heard());
  expect(heard?.onset).not.toBeNull();
  await expect(page.locator("#status")).toHaveText(/with both ears/);
  const offset = want.lead_in_s + heard!.onset! - want.onset_s;
  const got = JSON.parse(
    await page.evaluate(([gabc, pulse, offset]) => window.__cantor.judge(gabc, pulse, offset), [
      want.gabc,
      want.pulse_s,
      offset,
    ] as const),
  );
  const perFrame = heard!.swiftMs / heard!.swiftFrames;
  const marks = (v: { marks: Array<{ kind: string; first: number; last: number }> }) =>
    v.marks.map((m) => `${m.kind} ${m.first}-${m.last}`);
  const summary = {
    heard: [want.report.heard_fraction, got.report.heard_fraction],
    marks: [marks(want.verdict), marks(got.verdict)],
    key: [want.verdict.key_cents, got.verdict.key_cents],
    swiftMsPerFrame: Number(perFrame.toFixed(2)),
    swiftFrames: heard!.swiftFrames,
    seconds: heard!.seconds,
  };
  console.log(`second ear: ${JSON.stringify(summary)}`);
  await info.attach("second-ear.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  await info.attach("page.png", { body: await page.screenshot(), contentType: "image/png" });
  expect(Math.abs(got.report.heard_fraction - want.report.heard_fraction)).toBeLessThanOrEqual(HEARD_TOLERANCE);
  expect(marks(got.verdict)).toEqual(marks(want.verdict));
  expect(Math.abs(got.verdict.key_cents - want.verdict.key_cents)).toBeLessThanOrEqual(KEY_TOLERANCE_CENTS);
  // SwiftF0 keeps pace: a 16 ms frame costs well under 16 ms.
  expect(perFrame).toBeLessThan(8);
});
