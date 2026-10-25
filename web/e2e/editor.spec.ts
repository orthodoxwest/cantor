import { expect, type Page, test } from "@playwright/test";

/** Opens the editor once its first score is engraved, so nothing typed is set over by the page
 * starting. */
async function open(page: Page): Promise<void> {
  await page.goto("/editor");
  await expect(page.locator("#score svg")).toBeVisible();
  // Fonts arriving change the page's height, and with a scrollbar its width and the layout.
  await page.evaluate(() => document.fonts.ready);
}

test("the editor engraves GABC as it is typed, and offers the fix for a problem", async ({ page }) => {
  await open(page);
  const source = page.getByLabel("GABC source");
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();

  await source.fill("(c4) Al(f)le(gh)lu(h)ia.(g");
  const problem = page.locator("#problems li");
  await expect(problem).toHaveCount(1);
  await expect(problem).toContainText("never close");
  await problem.getByRole("button", { name: "Insert )" }).click();
  await expect(source).toHaveValue("(c4) Al(f)le(gh)lu(h)ia.(g)");
  await expect(problem).toHaveCount(0);
  await expect(page.locator("#score")).toContainText("lu");

  // What was typed is there after a reload.
  await page.reload();
  await expect(source).toHaveValue("(c4) Al(f)le(gh)lu(h)ia.(g)");
});

test("a note tapped in the score selects its source", async ({ page }) => {
  await open(page);
  const source = page.getByLabel("GABC source");
  await source.fill("(c4) A(f) B(hg) C(e)");
  // Engraved on the next frame: wait for its four notes before finding one. (Its words won't
  // do: the engraving's style names EB Garamond, so "B" is always in its text.)
  await expect(page.locator("#score use[data-note]")).toHaveCount(4);
  // The middle syllable's first notehead, found by where neuma drew it and tapped in the same
  // task, so a relayout (a scrollbar coming or going) cannot move it in between.
  const selected = await page.evaluate(() => {
    const n = document.querySelectorAll("#score use[data-note]")[1]!.getBoundingClientRect();
    const at = { clientX: n.x + n.width / 2, clientY: n.y + n.height / 2, bubbles: true };
    document.getElementById("score")!.dispatchEvent(new MouseEvent("click", at));
    const t = document.getElementById("source") as HTMLTextAreaElement;
    return t.value.slice(t.selectionStart, t.selectionEnd);
  });
  expect(selected).toBe("h");
  await expect(page.locator("#score .cantor-current")).not.toHaveCount(0);
});

test("the guide's examples are engraved, and Try it puts one in the editor", async ({ page }) => {
  await open(page);
  const examples = page.locator(".example");
  await expect(examples).toHaveCount(7);
  await expect(examples.first().locator(".engraved svg")).toBeVisible();
  await examples.nth(1).getByRole("button", { name: "Try it" }).click();
  const source = page.getByLabel("GABC source");
  await expect(source).toHaveValue("(c4) do(j) ti(i) la(h) sol(g) fa(f) (::)");
});

test("an example tried does not replace the visitor's own GABC kept for next time", async ({ page }) => {
  await open(page);
  const source = page.getByLabel("GABC source");
  await source.fill("(c4) Mine(f)");
  await expect(page.locator("#score")).toContainText("ine");
  await page.locator(".example").first().getByRole("button", { name: "Try it" }).click();
  await expect(source).toHaveValue("(c4) Al(f)le(g)lu(h)ia.(g)");
  await page.reload();
  await expect(source).toHaveValue("(c4) Mine(f)");
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(source).toHaveValue(/^name:Ubi caritas;/);
});

test("the editor fits a 320px phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route("/api/me", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await open(page);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("#score svg")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
