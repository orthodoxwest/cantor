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
  // The audio in ranges, as the Worker serves it, so the page may seek in it.
  await page.route(`**/api/takes/${ID}/audio`, (route) => {
    const size = sent.wav.length;
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers()["range"] ?? "");
    if (!range) return route.fulfill({ body: sent.wav, contentType: "audio/wav", headers: { "Accept-Ranges": "bytes" } });
    const from = Number(range[1]);
    const to = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (from >= size) return route.fulfill({ status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return route.fulfill({
      status: 206,
      body: sent.wav.subarray(from, to + 1),
      contentType: "audio/wav",
      headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${from}-${to}/${size}` },
    });
  });
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
  await expect(page.locator("#comments li").nth(1)).toHaveText(/^Note 3 · A reader · .*A little flat on the turn\.$/s);
  await expect(page.locator("#body")).toHaveValue("");
  await expect(page.locator(".pin")).toHaveCount(2);

  // The arrows move the chosen note along the score; only the chosen band is a tab stop.
  await page.getByRole("button", { name: "Comment on note 3", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Comment on note 4", exact: true })).toBeFocused();
  await expect(page.locator("#note")).toHaveValue("4");
  await expect(page.locator('[data-band][tabindex="0"]')).toHaveCount(1);

  // The take plays, and the cursor follows it on the score.
  await page.locator("#audio").evaluate((a: HTMLAudioElement) => void a.play());
  await expect(page.locator("#score .cursor")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("#score .cantor-current")).not.toHaveCount(0);
  // Paused within a note, a redraw keeps its ink marked.
  const within = (sent.record.judged.ribbon as Array<{ from_s: number; to_s: number }>)[1]!;
  await page.locator("#audio").evaluate((a: HTMLAudioElement, t) => {
    a.pause();
    a.currentTime = t;
  }, (within.from_s + within.to_s) / 2);
  await expect(page.locator("#score .cantor-current")).not.toHaveCount(0);
  await page.getByRole("button", { name: "Comment on note 1", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
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
  // Choosing a note puts the take where its band begins, its times being the take's own.
  const band = (sent.record.judged.ribbon as Array<{ from_s: number }>)[1]!;
  await page.locator("#note").fill("2");
  await page.locator("#note").dispatchEvent("change");
  await expect.poll(() => page.locator("#audio").evaluate((a: HTMLAudioElement) => a.currentTime)).toBeCloseTo(Math.max(0, band.from_s - 0.2), 1);
});

test("one signed in puts their name to their comment", async ({ page }) => {
  const sent = await sentTake(page);
  await serve(page, sent, { comments: [] });
  const named: unknown[] = [];
  await page.route("**/api/me", (route) => {
    if (route.request().method() === "PUT") {
      named.push(route.request().postDataJSON());
      return route.fulfill({ json: { id: "director", email: null, name: "Fr. Director" } });
    }
    return route.fulfill({ json: { id: "director", email: null, name: null } });
  });
  await page.route(`**/api/takes/${ID}/comments`, (route) =>
    route.fulfill({ status: 201, json: { id: 3, ...route.request().postDataJSON(), by: "known", name: "Fr. Director", created_at: "2026-10-16T19:05:00.000Z" } }),
  );
  await page.goto(`/take/${ID}`);
  await expect(page.locator("#sign-line")).toBeHidden();
  await page.getByLabel("Your name").fill("  Fr.   Director ");
  await page.locator("#body").fill("Breathe before the turn.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator("#comments li").first()).toHaveText(/^Note \d+ · Fr\. Director \(signed in\) · .*Breathe before the turn\.$/s);
  expect(named).toEqual([{ name: "Fr. Director" }]);
  await expect(page.locator("#comments li .named bdi")).toHaveText("Fr. Director");
  // The name is kept, so the next comment does not give it again.
  await page.locator("#body").fill("And here.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator("#comments li")).toHaveCount(2);
  expect(named).toHaveLength(1);
  // A name the site refuses keeps the comment back, and says why.
  await page.unroute("**/api/me");
  await page.route("**/api/me", (route) =>
    route.request().method() === "PUT" ? route.fulfill({ status: 400, json: { error: "that name cannot be used" } }) : route.fulfill({ json: { id: "director", email: null, name: null } }),
  );
  await page.getByLabel("Your name").fill("You");
  await page.locator("#body").fill("Third.");
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator("#status")).toHaveText("The comment could not be posted: that name cannot be used");
  await expect(page.locator("#comments li")).toHaveCount(2);
  await expect(page.locator("#body")).toHaveValue("Third.");
});

test("one not signed in is offered to sign in and come back", async ({ page }) => {
  const sent = await sentTake(page);
  await serve(page, sent);
  await page.route("**/api/me", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.goto(`/take/${ID}`);
  await expect(page.locator("#name-line")).toBeHidden();
  await expect(page.locator("#sign-line")).toHaveText("Sign in to put your name to your comments.");
  await expect(page.locator("#sign-link")).toHaveAttribute("href", `/signin?next=${encodeURIComponent(`/take/${ID}`)}`);
});

test("the singer may remove a comment from their take", async ({ page }) => {
  const sent = await sentTake(page);
  await serve(page, sent, { mine: true });
  const removed: string[] = [];
  await page.route(`**/api/takes/${ID}/comments/*`, (route) => {
    removed.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 204 });
  });
  await page.goto(`/take/${ID}`);
  await expect(page.locator("#kicker")).toHaveText(/^Your take · /);
  // The singer is signed in, and writes as the singer.
  await expect(page.locator("#name-line")).toBeHidden();
  await expect(page.locator("#sign-line")).toBeHidden();
  await expect(page.locator("#comments li").first()).toHaveText(/^Note 2 · You · .*Remove.*Is this one sharp\?$/s);
  await page.getByRole("button", { name: "Remove the comment on note 2" }).click();
  await expect(page.locator("#comments li")).toHaveText("No comments yet.");
  expect(removed).toEqual([`DELETE /api/takes/${ID}/comments/1`]);
  await expect(page.locator(".pin")).toHaveCount(0);
});

test("a take stopped short is commented on only where it was judged", async ({ page }) => {
  const sent = await sentTake(page);
  const { judged } = sent.record;
  await serve(page, sent, { comments: [], judged: { verdict: { key_cents: 0, marks: [] }, ribbon: judged.ribbon.slice(0, 2), told: [], summary: judged.summary } });
  await page.goto(`/take/${ID}`);
  await expect(page.locator("#key")).toHaveText("The singer's key: as written. The take was stopped, and judged through note 2.");
  await expect(page.locator("[data-band]")).toHaveCount(2);
  await expect(page.locator("#note")).toHaveAttribute("max", "2");
  await page.getByRole("button", { name: "Comment on note 2", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Comment on note 2", exact: true })).toBeFocused();
});

test("a link that names no take says so", async ({ page }) => {
  await page.route(`**/api/takes/${"C".repeat(32)}`, (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.goto(`/take/${"C".repeat(32)}`);
  await expect(page.locator("#status")).toHaveText("There is no take at this link. It may have been copied short.");
  await expect(page.locator("#take")).toBeHidden();
});
