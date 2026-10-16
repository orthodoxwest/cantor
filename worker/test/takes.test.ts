import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { MAX_AUDIO } from "../src/takes";

const ORIGIN = "http://localhost";

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
  gabc: "(c4) WHere(f) (::)",
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
    const row = await env.DB.prepare("SELECT user_id, chant_slug, title, seconds FROM takes WHERE id = ?").bind(id).first();
    expect(row).toEqual({ user_id: "singer", chant_slug: "ubi-caritas", title: "Where charity and love are", seconds: 9.5 });

    // A reader with no account.
    const take = await get(`/api/takes/${id}`);
    expect(take.status).toBe(200);
    expect(take.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await take.json<Record<string, unknown>>();
    expect(body).toMatchObject({ id, slug: "ubi-caritas", gabc: "(c4) WHere(f) (::)", pulse: 0.5, offset: 1.2, mine: false });
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

  it("gives every take its own id", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) ids.add((await (await send()).json<{ id: string }>()).id);
    expect(ids.size).toBe(3);
  });

  it("takes a take only from a signed-in singer on a page of this site", async () => {
    expect((await send({ user: null })).status).toBe(401);
    expect((await send({ origin: null })).status).toBe(401);
    expect((await send({ origin: "https://evil.example" })).status).toBe(401);
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
