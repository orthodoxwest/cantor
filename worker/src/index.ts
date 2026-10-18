import { Hono } from "hono";
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
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true, version: pkg.version }));

const CHANT = "slug, title, name, mode, kind, book, source, url, words";

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

// One chant with its GABC; a private one is not found by a stranger, and comes with its aligned
// recording's ribbon when it has one, and where the recording's sound is kept, where to hear it.
app.get("/api/chants/:slug", async (c) => {
  const slug = c.req.param("slug");
  const row = await c.env.DB.prepare(`SELECT ${CHANT}, gabc FROM chants WHERE slug = ?`)
    .bind(slug)
    .first<ChantRow & { gabc: string }>();
  if (row) {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(row);
  }
  // From here the answer depends on who asks, found or not.
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie, Cf-Access-Jwt-Assertion");
  const hidden = (await identity(c.req.raw.headers, c.env))
    ? await c.env.DB.prepare(`SELECT ${CHANT}, gabc, recording FROM private_chants WHERE slug = ?`)
        .bind(slug)
        .first<ChantRow & { gabc: string; recording: string | null }>()
    : null;
  if (!hidden) return c.json({ error: "not found" }, 404);
  const { recording, ...chant } = hidden;
  // A recording that is not a list of bands is left out, and the chant still served.
  const parsed = (() => {
    try {
      return recording === null ? null : (JSON.parse(recording) as unknown);
    } catch {
      return null;
    }
  })();
  if (!Array.isArray(parsed)) return c.json(chant);
  // Without its sound the ribbon is still drawn; a store that fails to answer is as without it.
  const sound = await c.env.TAKES.head(recordingKey(slug)).catch(() => null);
  return c.json({ ...chant, recording: parsed, ...(sound ? { audio: `/api/chants/${encodeURIComponent(slug)}/recording` } : {}) });
});

// A private chant's aligned recording as sound, to a known caller, for a chant served with its
// ribbon.
app.get("/api/chants/:slug/recording", async (c) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Cookie, Cf-Access-Jwt-Assertion");
  const slug = c.req.param("slug");
  const row = (await identity(c.req.raw.headers, c.env))
    ? await c.env.DB.prepare("SELECT 1 AS found FROM private_chants WHERE slug = ? AND recording IS NOT NULL").bind(slug).first<{ found: number }>()
    : null;
  const object = row && (await c.env.TAKES.get(recordingKey(slug)));
  if (!object) return c.json({ error: "not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "audio/flac",
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
      "Cache-Control": "private, max-age=3600",
      Vary: "Cookie, Cf-Access-Jwt-Assertion",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
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
