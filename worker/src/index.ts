import { Hono } from "hono";
import pkg from "../package.json";
import { identity } from "./identity";

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
  const { results } = await c.env.DB.prepare(
    `SELECT ${CHANT} FROM chants WHERE private = 0 OR ?1 ORDER BY title COLLATE NOCASE, slug`,
  )
    .bind(known ? 1 : 0)
    .all<ChantRow>();
  c.header("Cache-Control", known ? "private, no-store" : "public, max-age=300");
  c.header("Vary", "Cookie, Cf-Access-Jwt-Assertion");
  return c.json(results);
});

// One chant with its GABC; a private one is not found by a stranger.
app.get("/api/chants/:slug", async (c) => {
  const row = await c.env.DB.prepare(`SELECT ${CHANT}, private, gabc FROM chants WHERE slug = ?`)
    .bind(c.req.param("slug"))
    .first<ChantRow & { private: number; gabc: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const isPrivate = row.private !== 0;
  if (isPrivate && !(await identity(c.req.raw.headers, c.env))) return c.json({ error: "not found" }, 404);
  c.header("Cache-Control", isPrivate ? "private, no-store" : "public, max-age=300");
  const { private: _, ...chant } = row;
  return c.json(chant);
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
  return user ? c.json(user) : c.json({ error: "unauthorized" }, 401);
});

export default app;
