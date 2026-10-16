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
    expect((await send({ audio: new Uint8Array(MAX_AUDIO + 1) })).status).toBe(413);
  });

  it("keeps only the record's own fields", async () => {
    const { id } = await (await send({ take: { ...record(), owner: "someone else", mine: true } })).json<{ id: string }>();
    const body = await (await get(`/api/takes/${id}`)).json<Record<string, unknown>>();
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
