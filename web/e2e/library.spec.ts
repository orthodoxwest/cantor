import { expect, test } from "@playwright/test";

test("the library lists, filters and opens a piece, and practises it", async ({ page }) => {
  await page.goto("/library");
  const items = page.locator("#results > li");
  const total = await items.count();
  expect(total).toBeGreaterThan(1);
  await expect(items.first().locator(".thumb svg")).toBeVisible();

  await page.getByRole("button", { name: /^Hymns/ }).click();
  const hymns = await items.count();
  expect(hymns).toBeGreaterThan(0);
  expect(hymns).toBeLessThan(total);
  await page.getByRole("button", { name: /^All/ }).click();

  await page.getByPlaceholder("Search the words").fill("gentiles");
  await expect(items).toHaveCount(1);
  await items.first().locator("a").click();
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
