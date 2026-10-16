import { expect, test, type Locator, type Page } from "@playwright/test";

declare global {
  interface Window {
    __pointer: {
      state: { text: string; auto: string; tone: string };
      visited: number[];
      player: { started: boolean };
      shared: () => Promise<{ text?: string; own?: string } | null>;
    };
  }
}

const text = (page: Page) => page.evaluate(() => window.__pointer.state.text);

async function open(page: Page, hash = ""): Promise<void> {
  await page.goto(`/?test=1${hash}`);
  await expect(page.locator(".verse").first()).toBeVisible();
}

/** The accents of one half of one verse. */
const accents = (page: Page, verse: number, part: string): Locator =>
  page.locator(`.verse[data-verse="${verse}"] .acc[data-part="${part}"]`);

test("points Psalm 23 for tone 8 G with every half accented", async ({ page }) => {
  await open(page);
  await expect(page.locator("#psalm")).toHaveValue("23");
  await expect(page.locator("#tone-label")).toHaveText("Tone 8 G");
  await expect(page.locator("#tone-score svg")).toBeVisible();
  // Six verses and the two of the Gloria.
  await expect(page.locator(".verse")).toHaveCount(8);
  for (let v = 0; v < 8; v++) {
    await expect(accents(page, v, "mediant")).toHaveCount(1);
    await expect(accents(page, v, "termination")).toHaveCount(1);
  }
  await expect(page).toHaveURL(/#psalm=23&tone=8\.G$/);
});

test("the arrow keys move an accent, and undo puts it back", async ({ page }) => {
  await open(page);
  const before = await text(page);
  const accent = accents(page, 0, "termination");
  const was = await accent.textContent();
  await accent.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(accent).not.toHaveText(was!);
  await expect(accent).toBeFocused();
  const after = await text(page);
  expect(after).not.toBe(before);
  // Only the first verse's termination changed.
  expect(after.split("\n").slice(1)).toEqual(before.split("\n").slice(1));
  expect(after.split("*")[0]).toBe(before.split("*")[0]);
  await expect(page.locator("#status")).toContainText("pointing edited");
  await expect(page).toHaveURL(/&text=/);
  // Leaving out the Gloria keeps the edit.
  await page.locator("#gloria").uncheck();
  await expect(page.locator(".verse")).toHaveCount(6);
  expect((await text(page)).split("\n")[0]).toBe(after.split("\n")[0]);
  await expect(page.locator("#status")).toContainText("pointing edited");
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  expect(await text(page)).toBe(before);
});

test("dragging an accent moves it, and the address keeps the edit", async ({ page }) => {
  await open(page);
  const accent = accents(page, 1, "mediant");
  const half = page.locator(`.verse[data-verse="1"] .syl[data-part="mediant"]`);
  const all = await half.allTextContents();
  const at = all.indexOf((await accent.textContent())!);
  const target = half.nth(at - 2);
  const targetText = (await target.textContent())!;
  await accent.hover();
  await page.mouse.down();
  await target.hover();
  await expect(target).toHaveClass(/target/);
  await page.mouse.up();
  await expect
    .poll(async () => (await accents(page, 1, "mediant").textContent())!.normalize("NFD").replace(/\u0301/g, ""))
    .toBe(targetText);
  const edited = await text(page);
  await expect(page).toHaveURL(/&text=/);
  const url = page.url();
  await page.goto("about:blank");
  await page.goto(url);
  await expect(page.locator(".verse").first()).toBeVisible();
  expect(await text(page)).toBe(edited);
});

test("a new tone points the psalm again", async ({ page }) => {
  await open(page);
  await page.locator("#tone").selectOption("1.D");
  await expect(page.locator("#tone-label")).toHaveText("Tone 1 D");
  // Tone 1's mediant has two accents.
  await expect(accents(page, 0, "mediant")).toHaveCount(2);
  await expect(page).toHaveURL(/tone=1\.D/);
});

test("singing a verse follows its syllables in order", async ({ page }) => {
  await page.clock.install();
  await open(page);
  const starts = await page
    .locator(`.verse[data-verse="2"] .syl`)
    .evaluateAll((els) => els.map((el) => Number((el as HTMLElement).dataset.start)));
  await page.locator(`.verse[data-verse="2"] .num`).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  // The fake clock moves only once the player has scheduled the sound and set its origin.
  await expect.poll(() => page.evaluate(() => window.__pointer.player.started)).toBe(true);
  await page.clock.runFor(60_000);
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  const visited = await page.evaluate(() => window.__pointer.visited);
  // Each syllable once, in order; a syllable of two notes is still one.
  expect(visited.filter((s, i) => s !== visited[i - 1])).toEqual(starts);
});

test("without the voice, singing says why nothing sounds", async ({ page }) => {
  await page.route(
    (url) => url.pathname === "/cantor.wasm",
    (route) => route.fulfill({ status: 404 }),
  );
  await open(page);
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.locator("#status")).toHaveText(/could not be loaded/);
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
});

test("exports the setting as GABC and text", async ({ page }) => {
  await open(page);
  const [gabc] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "GABC" }).click()]);
  expect(gabc.suggestedFilename()).toBe("psalm-23-tone-8G.gabc");
  const body = await (await gabc.createReadStream()).toArray();
  const source = Buffer.concat(body).toString("utf8");
  expect(source).toMatch(/^name:Psalm 23 · Dominus regit me;\nmode:8;\nmode-differentia:G;\n%%\n\(c4\)/);
  const [txt] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Text", exact: true }).click()]);
  const lines = Buffer.concat(await (await txt.createReadStream()).toArray()).toString("utf8");
  expect(lines).toContain(await text(page));
});

test("points text of your own", async ({ page }) => {
  await open(page);
  await page.locator("#psalm").selectOption("own");
  await page.locator("#gloria").uncheck();
  await page.locator("#own").fill("O praise the Lord, all ye heathen * praise him, all ye nations.");
  await expect(page.locator(".verse")).toHaveCount(1);
  await expect(accents(page, 0, "termination")).toHaveCount(1);
  await expect.poll(() => page.evaluate(async () => (await window.__pointer.shared())?.own)).toContain("nations");
  await expect(page).toHaveURL(/psalm=own&tone=8\.G&gloria=0&own=/);
  const url = page.url();
  await page.goto("about:blank");
  await page.goto(url);
  await expect(page.locator("#own")).toHaveValue("O praise the Lord, all ye heathen * praise him, all ye nations.");
  await expect(page.locator(".verse")).toHaveCount(1);
  // The typed text, not its pointing, travels: another tone points it afresh.
  await page.locator("#tone").selectOption("1.D");
  await expect(accents(page, 0, "mediant")).toHaveCount(2);
});

test("sings a range of verses, keeping the edits of verses still in it", async ({ page }) => {
  await open(page);
  await accents(page, 2, "termination").focus();
  await page.keyboard.press("ArrowLeft");
  const edited = (await text(page)).split("\n")[2]!;
  await page.locator("#from").fill("2");
  await page.locator("#from").dispatchEvent("change");
  await page.locator("#to").fill("4");
  await page.locator("#to").dispatchEvent("change");
  // Three verses and the Gloria.
  await expect(page.locator(".verse")).toHaveCount(5);
  await expect(page.locator(".verse .num").first()).toHaveText("2");
  await expect(page).toHaveURL(/verses=2-4/);
  expect((await text(page)).split("\n")[1]).toBe(edited);
  await expect(page.locator("#status")).toContainText("pointing edited");
  // Ctrl+Z in a verse field is the field's own.
  await page.locator("#to").focus();
  await page.keyboard.press("Control+z");
  expect((await text(page)).split("\n")[1]).toBe(edited);
  // Each end of the range was its own change.
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".verse")).toHaveCount(6 + 2);
  expect((await text(page)).split("\n")[2]).toBe(edited);
});

test("the check button visits each flagged half in turn", async ({ page }) => {
  await open(page, "#psalm=1&tone=8.G");
  const flagged = await page.locator(".acc.unsure").evaluateAll((els) => [
    ...new Set(els.map((el) => `${el.closest<HTMLElement>(".verse")!.dataset.verse}:${el.dataset.part}`)),
  ]);
  expect(flagged.length).toBeGreaterThan(2);
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return `${el.closest<HTMLElement>(".verse")!.dataset.verse}:${el.dataset.part}`;
    });
  const check = page.locator("#check");
  await check.click();
  expect(await focused()).toBe(flagged[0]);
  // Fixing the first takes nothing from the rest.
  await page.keyboard.press("ArrowLeft");
  await check.click();
  expect(await focused()).toBe(flagged[1]);
  await check.click();
  expect(await focused()).toBe(flagged[2]);
});

test("copies the pointing for a word processor", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  await page.getByRole("button", { name: "Copy for Word" }).click();
  await expect(page.locator("#status")).toContainText("Copied");
  const html = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return (await item!.getType("text/html")).text();
  });
  expect(html).toContain("Psalm 23 · Dominus regit me");
  expect(html).toContain("color:#a3211c;font-weight:bold\">·</span>");
  expect(html).toContain("shépherd");
});

test("shows a booklet's pointing for those who may see it, and suggests its own otherwise", async ({ page }) => {
  await open(page);
  await expect(page.locator("#status")).toContainText("Suggested pointing");
  await expect(page.locator("#source-label")).toBeHidden();
  // A made-up setting stands in for the private ones.
  const setting = {
    id: "test/001",
    label: "i.4",
    tone: "1.a",
    nearest: "1.a",
    match: "exact",
    section: "Test",
    verses: [
      { n: 1, pointed: "The Lord is my shepherd · thérefore * can I lack · nóthing." },
      { n: 2, pointed: "He shall feed me in a · gréen pasture * and lead me forth beside the waters · of cómfort." },
      { n: 7, pointed: "Glory be to the Father, and · to the Són * and to · the Holy Ghóst.", gloria: true },
      { n: 8, pointed: "As it was in the beginning, is now, and ever · sháll be * world without · end. Amén.", gloria: true },
    ],
  };
  await page.route("**/api/pointing/23", (route) => route.fulfill({ json: [setting] }));
  await open(page, "#psalm=23&tone=8.G&verses=1-2");
  await expect(page.locator("#source-label")).toBeVisible();
  await page.locator("#source").selectOption("test/001");
  await expect(page.locator("#tone")).toHaveValue("1.a");
  await expect(page.locator("#status")).toContainText("Booklet pointing, i.4");
  expect(await text(page)).toBe(
    [...setting.verses.map((v) => (v.gloria ? v.pointed : `${v.n} ${v.pointed}`))].join("\n"),
  );
  await expect(page).toHaveURL(/setting=test%2F001/);
  // A shared link opens on the setting.
  await page.reload();
  await expect(page.locator("#source")).toHaveValue("test/001");
  await expect(page.locator("#status")).toContainText("Booklet pointing, i.4");
  // Another tone is the pointer's own suggestion again.
  await page.locator("#tone").selectOption("8.G");
  await expect(page.locator("#source")).toHaveValue("");
  await expect(page.locator("#status")).toContainText("Suggested pointing");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("#source")).toHaveValue("test/001");
  // An edit to a booklet's text stays out of the address.
  await accents(page, 0, "termination").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#status")).toContainText("pointing edited");
  await page.waitForTimeout(400);
  expect(page.url()).not.toContain("text=");
  // Someone the route turns away gets the pointer's own suggestion from the same link.
  const link = page.url();
  await page.unroute("**/api/pointing/23");
  await page.route("**/api/pointing/23", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.goto("about:blank");
  await page.goto(link);
  await expect(page.locator(".verse").first()).toBeVisible();
  await expect(page.locator("#status")).toContainText("Suggested pointing");
  expect(await text(page)).not.toContain(setting.verses[0]!.pointed);
});

test("a psalm chosen while a linked setting loads keeps its own pointing", async ({ page }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/pointing/23", async (route) => {
    await held;
    await route.fulfill({
      json: [{ id: "test/001", label: "i.4", tone: "1.a", nearest: "1.a", match: "exact", section: null, verses: [{ n: 1, pointed: "The Lord is my shepherd · thérefore * can I lack · nóthing." }] }],
    });
  });
  await page.goto("/?test=1#psalm=23&tone=1.a&setting=test%2F001");
  await expect(page.locator("#psalm option").first()).toBeAttached();
  await page.locator("#psalm").selectOption("1");
  await expect(page.locator(".verse").first()).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(page.locator("#psalm")).toHaveValue("1");
  await expect(page.locator("#status")).toContainText("Suggested pointing");
  expect(await text(page)).toMatch(/^1 Blessed is the man/);
});
