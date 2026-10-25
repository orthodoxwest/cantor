import { type Context, Hono } from "hono";
import pkg from "../package.json";
import diagnostics from "./diagnostics";
import { identity } from "./identity";
import { nameFrom } from "./people";
import takes, { bounded } from "./takes";

interface ChantRow {
  slug: string;
  title: string;
  name: string | null;
  mode: string | null;
  kind: string | null;
  book: string | null;
  source: string | null;
  url: string | null;
  words: string | null;
  /** Approved for use in the AWRV: 1, 0, or NULL while not yet reviewed. */
  awrv: number | null;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true, version: pkg.version }));

const CHANT = "slug, title, name, mode, kind, book, source, url, words, awrv";

// The library: every public chant, and to a known caller the private ones too (booklet-derived,
// like the pointings). A list that depends on the caller is never cached for others.
app.get("/api/chants", async (c) => {
  const known = (await identity(c.req.raw.headers, c.env)) !== null;
  const from = known ? `chants UNION ALL SELECT ${CHANT} FROM private_chants` : "chants";
  const { results } = await c.env.DB.prepare(`SELECT ${CHANT} FROM ${from} ORDER BY title COLLATE NOCASE, slug`).all<ChantRow>();
  c.header("Cache-Control", known ? "private, no-store" : "public, max-age=300");
  c.header("Vary", "Cookie, Cf-Access-Jwt-Assertion");
  return c.json(results);
});

/** Where a private chant's aligned recording is kept as sound, put there with its ribbon by the
 * private content's seeding: FLAC, at the times its ribbon's bands are measured from. */
const recordingKey = (slug: string) => `recordings/${slug}.flac`;

/** A private chant's aligned recording, as stored, as its ribbon's bands: none when it is not a
 * list of them, and the chant is then served without it. */
function bandsOf(recording: string | null): unknown[] | null {
  try {
    const parsed = recording === null ? null : (JSON.parse(recording) as unknown);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Where a chant rendered in a voice made from a cantor's is kept as sound, put there with its
 * row of `renderings` by the private content's voice scripts: FLAC, named for the GABC it was
 * sung from by its SHA-256, so that the sound of one GABC is never heard as another's. */
const renderingKey = (slug: string, how: RenderingRow) => `renderings/${slug}/${how.gabc_sha256}.flac`;

interface RenderingRow {
  gabc_sha256: string;
  pulse: number;
  transpose: number;
  zero: number;
}

/** The SHA-256 of `text` as UTF-8, in hex. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** How the chant `gabc` was rendered, where it was rendered from that very GABC: one rendered
 * before the chant was corrected is not of it. A store that fails to answer is as none. */
async function renderingOf(env: Env, slug: string, gabc: string): Promise<RenderingRow | null> {
  const row = await env.DB.prepare("SELECT gabc_sha256, pulse, transpose, zero FROM renderings WHERE slug = ?")
    .bind(slug)
    .first<RenderingRow>()
    .catch(() => null);
  return row && row.gabc_sha256 === (await sha256(gabc)) ? row : null;
}

/** The chant's rendering as the page hears it, once its sound is kept: where to hear it from,
 * named for the sound as kept, and how it was sung. Nothing without its sound, or a store that
 * fails to answer. */
async function rendered(env: Env, slug: string, how: RenderingRow | null): Promise<{ rendering?: object }> {
  const sound = how && (await env.TAKES.head(renderingKey(slug, how)).catch(() => null));
  if (!how || !sound) return {};
  const audio = `/api/chants/${encodeURIComponent(slug)}/rendering?v=${encodeURIComponent(sound.etag)}`;
  return { rendering: { audio, pulse: how.pulse, transpose: how.transpose, zero: how.zero } };
}

// One chant with its GABC; a private one is not found by a stranger, and comes with its aligned
// recording's ribbon when it has one, and where the recording's sound is kept, where to hear it:
// named for the sound as kept, so that a sound put again is not heard from a copy of the last. A
// chant rendered in a cantor's voice comes with its rendering, to a known caller only.
app.get("/api/chants/:slug", async (c) => {
  const slug = c.req.param("slug");
  c.header("Vary", "Cookie, Cf-Access-Jwt-Assertion");
  const row = await c.env.DB.prepare(`SELECT ${CHANT}, gabc FROM chants WHERE slug = ?`)
    .bind(slug)
    .first<ChantRow & { gabc: string }>();
  if (row) {
    // The same for every caller but its rendering: who asks is looked up only where it has one.
    const how = await renderingOf(c.env, slug, row.gabc);
    const sung = how && (await identity(c.req.raw.headers, c.env)) ? await rendered(c.env, slug, how) : {};
    c.header("Cache-Control", sung.rendering ? "private, no-store" : "public, max-age=300");
    return c.json({ ...row, ...sung });
  }
  // From here the answer depends on who asks, found or not.
  c.header("Cache-Control", "private, no-store");
  const hidden = (await identity(c.req.raw.headers, c.env))
    ? await c.env.DB.prepare(`SELECT ${CHANT}, gabc, recording FROM private_chants WHERE slug = ?`)
        .bind(slug)
        .first<ChantRow & { gabc: string; recording: string | null }>()
    : null;
  if (!hidden) return c.json({ error: "not found" }, 404);
  const { recording, ...chant } = hidden;
  const sung = await rendered(c.env, slug, await renderingOf(c.env, slug, chant.gabc));
  const bands = bandsOf(recording);
  if (!bands) return c.json({ ...chant, ...sung });
  // Without its sound the ribbon is still drawn; a store that fails to answer is as without it.
  const sound = await c.env.TAKES.head(recordingKey(slug)).catch(() => null);
  const audio = sound && `/api/chants/${encodeURIComponent(slug)}/recording?v=${encodeURIComponent(sound.etag)}`;
  return c.json({ ...chant, recording: bands, ...(audio ? { audio } : {}), ...sung });
});

/** The sound kept at `key`, where the caller may hear one (`key` null where they may not), to the
 * page's own fetch only: another site's cannot tell a sound from none. A page that names the sound
 * by one no longer kept (`v`) has none, rather than another it would time as the last. A copy the
 * caller has of it unchanged is kept; whether it is the sound as kept is all that is asked of the
 * store, and one it cannot read is as none. */
async function soundAt(c: Context<{ Bindings: Env }>, key: string | null): Promise<Response> {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie, Cf-Access-Jwt-Assertion");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  const copy = c.req.header("If-None-Match");
  const object = key
    ? await (copy ? c.env.TAKES.get(key, { onlyIf: new Headers({ "If-None-Match": copy }) }).catch(() => c.env.TAKES.get(key)) : c.env.TAKES.get(key))
    : null;
  const named = c.req.query("v");
  if (!object || (named !== undefined && named !== object.etag)) return c.json({ error: "not found" }, 404);
  const headers = {
    ETag: object.httpEtag,
    "Cache-Control": "private, max-age=3600",
    Vary: "Cookie, Cf-Access-Jwt-Assertion",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
  };
  // Without a body, the copy the caller has is the sound as kept.
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  return new Response((object as R2ObjectBody).body, { headers: { ...headers, "Content-Type": "audio/flac", "Content-Length": String(object.size) } });
}

// A private chant's aligned recording as sound, to a known caller, where its chant is served with
// its ribbon (so not under a public chant of the same slug).
app.get("/api/chants/:slug/recording", async (c) => {
  const slug = c.req.param("slug");
  const known = await identity(c.req.raw.headers, c.env);
  const shadowed = known && (await c.env.DB.prepare("SELECT 1 AS found FROM chants WHERE slug = ?").bind(slug).first());
  const row =
    known && !shadowed
      ? await c.env.DB.prepare("SELECT recording FROM private_chants WHERE slug = ?").bind(slug).first<{ recording: string | null }>()
      : null;
  return soundAt(c, row && bandsOf(row.recording) ? recordingKey(slug) : null);
});

// A chant's rendering as sound, to a known caller, where its chant is served with it: rendered
// from the GABC of the chant served by its slug, public or else private.
app.get("/api/chants/:slug/rendering", async (c) => {
  const slug = c.req.param("slug");
  const known = await identity(c.req.raw.headers, c.env);
  const gabcOf = (table: string) => c.env.DB.prepare(`SELECT gabc FROM ${table} WHERE slug = ?`).bind(slug).first<{ gabc: string }>();
  const chant = known ? ((await gabcOf("chants")) ?? (await gabcOf("private_chants"))) : null;
  const how = chant && (await renderingOf(c.env, slug, chant.gabc));
  return soundAt(c, how ? renderingKey(slug, how) : null);
});

interface PointingRow {
  id: string;
  label: string;
  tone: string | null;
  nearest: string | null;
  match: string;
  section: string | null;
  verses: string;
}

// The booklets' pointing of a psalm (by Hebrew number), for those the identity check lets in.
app.get("/api/pointing/:psalm", async (c) => {
  if (!(await identity(c.req.raw.headers, c.env))) return c.json({ error: "unauthorized" }, 401);
  const psalm = c.req.param("psalm");
  if (!/^\d{1,3}$/.test(psalm)) return c.json({ error: "not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT id, label, tone, nearest, match, section, verses FROM pointings WHERE psalm = ?1 OR psalm GLOB ?1 || '[a-z]' ORDER BY id",
  )
    .bind(psalm)
    .all<PointingRow>();
  c.header("Cache-Control", "private, no-store");
  return c.json(results.map((r) => ({ ...r, verses: JSON.parse(r.verses) as unknown })));
});

app.get("/api/me", async (c) => {
  const user = await identity(c.req.raw.headers, c.env);
  c.header("Cache-Control", "private, no-store");
  if (!user) return c.json({ error: "unauthorized" }, 401);
  // Who is signed in does not wait on their name: without it they are still signed in.
  const named = await c.env.DB.prepare("SELECT name FROM people WHERE user_id = ?")
    .bind(user.id)
    .first<{ name: string }>()
    .catch(() => null);
  return c.json({ ...user, name: named?.name ?? null });
});

// The name a signed-in person gives, shown beside the comments they write from now on; empty
// forgets it.
app.put("/api/me", async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("Origin") !== new URL(c.req.url).origin) return c.json({ error: "forbidden" }, 403);
  const user = await identity(c.req.raw.headers, c.env);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const raw = await bounded(c.req.raw, 4096);
  if (!raw) return c.json({ error: "too large" }, 413);
  const sent = await raw
    .text()
    .then((text) => JSON.parse(text) as { name?: unknown } | null)
    .catch(() => null);
  const name = nameFrom(sent?.name);
  if (name === null) return c.json({ error: "that name cannot be used" }, 400);
  if (!name) await c.env.DB.prepare("DELETE FROM people WHERE user_id = ?").bind(user.id).run();
  else
    await c.env.DB.prepare(
      "INSERT INTO people (user_id, name) VALUES (?1, ?2) ON CONFLICT (user_id) DO UPDATE SET name = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    )
      .bind(user.id, name)
      .run();
  return c.json({ ...user, name: name || null });
});

// Signing in: Access covers this path, so reaching it means the visitor has signed in; it sends
// them back to the page they came from, which must be a path on this site.
app.get("/signin", (c) => {
  const next = c.req.query("next") ?? "";
  c.header("Cache-Control", "no-store");
  return c.redirect(/^\/(?!\/)[^\\\x00-\x20]*$/.test(next) ? next : "/", 302);
});

app.route("/api/takes", takes);
app.route("/api/diagnostics", diagnostics);

// The page a take's link opens. The id is in the path, so the page is never cached by others
// and gives no referrer to anything it links to; the page reads the take from /api/takes.
app.get("/take/:id", async (c) => {
  const page = await c.env.ASSETS.fetch(new URL("/take", c.req.url));
  const res = new Response(page.body, page);
  res.headers.set("Cache-Control", "private, no-cache");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Robots-Tag", "noindex");
  res.headers.set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
  return res;
});
app.get("/take/:id/", (c) => c.redirect(`/take/${encodeURIComponent(c.req.param("id"))}`, 301));

export default app;
