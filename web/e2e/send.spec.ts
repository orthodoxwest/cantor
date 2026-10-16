// Sending a take: a signed-in singer's judged take goes to the Worker (stood in for here) with
// its audio, and the link it answers is copied and shown.
import { expect, test, type Page, type Request } from "@playwright/test";

const GABC = "(c4) A(h) men.(h) (::)";
const ID = "A".repeat(32);

test.use({ permissions: ["microphone", "clipboard-read", "clipboard-write"] });

/** Opens the page as a singer the Worker knows, or not, and shows a take judged. */
async function judgedTake(page: Page, known = true): Promise<void> {
  await page.route("**/api/me", (route) =>
    known ? route.fulfill({ json: { id: "singer", email: null } }) : route.fulfill({ status: 401, json: { error: "unauthorized" } }),
  );
  await page.goto("/sing.html?test=1");
  await page.waitForFunction(() => window.__cantor);
  await page.evaluate(() => void window.__cantor.listen());
  await page.waitForTimeout(2000);
  await page.evaluate(() => void window.__cantor.listen());
  await page.evaluate(([gabc]) => window.__cantor.show(gabc, 0.5, 0.2), [GABC] as const);
  await expect(page.locator("#result")).toBeVisible();
}

test("a signed-in singer sends a take and gets a link to it", async ({ page }) => {
  const sent: Request[] = [];
  await page.route("**/api/takes", (route) => {
    sent.push(route.request());
    return route.fulfill({ status: 201, json: { id: ID, url: `/take/${ID}` } });
  });
  await judgedTake(page);
  const send = page.getByRole("button", { name: "Send to a director" });
  await send.click();
  const link = page.locator("#sent a");
  await expect(link).toHaveAttribute("href", `http://localhost:4173/take/${ID}`);
  await expect(page.locator("#sent")).toHaveText(/^Link copied\. Anyone with it can hear this take: /);
  await expect(send).toBeHidden();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://localhost:4173/take/${ID}`);

  // One request: the take's audio as a WAV file of the take heard, and its judged result.
  expect(sent).toHaveLength(1);
  const request = sent[0]!;
  expect(request.method()).toBe("POST");
  const body = request.postDataBuffer()!;
  const at = body.indexOf("RIFF");
  expect(at).toBeGreaterThan(0);
  expect(body.toString("latin1", at + 8, at + 12)).toBe("WAVE");
  const rate = body.readUInt32LE(at + 24);
  expect([22_050, 24_000]).toContain(rate);
  const seconds = body.readUInt32LE(at + 40) / 2 / rate;
  const heard = (await page.evaluate(() => window.__cantor.heard()))!;
  expect(seconds).toBeCloseTo(heard.seconds, 1);
  const json = /name="take"\r\n\r\n(\{.*\})\r\n--/s.exec(body.toString("utf8"))?.[1];
  const take = JSON.parse(json!);
  expect(take).toMatchObject({ slug: "lumen-gentium", gabc: GABC, pulse: 0.5, offset: 0.2 });
  expect(take.seconds).toBeCloseTo(heard.seconds, 3);
  expect(take.judged.summary).toEqual(expect.any(Array));
  expect(take.judged.ribbon.length).toBeGreaterThan(0);

  // Another take clears the link, and may be sent in its turn.
  await page.evaluate(() => void window.__cantor.listen());
  await expect(page.locator("#result")).toBeHidden();
  await expect(page.locator("#sent")).toHaveText("");
});

test("a take that cannot be sent says why and may be sent again", async ({ page }) => {
  await page.route("**/api/takes", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await judgedTake(page);
  const send = page.getByRole("button", { name: "Send to a director" });
  await send.click();
  await expect(page.locator("#status")).toHaveText("The take could not be sent: you are no longer signed in");
  await expect(send).toBeEnabled();
  await expect(page.locator("#sent")).toHaveText("");
});

test("a take being sent leaves the page free, and its link is given even if the take is cleared", async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached = false;
  await page.route("**/api/takes", async (route) => {
    reached = true;
    await held;
    await route.fulfill({ status: 201, json: { id: ID, url: `/take/${ID}` } });
  });
  await judgedTake(page);
  await page.getByRole("button", { name: "Send to a director" }).click();
  await expect.poll(() => reached).toBe(true);
  // Once its audio is read, the page may be used while the take is sent.
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sing a take" })).toBeEnabled();
  await expect(page.locator("#find")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send to a director" })).toBeDisabled();
  // The page's own listening (the tests' hook) clears the take while it is sent.
  await page.evaluate(() => void window.__cantor.listen());
  await expect(page.locator("#result")).toBeHidden();
  release();
  await expect(page.locator("#status")).toHaveText(new RegExp(`this take: http://localhost:4173/take/${ID}$`));
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sing a take" })).toBeEnabled();
  await page.evaluate(() => void window.__cantor.listen());
});

test("a singer not signed in is not offered to send", async ({ page }) => {
  await judgedTake(page, false);
  await expect(page.locator("#key")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send to a director" })).toBeHidden();
});
