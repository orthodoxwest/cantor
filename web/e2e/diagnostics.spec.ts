// /diagnostics with the fake microphone: one tap fills the table, which copies as text and
// sends to the Worker (stood in for here).
import { expect, test, type Request } from "@playwright/test";

test.use({ permissions: ["microphone", "clipboard-read", "clipboard-write"] });

test("a check fills the table, which copies and sends", async ({ page }) => {
  const sent: Request[] = [];
  await page.route("**/api/diagnostics", (route) => {
    sent.push(route.request());
    return route.fulfill({ status: 201, json: { ok: true } });
  });
  await page.goto("/diagnostics");
  await page.getByRole("button", { name: "Check" }).click();
  // Nothing to copy or send while the check runs.
  await expect(page.locator("#table th").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeHidden();
  await expect(page.locator("#status")).toHaveText("Done. Copy the table, or send it.", { timeout: 20_000 });

  const table = page.locator("#table");
  const value = (label: string) => table.locator("tr", { has: page.locator("th", { hasText: new RegExp(`^${label}$`) }) }).locator("td");
  await expect(value("Browser")).toHaveText(/^Chrome \d+ on Linux$/);
  await expect(value("Microphone rate")).toHaveText(/^\d+ Hz$/);
  await expect(value("Audio context rate")).toHaveText(/^\d+ Hz$/);
  await expect(value("Echo cancellation")).toHaveText("off");
  await expect(value("Output latency")).toHaveText(/ ms$|^not said$/);
  // The fake microphone plays a 440 Hz sine, never the beeps, and is heard as the room.
  await expect(value("Round trip")).toHaveText(/^beeps not heard/);
  await expect(value("Room level")).toHaveText(/^-\d+ dBFS$/);
  await expect(value("Ear's load")).toHaveText(/% of real time/);

  await page.getByRole("button", { name: "Copy as text" }).click();
  await expect(page.locator("#sent")).toHaveText("Copied.");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toMatch(/^Browser +Chrome \d+ on Linux\n/m);
  expect(text).toMatch(/^Round trip +beeps not heard/m);

  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#sent")).toHaveText("Sent. Thank you.");
  expect(sent).toHaveLength(1);
  const { rows } = sent[0]!.postDataJSON() as { rows: Array<[string, string]> };
  expect(rows.map(([label]) => label)).toEqual(await table.locator("th").allTextContents());
});

test("the practice page offers the check when the browser does not say about headphones", async ({ page }) => {
  // A browser that names its microphone but no outputs says nothing of headphones.
  await page.addInitScript(() => {
    const mic = { kind: "audioinput", label: "Microphone", deviceId: "default", groupId: "" } as MediaDeviceInfo;
    navigator.mediaDevices.enumerateDevices = async () => [mic];
  });
  await page.goto("/sing");
  const link = page.locator("#mode a");
  await expect(link).toHaveText("Check this browser");
  await expect(link).toHaveAttribute("href", "/diagnostics");
  await page.locator("#headphones").check();
  await expect(link).toHaveCount(0);
});

test("the practice page does not offer it before the browser names its devices", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.enumerateDevices = async () => [];
  });
  await page.goto("/sing");
  await expect(page.locator("#mode")).toHaveText(/does not say whether headphones are in/);
  await expect(page.locator("#mode a")).toHaveCount(0);
});
