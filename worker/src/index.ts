import { Hono } from "hono";
import pkg from "../package.json";
import { identity } from "./identity";

interface ChantRow {
  id: number;
  slug: string;
  title: string;
  mode: string | null;
  source: string | null;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true, version: pkg.version }));

app.get("/api/chants", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, slug, title, mode, source FROM chants ORDER BY title",
  ).all<ChantRow>();
  return c.json(results);
});

app.get("/api/chants/:slug", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, slug, title, mode, source, gabc FROM chants WHERE slug = ?",
  )
    .bind(c.req.param("slug"))
    .first<ChantRow & { gabc: string }>();
  return row ? c.json(row) : c.json({ error: "not found" }, 404);
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
