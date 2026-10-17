// A chant with an aligned recording (a private chant, from the Worker, stood in for here): after
// a take, the ribbon draws the recording's trace under the singer's, and says what it is.
import { expect, test, type Page } from "@playwright/test";

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
