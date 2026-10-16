import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { MAX_AUDIO } from "../src/takes";

const ORIGIN = "http://localhost";
/** The public chant's score, as the library holds it (test/setup.ts). */
const UBI = "name:Ubi caritas;\n%%\n(c4) WHere(f) cha(gh)ri(hg)ty(h) (::)";

/** A WAV header and `n` bytes of silence. */
function wav(n = 4800): Uint8Array {
  const bytes = new Uint8Array(44 + n);
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => (bytes[at + i] = ch.charCodeAt(0)));
  ascii(0, "RIFF");
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  ascii(36, "data");
  return bytes;
}

const record = () => ({
  slug: "ubi-caritas",
  title: "Where charity and love are",
  gabc: UBI,
  pulse: 0.5,
  offset: 1.2,
  seconds: 9.5,
  judged: {
    verdict: { key_cents: -310, marks: [{ kind: "note", first: 0, last: 0, cents: 180 }] },
    ribbon: [{ index: 0, from_s: 1.2, to_s: 1.7, cents: 180, trace: [[1.3, 170]] }],
    told: ["This note was sung sharp."],
    summary: ["Your reciting tone held steady.", "The cadence was on pitch."],
    report: { extra: true },
  },
});

async function send(
  opts: { user?: string | null; origin?: string | null; audio?: Uint8Array | null; take?: unknown } = {},
): Promise<Response> {
  const form = new FormData();
  if (opts.audio !== null) form.append("audio", new File([(opts.audio ?? wav()).slice()], "take.wav", { type: "audio/wav" }));
  if (opts.take !== null) form.append("take", typeof opts.take === "string" ? opts.take : JSON.stringify(opts.take ?? record()));
  const headers: Record<string, string> = {};
  if (opts.user !== null) headers["X-Dev-User"] = opts.user ?? "singer";
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  return await app.request("/api/takes", { method: "POST", body: form, headers }, env);
}

const get = (path: string, headers?: HeadersInit) => app.request(path, { headers }, env);

describe("takes", () => {
  it("stores a sent take under an unguessable id and serves it to whoever holds the id", async () => {
    const res = await send();
    expect(res.status).toBe(201);
    const { id, url } = await res.json<{ id: string; url: string }>();
    expect(id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(url).toBe(`/take/${id}`);
    const row = await env.DB.prepare("SELECT user_id, chant_slug, title, public, seconds, bytes FROM takes WHERE id = ?").bind(id).first();
    expect(row).toEqual({ user_id: "singer", chant_slug: "ubi-caritas", title: "Where charity and love are", public: 1, seconds: 9.5, bytes: wav().length });

    // A reader with no account.
    const take = await get(`/api/takes/${id}`);
    expect(take.status).toBe(200);
    expect(take.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await take.json<Record<string, unknown>>();
    expect(body).toMatchObject({ id, slug: "ubi-caritas", gabc: UBI, pulse: 0.5, offset: 1.2, mine: false });
    // The verdict and what the page draws of it; nothing else of what the page sent.
    expect(Object.keys(body.judged as object).sort()).toEqual(["ribbon", "summary", "told", "verdict"]);
    expect((body.judged as { summary: string[] }).summary).toHaveLength(2);
    expect((await (await get(`/api/takes/${id}`, { "X-Dev-User": "singer" })).json<{ mine: boolean }>()).mine).toBe(true);
    expect((await (await get(`/api/takes/${id}`, { "X-Dev-User": "someone" })).json<{ mine: boolean }>()).mine).toBe(false);

    const audio = await get(`/api/takes/${id}/audio`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("Content-Type")).toBe("audio/wav");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(wav());
    const part = await get(`/api/takes/${id}/audio`, { Range: "bytes=4-11" });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe(`bytes 4-11/${wav().length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(wav().subarray(4, 12));
  });

  it("serves byte ranges as asked, refusing one past the end", async () => {
    const { id } = await (await send()).json<{ id: string }>();
    const size = wav().length;
    const ranged = async (range: string) => {
      const res = await get(`/api/takes/${id}/audio`, { Range: range });
      return { status: res.status, range: res.headers.get("Content-Range"), length: (await res.arrayBuffer()).byteLength };
    };
    expect(await ranged("bytes=0-")).toEqual({ status: 206, range: `bytes 0-${size - 1}/${size}`, length: size });
    expect(await ranged("bytes=0-1")).toEqual({ status: 206, range: `bytes 0-1/${size}`, length: 2 });
    expect(await ranged("bytes=10-99999")).toEqual({ status: 206, range: `bytes 10-${size - 1}/${size}`, length: size - 10 });
    expect(await ranged("bytes=-4")).toEqual({ status: 206, range: `bytes ${size - 4}-${size - 1}/${size}`, length: 4 });
    expect(await ranged("bytes=-99999")).toEqual({ status: 206, range: `bytes 0-${size - 1}/${size}`, length: size });
    for (const unsatisfiable of [`bytes=${size}-`, "bytes=99999-", "bytes=-0"])
      expect(await ranged(unsatisfiable)).toEqual({ status: 416, range: `bytes */${size}`, length: 0 });
    for (const whole of ["bytes=10-5", "bytes=abc", "items=0-5", "bytes=0-1,5-6", "bytes=-"])
      expect(await ranged(whole)).toEqual({ status: 200, range: null, length: size });
  });

  it("shows a reader not signed in which chant was sung, and its score, only for a public chant's take", async () => {
    const { id } = await (await send({ take: { ...record(), slug: "private-test", title: "Booklet antiphon", gabc: "(c4) BOok(f) (::)" } })).json<{ id: string }>();
    expect(await (await get(`/api/takes/${id}`)).json()).toMatchObject({ slug: null, title: null, gabc: null });
    expect(await (await get(`/api/takes/${id}`, { "X-Dev-User": "director" })).json()).toMatchObject({
      slug: "private-test",
      title: "Booklet antiphon",
      gabc: "(c4) BOok(f) (::)",
    });
    // A public chant's take, under the library's title whatever the page sent.
    const { id: open } = await (await send({ take: { ...record(), title: "Something else" } })).json<{ id: string }>();
    expect(await (await get(`/api/takes/${open}`)).json()).toMatchObject({ slug: "ubi-caritas", gabc: UBI, title: "Where charity and love are" });
    // A score the library does not hold is not shown, whatever slug it is sent under.
    const { id: other } = await (await send({ take: { ...record(), gabc: "(c4) BOok(f) (::)" } })).json<{ id: string }>();
    expect(await (await get(`/api/takes/${other}`)).json()).toMatchObject({ slug: null, gabc: null, title: null });
    // What was public when sent stays so when the library changes.
    await env.DB.prepare("UPDATE chants SET gabc = gabc || ' ' WHERE slug = 'ubi-caritas'").run();
    expect(await (await get(`/api/takes/${open}`)).json()).toMatchObject({ gabc: UBI });
    await env.DB.prepare("UPDATE chants SET gabc = ? WHERE slug = 'ubi-caritas'").bind(UBI).run();
  });

  it("stores a take whole within the request's own context", async () => {
    const ctx = createExecutionContext();
    const form = new FormData();
    form.append("audio", new File([wav().slice()], "take.wav"));
    form.append("take", JSON.stringify(record()));
    const res = await app.request("/api/takes", { method: "POST", body: form, headers: { "X-Dev-User": "singer", Origin: ORIGIN } }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();
    expect((await get(`/api/takes/${id}/audio`)).status).toBe(200);
  });

  it("stops reading a body longer than any take, its length declared or not", async () => {
    const big = new Uint8Array(MAX_AUDIO + 3 * 1024 * 1024);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const res = await app.request(
      "/api/takes",
      { method: "POST", body, headers: { "X-Dev-User": "singer", Origin: ORIGIN, "Content-Type": "multipart/form-data; boundary=x" }, duplex: "half" } as RequestInit,
      env,
    );
    expect(res.status).toBe(413);
  });

  it("gives every take its own id", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) ids.add((await (await send()).json<{ id: string }>()).id);
    expect(ids.size).toBe(3);
  });

  it("takes a take only from a signed-in singer on a page of this site", async () => {
    expect((await send({ user: null })).status).toBe(401);
    expect((await send({ origin: null })).status).toBe(403);
    expect((await send({ origin: "https://evil.example" })).status).toBe(403);
    expect((await send({ origin: "null" })).status).toBe(403);
  });

  it("refuses a take that is not a WAV, or whose record is not one", async () => {
    expect((await send({ audio: new TextEncoder().encode("not audio at all, really not, no ".repeat(3)) })).status).toBe(400);
    expect((await send({ audio: null })).status).toBe(400);
    expect((await send({ take: null })).status).toBe(400);
    expect((await send({ take: "{" })).status).toBe(400);
    for (const over of [{ slug: "" }, { pulse: "fast" }, { seconds: Infinity }, { gabc: 3 }, { judged: { ribbon: [] } }, { judged: null }])
      expect((await send({ take: { ...record(), ...over } })).status).toBe(400);
    const judged = record().judged;
    for (const over of [
      { ribbon: [{ ...judged.ribbon[0]!, cents: "sharp" }] },
      { ribbon: [{ ...judged.ribbon[0]!, index: -1 }] },
      { ribbon: [{ ...judged.ribbon[0]!, trace: [[1, "x"]] }] },
      { verdict: { ...judged.verdict, marks: [{ ...judged.verdict.marks[0]!, kind: "<script>" }] } },
      { verdict: { ...judged.verdict, marks: [{ ...judged.verdict.marks[0]!, first: 0.5 }] } },
      { verdict: { ...judged.verdict, marks: [{ ...judged.verdict.marks[0]!, last: 1 }] } },
      { verdict: { marks: judged.verdict.marks } },
      { ribbon: [{ ...judged.ribbon[0]!, index: 9000 }] },
    ])
      expect((await send({ take: { ...record(), judged: { ...judged, ...over } } })).status).toBe(400);
    expect((await send({ audio: new Uint8Array(MAX_AUDIO + 1) })).status).toBe(413);
  });

  it("keeps only the record's own fields", async () => {
    const judged = record().judged;
    const extra = {
      ...judged,
      verdict: { ...judged.verdict, marks: [{ ...judged.verdict.marks[0]!, evil: "<script>" }] },
      ribbon: [{ ...judged.ribbon[0]!, x: '"><script>' }],
    };
    const { id } = await (await send({ take: { ...record(), judged: extra, owner: "someone else", mine: true } })).json<{ id: string }>();
    const body = await (await get(`/api/takes/${id}`)).json<Record<string, unknown>>();
    const { report: _, ...kept } = judged;
    expect(body.judged).toEqual(kept);
    expect(body).not.toHaveProperty("owner");
    expect(body.mine).toBe(false);
  });

  it("finds nothing for an id it did not give", async () => {
    for (const id of ["x", "A".repeat(32), "../../etc", "A".repeat(31) + "."]) {
      expect((await get(`/api/takes/${encodeURIComponent(id)}`)).status).toBe(404);
      expect((await get(`/api/takes/${encodeURIComponent(id)}/audio`)).status).toBe(404);
    }
    // A file in the bucket with no row is not served.
    await env.TAKES.put(`takes/${"B".repeat(32)}.json`, "{}");
    expect((await get(`/api/takes/${"B".repeat(32)}`)).status).toBe(404);
  });

  it("lists no takes", async () => {
    expect((await get("/api/takes")).status).toBe(404);
    expect((await get("/api/takes", { "X-Dev-User": "singer" })).status).toBe(404);
  });
});

describe("comments", () => {
  const comment = (id: string, sent: unknown, headers: Record<string, string> = {}) =>
    app.request(
      `/api/takes/${id}/comments`,
      { method: "POST", body: typeof sent === "string" ? sent : JSON.stringify(sent), headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers } },
      env,
    );

  it("takes a comment on a note from whoever holds the link, and says when the singer wrote it", async () => {
    const { id } = await (await send()).json<{ id: string }>();
    const reader = await comment(id, { note: 0, body: "  Lighter here.  " });
    expect(reader.status).toBe(201);
    expect(await reader.json()).toMatchObject({ note: 0, body: "Lighter here.", by: "reader" });
    // The page cannot claim to be the singer; the Worker knows the singer.
    expect(await (await comment(id, { note: 0, body: "Thank you.", by: "singer" }, { "X-Dev-User": "someone" })).json()).toMatchObject({ by: "known" });
    expect(await (await comment(id, { note: 0, body: "Will do." }, { "X-Dev-User": "singer" })).json()).toMatchObject({ by: "singer" });
    const take = await (await get(`/api/takes/${id}`)).json<{ comments: Array<{ note: number; body: string; by: string }> }>();
    expect(take.comments.map((c) => [c.note, c.body, c.by])).toEqual([
      [0, "Lighter here.", "reader"],
      [0, "Thank you.", "known"],
      [0, "Will do.", "singer"],
    ]);
    // No name is given for the singer or a reader, and no id or email for anyone.
    expect(take.comments.every((c) => !("author_id" in c))).toBe(true);
    const row = await env.DB.prepare("SELECT author_id FROM take_comments WHERE body = 'Will do.'").first();
    expect(row).toEqual({ author_id: "singer" });
  });

  it("names a signed-in writer by the name they gave when they wrote", async () => {
    const { id } = await (await send()).json<{ id: string }>();
    await env.DB.prepare("INSERT INTO people (user_id, name) VALUES ('director', 'Fr. Director'), ('singer', 'The singer''s own')").run();
    expect(await (await comment(id, { note: 0, body: "Breathe here." }, { "X-Dev-User": "director" })).json()).toMatchObject({ by: "known", name: "Fr. Director" });
    await comment(id, { note: 0, body: "Thanks." }, { "X-Dev-User": "singer" });
    await comment(id, { note: 0, body: "Nice." });
    await env.DB.prepare("UPDATE people SET name = 'Fr. D.' WHERE user_id = 'director'").run();
    const take = await (await get(`/api/takes/${id}`)).json<{ comments: Array<{ by: string; name: string | null }> }>();
    expect(take.comments.map((c) => [c.by, c.name])).toEqual([
      ["known", "Fr. Director"],
      ["singer", null],
      ["reader", null],
    ]);
  });

  it("refuses a comment from another site, on no take, or that is not one", async () => {
    const { id } = await (await send()).json<{ id: string }>();
    expect((await comment(id, { note: 0, body: "x" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await comment("A".repeat(32), { note: 0, body: "x" })).status).toBe(404);
    for (const bad of [{ note: -1, body: "x" }, { note: 1.5, body: "x" }, { note: "1", body: "x" }, { note: 0, body: "   " }, { note: 1, body: "x" }, { note: 0, body: "x".repeat(2001) }, "{", "null"])
      expect((await comment(id, bad)).status).toBe(400);
    expect((await comment(id, JSON.stringify({ note: 0, body: "x".repeat(20_000) }))).status).toBe(413);
    expect((await (await get(`/api/takes/${id}`)).json<{ comments: unknown[] }>()).comments).toEqual([]);
  });

  it("holds no more than its share of comments", async () => {
    const { id } = await (await send()).json<{ id: string }>();
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) INSERT INTO take_comments (take_id, note, body, by_singer) SELECT ?, 0, 'x', 0 FROM n",
    )
      .bind(id)
      .run();
    expect((await comment(id, { note: 0, body: "one more" })).status).toBe(429);
    // The singer and those signed in are never refused.
    expect((await comment(id, { note: 0, body: "Mine." }, { "X-Dev-User": "singer" })).status).toBe(201);
    expect((await comment(id, { note: 0, body: "Known." }, { "X-Dev-User": "someone" })).status).toBe(201);
  });

  it("lets the singer, and no one else, remove a comment", async () => {
    const { id } = await (await send()).json<{ id: string }>();
    const { id: cid } = await (await comment(id, { note: 0, body: "Spam." })).json<{ id: number }>();
    const remove = (headers: Record<string, string>) =>
      app.request(`/api/takes/${id}/comments/${cid}`, { method: "DELETE", headers: { Origin: ORIGIN, ...headers } }, env);
    expect((await remove({})).status).toBe(401);
    expect((await remove({ "X-Dev-User": "someone" })).status).toBe(403);
    expect((await remove({ "X-Dev-User": "singer", Origin: "https://evil.example" })).status).toBe(403);
    expect((await remove({ "X-Dev-User": "singer" })).status).toBe(204);
    expect((await remove({ "X-Dev-User": "singer" })).status).toBe(404);
    // Only an id as the site gives one, and only of this take's comments.
    const other = (await (await send()).json<{ id: string }>()).id;
    const { id: theirs } = await (await comment(other, { note: 0, body: "Theirs." })).json<{ id: number }>();
    for (const wrong of [`/api/takes/${id}/comments/${theirs}`, `/api/takes/${other}/comments/0x${theirs.toString(16)}`])
      expect((await app.request(wrong, { method: "DELETE", headers: { Origin: ORIGIN, "X-Dev-User": "singer" } }, env)).status).toBe(404);
    expect((await (await get(`/api/takes/${other}`)).json<{ comments: unknown[] }>()).comments).toHaveLength(1);
    expect((await (await get(`/api/takes/${id}`)).json<{ comments: unknown[] }>()).comments).toEqual([]);
  });
});

describe("a take's page", () => {
  it("is the app's take page, cached by no one, giving no referrer", async () => {
    const asked: string[] = [];
    const ASSETS = {
      fetch: async (url: string | URL | Request) => {
        asked.push(new URL(url instanceof Request ? url.url : url).pathname);
        return new Response("<!doctype html><title>Take</title>", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=3600" } });
      },
    };
    const res = await app.request(`/take/${"A".repeat(32)}`, {}, { ...env, ASSETS } as unknown as Env);
    expect(res.status).toBe(200);
    expect(asked).toEqual(["/take"]);
    expect(await res.text()).toContain("<title>Take</title>");
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const slash = await app.request(`/take/${"A".repeat(32)}/`, {}, { ...env, ASSETS } as unknown as Env);
    expect(slash.status).toBe(301);
    expect(slash.headers.get("Location")).toBe(`/take/${"A".repeat(32)}`);
  });
});
