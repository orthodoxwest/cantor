import { expect, test } from "@playwright/test";

test("the library lists, filters and opens a piece, and practises it", async ({ page }) => {
  await page.goto("/library");
  const items = page.locator("#results > li");
  const pieces = async () => Number((await page.locator("#count").textContent())?.match(/^\d+/)?.[0]);
  await expect(page.locator("#count")).toHaveText(/^\d+ pieces$/);
  const total = await pieces();
  expect(total).toBeGreaterThan(1);
  await expect(items.first().locator(".thumb svg")).toBeVisible();

  await page.getByRole("button", { name: /^Hymns/ }).click();
  await expect(page.getByRole("button", { name: /^Hymns/ })).toBeFocused();
  await expect(page.getByRole("button", { name: /^Hymns/ })).toHaveAttribute("aria-pressed", "true");
  const hymns = await pieces();
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
  const find = page.getByPlaceholder("Find another chant");
  await find.fill("new commandment");
  const found = page.locator("#found a");
  await expect(found.first()).toContainText("A new commandment give I unto you");
  expect(await found.count()).toBeLessThan(5);
  await found.first().click();
  await expect(page).toHaveURL(/chant=mandatum-novum/);
  await expect(page.locator("#title")).toHaveText("A new commandment give I unto you");
  // Enter takes the first match; a search that finds nothing says so.
  await find.fill("ubi caritas");
  await expect(found.first()).toBeVisible();
  await find.press("Enter");
  await expect(page).toHaveURL(/chant=ubi-caritas/);
  await find.fill("zzzz");
  await expect(page.locator("#found-note")).toHaveText("Nothing matches “zzzz”.");
  await expect(page.locator("#found")).toBeHidden();
  await expect(page.getByRole("link", { name: "Browse the library" })).toHaveAttribute("href", "/library");
});

test("words in the practice page's search before the page is ready are searched for", async ({ page }) => {
  // The page's script held back, as on a slow phone, while the words are typed; or the browser
  // puts them back on going back to the page.
  let ready: () => void = () => {};
  const held = new Promise<void>((resolve) => (ready = resolve));
  await page.route("**/assets/*.js", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/sing?chant=ubi-caritas", { waitUntil: "commit" });
  await page.getByPlaceholder("Find another chant").fill("zzzz");
  ready();
  await expect(page.locator("#title")).toHaveText("Where charity and love are");
  await expect(page.locator("#found-note")).toHaveText("Nothing matches “zzzz”.");
});

test("every page has the same pages in its header", async ({ page }) => {
  for (const [path, current] of [
    ["/", "Psalms"],
    ["/library", "Library"],
    ["/sing", "Practice"],
    ["/editor", "Editor"],
  ] as const) {
    await page.goto(path);
    const nav = page.getByRole("navigation", { name: "Pages" });
    await expect(nav.getByRole("link")).toHaveText(["Psalms", "Library", "Practice", "Editor"]);
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

test("a piece the library does not hold is not shown", async ({ page }) => {
  await page.goto("/library#not-here");
  await expect(page.locator("#count")).toHaveText("That piece is not in the library.");
  await expect(page.locator("#piece")).toBeHidden();
});

test("a visitor the site does not know is offered a sign-in that returns them to the page", async ({ page }) => {
  await page.route("/api/me", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.goto("/library#lumen-gentium");
  const signIn = page.getByRole("link", { name: "Sign in" });
  await expect(signIn).toHaveAttribute("href", "/signin?next=%2Flibrary%23lumen-gentium");
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("link")).toHaveCount(4);
});

test("a signed-in visitor is not offered a sign-in", async ({ page }) => {
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "abc", email: null } }));
  const me = page.waitForResponse("**/api/me");
  await page.goto("/library");
  await me;
  await expect(page.locator("#results > li").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
});

test("a piece that cannot be opened returns to the list and says so", async ({ page }) => {
  await page.goto("/library#lumen-gentium");
  await expect(page.locator("#piece")).toBeVisible();
  await page.route("/api/chants/ubi-caritas", (route) => route.fulfill({ status: 500, json: { error: "down" } }));
  await page.evaluate(() => (location.hash = "#ubi-caritas"));
  await expect(page.locator("#count")).toHaveText("That piece could not be opened.");
  await expect(page.locator("#piece")).toBeHidden();
  await expect(page.locator("#browse")).toBeVisible();
});

test("the header switches between light and dark pages, and remembers the choice", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/library");
  const root = page.locator("html");
  const theme = page.locator("#theme");
  await expect(root).not.toHaveAttribute("data-theme");
  await expect(theme).toHaveAccessibleName("Light pages");
  await theme.click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(theme).toHaveAccessibleName("Dark pages");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 243, 233)");
  await page.goto("/sing");
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.locator("#theme").click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  // Paper is always light, whatever the screen shows.
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 243, 233)");
  await expect(page.locator("#theme")).toBeHidden();
});

test("the Mass settings are browsed together, each Mass in the order it is sung", async ({ page }) => {
  await page.goto("/library");
  await page.getByRole("button", { name: /^Mass settings/ }).click();
  const kickers = page.locator("#results > li .kicker");
  await expect(kickers.first()).toHaveText(/^Mass VIII \(De Angelis\) · Kyrie/);
  const viii = (await kickers.allTextContents()).filter((k) => k.startsWith("Mass VIII ")).map((k) => k.split(" · ")[1]);
  expect(viii).toEqual(["Kyrie", "Kyrie", "Sanctus", "Agnus Dei", "Dismissal", "Dismissal"]);
  // The Greek Kyrie and the Latin dismissal are found by their own words.
  await page.getByPlaceholder("Search the words").fill("orbis factor ite");
  await expect(page.locator("#results > li")).toHaveCount(1);
  await expect(page.locator("#results > li .name")).toContainText("Ite, missa est");
});

test("on a phone the library's kinds are a list to pick from", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/library");
  const pieces = async () => Number((await page.locator("#count").textContent())?.match(/^\d+/)?.[0]);
  await expect(page.locator("#count")).toHaveText(/^\d+ pieces$/);
  const total = await pieces();
  await expect(page.locator("#kinds")).toBeHidden();
  const pick = page.getByRole("combobox", { name: "Kind" });
  await expect(pick).toBeVisible();
  await pick.selectOption({ label: (await pick.locator("option", { hasText: /^Hymns/ }).textContent())! });
  const hymns = await pieces();
  expect(hymns).toBeGreaterThan(0);
  expect(hymns).toBeLessThan(total);
  // The page never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
