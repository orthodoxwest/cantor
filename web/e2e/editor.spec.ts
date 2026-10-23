import { expect, test } from "@playwright/test";

test("the editor engraves GABC as it is typed, and offers the fix for a problem", async ({ page }) => {
  await page.goto("/editor");
  const source = page.getByLabel("GABC source");
  await expect(page.locator("#score svg")).toBeVisible();
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();

  await source.fill("(c4) Al(f)le(gh)lu(h)ia.(g");
  const problem = page.locator("#problems li");
  await expect(problem).toHaveCount(1);
  await expect(problem).toContainText("never close");
  await problem.getByRole("button", { name: "Insert `)`" }).click();
  await expect(source).toHaveValue("(c4) Al(f)le(gh)lu(h)ia.(g)");
  await expect(problem).toHaveCount(0);
  await expect(page.locator("#score")).toContainText("lu");

  // What was typed is there after a reload.
  await page.reload();
  await expect(source).toHaveValue("(c4) Al(f)le(gh)lu(h)ia.(g)");
});

test("a note tapped in the score selects its source", async ({ page }) => {
  await page.goto("/editor");
  const source = page.getByLabel("GABC source");
  await source.fill("(c4) A(f) B(hg) C(e)");
  const svg = page.locator("#score svg");
  await expect(svg).toBeVisible();
  // The middle syllable's first notehead, found by where neuma drew it.
  const box = await page.evaluate(() => {
    const host = document.getElementById("score")!.getBoundingClientRect();
    const notes = [...document.querySelectorAll("#score use[data-note]")].map((e) => e.getBoundingClientRect());
    const n = notes[1]!;
    return { x: n.x + n.width / 2 - host.x, y: n.y + n.height / 2 - host.y };
  });
  await page.locator("#score").click({ position: box });
  const selected = await source.evaluate((t: HTMLTextAreaElement) => t.value.slice(t.selectionStart, t.selectionEnd));
  expect(selected).toBe("h");
});

test("the guide's examples are engraved, and Try it puts one in the editor", async ({ page }) => {
  await page.goto("/editor");
  const examples = page.locator(".example");
  await expect(examples).toHaveCount(6);
  await expect(examples.first().locator(".engraved svg")).toBeVisible();
  await examples.nth(1).getByRole("button", { name: "Try it" }).click();
  await expect(page.getByLabel("GABC source")).toHaveValue("(c4) do(h) ti(g) la(f) sol(e) fa(d) (::)");
});

test("the editor fits a 320px phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("/api/me", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.goto("/editor");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("#score svg")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
