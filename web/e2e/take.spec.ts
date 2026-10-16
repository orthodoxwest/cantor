// A sent take's page, with the Worker stood in for: a take judged and sent on the practice page
// (its record and audio as sent) is served back, drawn on its score, played with the cursor,
// and commented on note by note.
import { expect, test, type Page } from "@playwright/test";

const GABC = "(c4) Al(h)le(hi)lu(h)ia.(gh) (::)";
const ID = "B".repeat(32);

test.use({ permissions: ["microphone", "clipboard-read", "clipboard-write"] });

interface Sent {
  record: Record<string, unknown> & { judged: { ribbon: unknown[]; verdict: { marks: unknown[] }; told: string[]; summary: string[] } };
  wav: Buffer;
}

/** A take judged and sent from the practice page, as the Worker would have received it. */
async function sentTake(page: Page): Promise<Sent> {
  let sent: Promise<Sent> | undefined;
  await page.route("**/api/me", (route) => route.fulfill({ json: { id: "singer", email: null } }));
  await page.route("**/api/takes", (route) => {
    const request = route.request();
    sent = (async () => {
      const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { "Content-Type": request.headers()["content-type"]! } }).formData();
      const audio = form.get("audio") as Blob;
      return { record: JSON.parse(form.get("take") as string), wav: Buffer.from(await audio.arrayBuffer()) };
    })();
    return route.fulfill({ status: 201, json: { id: ID, url: `/take/${ID}` } });
  });
  await page.goto("/sing.html?test=1");
  await page.waitForFunction(() => window.__cantor);
  await page.evaluate(() => void window.__cantor.listen());
  await page.waitForTimeout(2500);
  await page.evaluate(() => void window.__cantor.listen());
  await page.evaluate(([gabc]) => window.__cantor.show(gabc, 0.5, 0.2), [GABC] as const);
  await page.getByRole("button", { name: "Send to a director" }).click();
  await expect(page.locator("#sent a")).toBeVisible();
  return sent!;
}

/** Serves `sent` at its link as the Worker would, with `over` in place; resolves the comments
 * posted. */
async function serve(page: Page, sent: Sent, over: Record<string, unknown> = {}) {
  const posted: unknown[] = [];
  const { judged, ...record } = sent.record;
  await page.route(`**/api/takes/${ID}`, (route) =>
    route.fulfill({
      json: {
        id: ID,
        ...record,
        judged: { verdict: judged.verdict, ribbon: judged.ribbon, told: judged.told, summary: judged.summary },
        created_at: "2026-10-16T19:00:00.000Z",
        mine: false,
        comments: [{ id: 1, note: 1, body: "Is this one sharp?", by: "singer", created_at: "2026-10-16T19:01:00.000Z" }],
        ...over,
      },
    }),
  );
  await page.route(`**/api/takes/${ID}/audio`, (route) => route.fulfill({ body: sent.wav, contentType: "audio/wav" }));
  await page.route(`**/api/takes/${ID}/comments`, (route) => {
    const body = route.request().postDataJSON() as { note: number; body: string };
    posted.push(body);
    return route.fulfill({ status: 201, json: { id: 2, ...body, by: "reader", created_at: "2026-10-16T19:05:00.000Z" } });
  });
  return posted;
}

test("a take's link opens it on its score, to play and to comment on note by note", async ({ page }) => {
  const sent = await sentTake(page);
  const posted = await serve(page, sent);
  await page.goto(`/take/${ID}`);
  await expect(page.locator("#title")).toHaveText(String(sent.record.title));
  await expect(page.locator("#kicker")).toHaveText(/^A take · /);
  // The ribbon and the marks as judged when the take was sung.
  await expect(page.locator("[data-band]")).toHaveCount(sent.record.judged.ribbon.length);
  await expect(page.locator("[data-mark]")).toHaveCount(sent.record.judged.verdict.marks.length);
  await expect(page.locator("#key")).toHaveText(/^The singer's key: |^Too little was heard/);
  // The comment already there, by note.
  await expect(page.locator("#comments li")).toHaveCount(1);
  await expect(page.locator("#comments li").first()).toHaveText(/^Note 2 · The singer · .*Is this one sharp\?$/s);
  await expect(page.locator(".pin")).toHaveCount(1);

  // Tapping a note chooses it for a comment.
  await page.getByRole("button", { name: "Comment on note 3", exact: true }).click();
  await expect(page.locator("#note")).toHaveValue("3");
  await page.getByRole("link", { name: "Comment on note 3" }).click();
  await expect(page.locator("#body")).toBeFocused();
  await expect(page.getByRole("button", { name: "Comment on note 3", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator("#body").fill("A little flat on the turn.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator("#comments li")).toHaveCount(2);
  expect(posted).toEqual([{ note: 2, body: "A little flat on the turn." }]);
  await expect(page.locator("#comments li").nth(1)).toHaveText(/^Note 3 · Director · .*A little flat on the turn\.$/s);
  await expect(page.locator("#body")).toHaveValue("");
  await expect(page.locator(".pin")).toHaveCount(2);

  // The take plays, and the cursor follows it on the score.
  await page.locator("#audio").evaluate((a: HTMLAudioElement) => void a.play());
  await expect(page.locator("#score .cursor")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#score .cantor-current")).not.toHaveCount(0);
});

test("a take of a chant the reader may not see is heard without its score", async ({ page }) => {
  const sent = await sentTake(page);
  await serve(page, sent, { slug: null, title: null, gabc: null, comments: [] });
  await page.goto(`/take/${ID}`);
  await expect(page.locator("#title")).toHaveText("A take");
  await expect(page.locator("#lede")).toHaveText("Listen to the take. Its score is shown to those signed in.");
  await expect(page.locator("#score")).toBeHidden();
  await expect(page.locator("#comments li")).toHaveText("No comments yet.");
  await expect(page.locator("#audio")).toHaveAttribute("src", `/api/takes/${ID}/audio`);
});

test("a link that names no take says so", async ({ page }) => {
  await page.goto(`/take/${"C".repeat(32)}`);
  await expect(page.locator("#status")).toHaveText(/^There is no take at this link|^The take could not be loaded/);
  await expect(page.locator("#take")).toBeHidden();
});
