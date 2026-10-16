// Sent takes. A signed-in singer sends a take they sang: its audio (the microphone's, never the
// guide's) and the judged result the core computed when it was sung, with the score it was
// judged against. The answer is a capability id: whoever holds it may hear and read the take,
// with no account. Nothing lists takes to a reader.
import { Hono, type Context } from "hono";
import { identity, type Identity } from "./identity";

const takes = new Hono<{ Bindings: Env }>();

/** 24 random bytes, base64url: 192 bits. */
const ID = /^[A-Za-z0-9_-]{32}$/;
/** The largest take accepted: about three minutes at 24 kHz. */
export const MAX_AUDIO = 16 * 1024 * 1024;
/** The largest judged result and score accepted, as JSON. */
export const MAX_RECORD = 2 * 1024 * 1024;

const audioKey = (id: string) => `takes/${id}.wav`;
const recordKey = (id: string) => `takes/${id}.json`;

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

/** The caller of a request that changes something: signed in, and sent by a page of this site.
 * The Access cookie travels with requests from anywhere, so a write is taken only with an
 * Origin that is this site's, which a browser always sends on a POST and no other site can
 * forge. */
export async function writer(c: Context<{ Bindings: Env }>): Promise<Identity | null> {
  if (c.req.header("Origin") !== new URL(c.req.url).origin) return null;
  return identity(c.req.raw.headers, c.env);
}

/** What a sent take holds besides its audio, as the singer's page sends it. */
export interface TakeRecord {
  slug: string;
  title: string;
  /** The score the take was judged against. */
  gabc: string;
  /** Seconds a pulse, and when the first note started in the take, in seconds. */
  pulse: number;
  offset: number;
  /** The take's length in seconds. */
  seconds: number;
  /** The ear's `Judged`, as the core serialized it. */
  judged: { verdict: { marks: unknown[] }; ribbon: unknown[]; told: string[]; summary: string[] };
}

const finite = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
const text = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

/** The record in `raw`, if it is one; only the fields named are kept. */
export function parseRecord(raw: string): TakeRecord | null {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof r !== "object" || r === null) return null;
  const j = r.judged as Record<string, unknown> | null | undefined;
  const verdict = j?.verdict as Record<string, unknown> | null | undefined;
  if (!text(r.slug, 200) || !text(r.title, 300) || !text(r.gabc, 200_000)) return null;
  if (!finite(r.pulse, 0.05, 5) || !finite(r.offset, -60, 900) || !finite(r.seconds, 0.1, 900)) return null;
  if (!j || !verdict || !Array.isArray(verdict.marks) || !Array.isArray(j.ribbon) || !strings(j.told) || !strings(j.summary)) return null;
  return {
    slug: r.slug,
    title: r.title,
    gabc: r.gabc,
    pulse: r.pulse,
    offset: r.offset,
    seconds: r.seconds,
    judged: j as TakeRecord["judged"],
  };
}

/** Whether `bytes` begin as a WAV file does. */
function isWav(bytes: Uint8Array): boolean {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  return bytes.length > 44 && tag(0) === "RIFF" && tag(8) === "WAVE";
}

// Sends a take: multipart, the audio as `audio` (WAV) and the record as `take` (JSON).
takes.post("/", async (c) => {
  c.header("Cache-Control", "no-store");
  const who = await writer(c);
  if (!who) return c.json({ error: "unauthorized" }, 401);
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (length > MAX_AUDIO + MAX_RECORD + 64 * 1024) return c.json({ error: "too large" }, 413);
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return c.json({ error: "bad request" }, 400);
  }
  const audio = form.get("audio");
  const take = form.get("take");
  if (!(audio instanceof File) || typeof take !== "string") return c.json({ error: "bad request" }, 400);
  if (audio.size > MAX_AUDIO || take.length > MAX_RECORD) return c.json({ error: "too large" }, 413);
  const record = parseRecord(take);
  const bytes = new Uint8Array(await audio.arrayBuffer());
  if (!record || !isWav(bytes)) return c.json({ error: "bad request" }, 400);
  const id = newId();
  await c.env.TAKES.put(audioKey(id), bytes, { httpMetadata: { contentType: "audio/wav" } });
  await c.env.TAKES.put(recordKey(id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
  try {
    await c.env.DB.prepare("INSERT INTO takes (id, user_id, chant_slug, title, seconds) VALUES (?, ?, ?, ?, ?)")
      .bind(id, who.id, record.slug, record.title, record.seconds)
      .run();
  } catch (error) {
    // A take with no row is never served; its files go too.
    await c.env.TAKES.delete([audioKey(id), recordKey(id)]).catch(() => {});
    throw error;
  }
  return c.json({ id, url: `/take/${id}` }, 201);
});

/** The take's row, when `id` names one. */
async function row(c: Context<{ Bindings: Env }>, id: string) {
  if (!ID.test(id)) return null;
  return c.env.DB.prepare("SELECT id, user_id, created_at FROM takes WHERE id = ?")
    .bind(id)
    .first<{ id: string; user_id: string; created_at: string }>();
}

// A take's record, to whoever holds its id; `mine` says whether the caller sent it.
takes.get("/:id", async (c) => {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Robots-Tag", "noindex");
  const id = c.req.param("id");
  const found = await row(c, id);
  const object = found && (await c.env.TAKES.get(recordKey(id)));
  if (!found || !object) return c.json({ error: "not found" }, 404);
  const record = await object.json<TakeRecord>();
  const who = await identity(c.req.raw.headers, c.env);
  return c.json({ id, ...record, created_at: found.created_at, mine: who?.id === found.user_id });
});

// A take's audio, to whoever holds its id, a range of it when asked (for seeking).
takes.get("/:id/audio", async (c) => {
  const id = c.req.param("id");
  const found = await row(c, id);
  const object = found && (await c.env.TAKES.get(audioKey(id), { range: c.req.raw.headers }));
  if (!found || !object || !("body" in object)) return c.json({ error: "not found" }, 404);
  const headers = new Headers({
    "Content-Type": "audio/wav",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Robots-Tag": "noindex",
  });
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && c.req.header("Range")) {
    const start = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
    const length = range.suffix ?? range.length ?? object.size - start;
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
});

export default takes;
