import { expect, test } from "@playwright/test";

test("the library lists, filters and opens a piece, and practises it", async ({ page }) => {
  await page.goto("/library");
  const items = page.locator("#results > li");
  const total = await items.count();
  expect(total).toBeGreaterThan(1);
  await expect(items.first().locator(".thumb svg")).toBeVisible();

  await page.getByRole("button", { name: /^Hymns/ }).click();
  await expect(page.getByRole("button", { name: /^Hymns/ })).toBeFocused();
  await expect(page.getByRole("button", { name: /^Hymns/ })).toHaveAttribute("aria-pressed", "true");
  const hymns = await items.count();
  expect(hymns).toBeGreaterThan(0);
  expect(hymns).toBeLessThan(total);
  await page.getByRole("button", { name: /^All\d/ }).click();

  await page.getByPlaceholder("Search the words").fill("light to lighten the gentiles");
  await expect(items.first()).toContainText("A light to lighten the Gentiles");
  expect(await items.count()).toBeLessThan(5);
  await page.locator('#results a[href="#lumen-gentium"]').click();
  await expect(page).toHaveURL(/#lumen-gentium$/);
  await expect(page.locator("#piece-title")).toContainText("A light to lighten the Gentiles");
  await expect(page.locator("#score svg")).toBeVisible();
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();

  await page.locator("#back").click();
  await expect(page.locator("#browse")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#piece")).toBeVisible();
  await page.getByRole("link", { name: "Practise this" }).click();
  await expect(page).toHaveURL(/\/sing\?chant=lumen-gentium$/);
  await expect(page.locator("#title")).toHaveText("A light to lighten the Gentiles");
});

test("the practice page sings the chant the address names", async ({ page }) => {
  await page.goto("/sing?chant=ubi-caritas");
  await expect(page.locator("#title")).toHaveText("Where charity and love are");
  await expect(page.locator("#chant")).toHaveValue("ubi-caritas");
  await page.locator("#chant").selectOption("mandatum-novum");
  await expect(page).toHaveURL(/chant=mandatum-novum/);
  await expect(page.locator("#title")).toHaveText("A new commandment give I unto you");
});

test("every page has the same pages in its header", async ({ page }) => {
  for (const [path, current] of [
    ["/", "Psalms"],
    ["/library", "Library"],
    ["/sing", "Practice"],
  ] as const) {
    await page.goto(path);
    const nav = page.getByRole("navigation", { name: "Pages" });
    await expect(nav.getByRole("link")).toHaveText(["Psalms", "Library", "Practice"]);
    await expect(nav.locator("[aria-current=page]")).toHaveText(current);
  }
});

test("the library draws a page of results at a time", async ({ page }) => {
  await page.goto("/library");
  const items = page.locator("#results > li");
  await expect(items).toHaveCount(40);
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(items).toHaveCount(80);
  await expect(page.locator("#results > li > a").nth(40)).toBeFocused();
});

test("a piece the visitor may not see is not in their library", async ({ page }) => {
  await page.goto("/library#meinrad-not-here");
  await expect(page.locator("#count")).toHaveText("That piece is not in the library.");
  await expect(page.locator("#piece")).toBeHidden();
});
