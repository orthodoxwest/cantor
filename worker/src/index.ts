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

app.get("/api/me", (c) => {
  const user = identity(c.req.raw.headers, c.env.ENV);
  return user ? c.json(user) : c.json({ error: "unauthorized" }, 401);
});

export default app;
