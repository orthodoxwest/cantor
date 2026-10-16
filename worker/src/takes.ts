// Sent takes. A signed-in singer sends a take they sang: its audio (the microphone's, never the
// guide's) and the judged result the core computed when it was sung, with the score it was
// judged against. The answer is a capability id: whoever holds it may hear and read the take,
// with no account. Nothing lists takes to a reader. A take of a private chant keeps its score
// from a reader who is not signed in, as /api/chants does.
import { Hono, type Context } from "hono";
import { identity, type Identity } from "./identity";

const takes = new Hono<{ Bindings: Env }>();

/** 24 random bytes, base64url: 192 bits. */
const ID = /^[A-Za-z0-9_-]{32}$/;
/** The largest take accepted: nearly six minutes at 24 kHz. */
export const MAX_AUDIO = 16 * 1024 * 1024;
/** The largest judged result and score accepted, as JSON. */
export const MAX_RECORD = 2 * 1024 * 1024;

/** The largest request body read: the take, its record, and the form around them. */
const MAX_BODY = MAX_AUDIO + MAX_RECORD + 64 * 1024;

/** `request`'s body, read no further than `max` bytes; null when it is longer. */
export async function bounded(request: Request, max: number): Promise<Blob | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > max) return null;
  if (!request.body) return new Blob([]);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks);
}

const audioKey = (id: string) => `takes/${id}.wav`;
const recordKey = (id: string) => `takes/${id}.json`;

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

/** The caller of a request that changes something: signed in, and sent by a page of this site;
 * else the status to refuse it with. The Access cookie travels with requests from anywhere, so a
 * write is taken only with an Origin that is this site's, which a browser always sends on a POST
 * and no other site can forge. */
export async function writer(c: Context<{ Bindings: Env }>): Promise<{ who: Identity } | { refuse: 401 | 403 }> {
  if (c.req.header("Origin") !== new URL(c.req.url).origin) return { refuse: 403 };
  const who = await identity(c.req.raw.headers, c.env);
  return who ? { who } : { refuse: 401 };
}

/** Runs `work` to its end even if the caller goes away, and waits for it. */
function finish<T>(c: Context<{ Bindings: Env }>, work: Promise<T>): Promise<T> {
  let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    // No context outside the Workers runtime (tests calling the app directly).
  }
  ctx?.waitUntil(work.catch(() => {}));
  return work;
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
  judged: { verdict: { key_cents: number | null; marks: Mark[] }; ribbon: Band[]; told: string[]; summary: string[] };
}

/** One note of the ribbon (web ribbon.ts `Band`); its times are in seconds of the take. */
interface Band {
  index: number;
  from_s: number;
  to_s: number;
  cents: number | null;
  trace: Array<[number, number]>;
}

/** One of the judge's marks (web marks.ts `Mark`). */
interface Mark {
  kind: "note" | "verse" | "verse-missing";
  first: number;
  last: number;
  cents: number | null;
}

const finite = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
const text = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
const index = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 10_000;
const centsOrNull = (x: unknown) => x === null || finite(x, -1e5, 1e5);

/** The ribbon's bands as the page draws them (ribbon.ts `Band`), one a note in order, rebuilt
 * from the fields checked; null if any is not one. */
function ribbonOf(bands: unknown): Band[] | null {
  if (!Array.isArray(bands) || bands.length > 10_000) return null;
  const out: Band[] = [];
  for (const [i, b] of (bands as Array<Record<string, unknown> | null>).entries()) {
    if (typeof b !== "object" || b === null || b.index !== i) return null;
    const { from_s, to_s, cents, trace } = b;
    if (!finite(from_s, -1e4, 1e4) || !finite(to_s, -1e4, 1e4) || !centsOrNull(cents) || !Array.isArray(trace)) return null;
    const points: Array<[number, number]> = [];
    for (const p of trace as unknown[]) {
      if (!Array.isArray(p) || p.length !== 2 || !finite(p[0], -1e4, 1e4) || !finite(p[1], -1e5, 1e5)) return null;
      points.push([p[0], p[1]]);
    }
    out.push({ index: i, from_s, to_s, cents: cents as number | null, trace: points });
  }
  return out;
}

/** The judge's marks as the page draws them (marks.ts `Mark`), each over notes of the take,
 * rebuilt from the fields checked; null if any is not one. */
function marksOf(marks: unknown, notes: number): Mark[] | null {
  if (!Array.isArray(marks) || marks.length > notes + 1000) return null;
  const out: Mark[] = [];
  for (const m of marks as Array<Record<string, unknown> | null>) {
    if (typeof m !== "object" || m === null) return null;
    const { kind, first, last, cents } = m;
    if (kind !== "note" && kind !== "verse" && kind !== "verse-missing") return null;
    if (!index(first) || !index(last) || first > last || last >= notes || !centsOrNull(cents)) return null;
    out.push({ kind, first, last, cents: cents as number | null });
  }
  return out;
}

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
  const ribbon = ribbonOf(j?.ribbon);
  const marks = ribbon && marksOf(verdict?.marks, ribbon.length);
  if (!j || !verdict || !ribbon || !marks || !("key_cents" in verdict) || !centsOrNull(verdict.key_cents)) return null;
  if (!strings(j.told) || !strings(j.summary)) return null;
  return {
    slug: r.slug,
    title: r.title,
    gabc: r.gabc,
    pulse: r.pulse,
    offset: r.offset,
    seconds: r.seconds,
    // The judge's verdict and what the page draws of it, and no more: the notes it was judged
    // against are the score's, which a reader not signed in may not be given.
    judged: { verdict: { key_cents: verdict.key_cents as number | null, marks }, ribbon, told: j.told, summary: j.summary },
  };
}

/** Whether `file` begins as a WAV file does. */
async function isWav(file: Blob): Promise<boolean> {
  if (file.size <= 44) return false;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const tag = (at: number) => String.fromCharCode(...head.subarray(at, at + 4));
  return tag(0) === "RIFF" && tag(8) === "WAVE";
}

// Sends a take: multipart, the audio as `audio` (WAV) and the record as `take` (JSON).
takes.post("/", async (c) => {
  c.header("Cache-Control", "no-store");
  const caller = await writer(c);
  if ("refuse" in caller) return c.json({ error: caller.refuse === 403 ? "forbidden" : "unauthorized" }, caller.refuse);
  const { who } = caller;
  const body = await bounded(c.req.raw, MAX_BODY);
  if (!body) return c.json({ error: "too large" }, 413);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "Content-Type": c.req.header("Content-Type") ?? "" } }).formData();
  } catch {
    return c.json({ error: "bad request" }, 400);
  }
  const audio = form.get("audio");
  const take = form.get("take");
  if (!(audio instanceof File) || typeof take !== "string") return c.json({ error: "bad request" }, 400);
  if (audio.size > MAX_AUDIO || take.length > MAX_RECORD) return c.json({ error: "too large" }, 413);
  const record = parseRecord(take);
  if (!record || !(await isWav(audio))) return c.json({ error: "bad request" }, 400);
  // A public chant's take, sung from the score the library holds, is shown to any reader with
  // its link, under the library's title; decided now, so later changes to the library leave
  // it as it was sent.
  const library = await c.env.DB.prepare("SELECT title FROM chants WHERE slug = ? AND gabc = ?")
    .bind(record.slug, record.gabc)
    .first<{ title: string }>();
  const id = newId();
  // Stored whole or not at all, even if the singer goes away mid-way: a take with no row is
  // never served, so whatever of it was written goes too.
  await finish(
    c,
    (async () => {
      try {
        await c.env.TAKES.put(audioKey(id), audio, { httpMetadata: { contentType: "audio/wav" } });
        await c.env.TAKES.put(recordKey(id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
        await c.env.DB.prepare(
          "INSERT INTO takes (id, user_id, chant_slug, title, public, seconds, bytes, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(id, who.id, record.slug, library?.title ?? record.title, library ? 1 : 0, record.seconds, audio.size, record.judged.ribbon.length)
          .run();
      } catch (error) {
        await c.env.TAKES.delete([audioKey(id), recordKey(id)]).catch(() => {});
        throw error;
      }
    })(),
  );
  return c.json({ id, url: `/take/${id}` }, 201);
});

/** The take's row, when `id` names one. */
async function row(c: Context<{ Bindings: Env }>, id: string) {
  if (!ID.test(id)) return null;
  return c.env.DB.prepare("SELECT id, user_id, title, public, bytes, notes, created_at FROM takes WHERE id = ?")
    .bind(id)
    .first<{ id: string; user_id: string; title: string; public: number; bytes: number; notes: number | null; created_at: string }>();
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
  // A reader not signed in sees which chant was sung, and its score, only for a public chant's
  // take; a private chant (booklet-derived) is shown only to a known caller.
  const open = who !== null || found.public === 1;
  const { results: comments } = await c.env.DB.prepare(
    "SELECT id, note, body, by_singer, author_id, author_name AS name, created_at FROM take_comments WHERE take_id = ? ORDER BY id",
  )
    .bind(id)
    .all<CommentRow>();
  return c.json({
    id,
    ...record,
    comments: comments.map(asComment),
    slug: open ? record.slug : null,
    title: open ? found.title : null,
    gabc: open ? record.gabc : null,
    created_at: found.created_at,
    mine: who?.id === found.user_id,
  });
});

/** The longest comment, in characters; the most comments a take gathers from writers the
 * Worker does not know (the singer and those signed in are never refused); the largest request
 * body a comment is read from. */
export const MAX_COMMENT = 2000;
export const MAX_COMMENTS = 300;
const MAX_COMMENT_BODY = 16 * 1024;

interface CommentRow {
  id: number;
  note: number;
  body: string;
  by_singer: number;
  author_id: string | null;
  /** The name its writer had given when they wrote it, when signed in. */
  name: string | null;
  created_at: string;
}

/** A comment as the page reads it: who wrote it as the Worker knew them (the singer, someone
 * signed in with the name they gave, or a reader it did not know), never their id or email. */
const asComment = ({ by_singer, author_id, name, ...comment }: CommentRow) => ({
  ...comment,
  by: by_singer ? "singer" : author_id ? "known" : "reader",
  name: !by_singer && author_id ? name : null,
});

// A comment on one note of a take, from whoever holds its link. The Worker, not the page, says
// whether the singer wrote it.
takes.post("/:id/comments", async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") !== new URL(c.req.url).origin) return c.json({ error: "forbidden" }, 403);
  const id = c.req.param("id");
  const found = await row(c, id);
  if (!found) return c.json({ error: "not found" }, 404);
  const raw = await bounded(c.req.raw, MAX_COMMENT_BODY);
  if (!raw) return c.json({ error: "too large" }, 413);
  const sent = await raw
    .text()
    .then((text) => JSON.parse(text) as { note?: unknown; body?: unknown } | null)
    .catch(() => null);
  const note = sent?.note;
  const body = typeof sent?.body === "string" ? sent.body.trim() : "";
  if (!index(note) || (found.notes !== null && note >= found.notes) || !body || body.length > MAX_COMMENT)
    return c.json({ error: "bad request" }, 400);
  const who = await identity(c.req.raw.headers, c.env);
  const bySinger = who?.id === found.user_id ? 1 : 0;
  // A writer the Worker does not know may add one while the take holds fewer than
  // MAX_COMMENTS of theirs, counted in the same statement that adds it.
  const added = await c.env.DB.prepare(
    `INSERT INTO take_comments (take_id, note, body, by_singer, author_id, author_name)
     SELECT ?1, ?2, ?3, ?4, ?5, (SELECT name FROM people WHERE user_id = ?5)
     WHERE ?5 IS NOT NULL OR (SELECT count(*) FROM take_comments WHERE take_id = ?1 AND author_id IS NULL) < ?6
     RETURNING id, note, body, by_singer, author_id, author_name AS name, created_at`,
  )
    .bind(id, note, body, bySinger, who?.id ?? null, MAX_COMMENTS)
    .first<CommentRow>();
  if (!added) return c.json({ error: "this take has as many comments as it may hold" }, 429);
  return c.json(asComment(added), 201);
});

// The singer removes a comment from their take.
takes.delete("/:id/comments/:comment", async (c) => {
  c.header("Cache-Control", "no-store");
  const caller = await writer(c);
  if ("refuse" in caller) return c.json({ error: caller.refuse === 403 ? "forbidden" : "unauthorized" }, caller.refuse);
  const id = c.req.param("id");
  const found = await row(c, id);
  if (!found) return c.json({ error: "not found" }, 404);
  if (found.user_id !== caller.who.id) return c.json({ error: "forbidden" }, 403);
  const comment = c.req.param("comment");
  if (!/^[1-9][0-9]{0,14}$/.test(comment)) return c.json({ error: "not found" }, 404);
  const gone = await c.env.DB.prepare("DELETE FROM take_comments WHERE take_id = ? AND id = ?").bind(id, Number(comment)).run();
  return gone.meta.changes ? c.body(null, 204) : c.json({ error: "not found" }, 404);
});

/** The one byte range `header` asks of `size` bytes: null for the whole (no header, a
 * malformed one or several ranges), "unsatisfiable" for a range past the end. */
export function byteRange(header: string | undefined, size: number): { offset: number; length: number } | null | "unsatisfiable" {
  const m = header ? /^bytes=(\d*)-(\d*)$/i.exec(header.trim()) : null;
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const first = Number(m[1]);
  if (first >= size) return "unsatisfiable";
  const last = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (last < first) return null;
  return { offset: first, length: last - first + 1 };
}

// A take's audio, to whoever holds its id, a range of it when asked (for seeking).
takes.get("/:id/audio", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const id = c.req.param("id");
  const found = await row(c, id);
  if (!found) return c.json({ error: "not found" }, 404);
  const size = found.bytes;
  const headers = new Headers({
    "Content-Type": "audio/wav",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  });
  const range = byteRange(c.req.header("Range"), size);
  if (range === "unsatisfiable") {
    headers.set("Cache-Control", "private, no-store");
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const object = await c.env.TAKES.get(audioKey(id), range ? { range } : {});
  if (!object) return c.json({ error: "not found" }, 404);
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(size));
  return new Response(object.body, { headers });
});

export default takes;
