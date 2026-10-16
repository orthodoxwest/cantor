// Reports from /diagnostics: what a browser said of its microphone and speaker, and what the
// page measured, sent by a visitor who chose to. Anyone may send one; nothing names them, and
// nothing reads them back but the database's owner.
import { Hono } from "hono";
import { bounded } from "./takes";

const diagnostics = new Hono<{ Bindings: Env }>();

/** The largest report accepted, as JSON. */
const MAX_BODY = 16 * 1024;
/** At most this many rows a report, this long a label and a value. */
const MAX_ROWS = 40;
const MAX_LABEL = 60;
const MAX_VALUE = 600;
/** Reports kept at most; past this, more are refused rather than filling the database. */
export const MAX_REPORTS = 10_000;

const text = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;

/** The report's rows, as [label, value] pairs; null if it is not one. */
export function rowsOf(sent: unknown): Array<[string, string]> | null {
  const rows = (sent as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) return null;
  const out: Array<[string, string]> = [];
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || !text(row[0], MAX_LABEL) || !text(row[1], MAX_VALUE) || !row[0]) return null;
    out.push([row[0], row[1]]);
  }
  return out;
}

diagnostics.post("/", async (c) => {
  c.header("Cache-Control", "no-store");
  // Sent only by the page itself, so another site cannot fill the table through its visitors.
  if (c.req.header("Origin") !== new URL(c.req.url).origin) return c.json({ error: "forbidden" }, 403);
  const raw = await bounded(c.req.raw, MAX_BODY);
  if (!raw) return c.json({ error: "too large" }, 413);
  const rows = rowsOf(
    await raw
      .text()
      .then((t) => JSON.parse(t) as unknown)
      .catch(() => null),
  );
  if (!rows) return c.json({ error: "not a report" }, 400);
  const agent = (c.req.header("User-Agent") ?? "").slice(0, 512);
  const { meta } = await c.env.DB.prepare(
    "INSERT INTO diagnostics (user_agent, report) SELECT ?1, ?2 WHERE (SELECT count(*) FROM diagnostics) < ?3",
  )
    .bind(agent, JSON.stringify(rows), MAX_REPORTS)
    .run();
  if (!meta.changes) return c.json({ error: "no more reports are being kept" }, 503);
  return c.json({ ok: true }, 201);
});

export default diagnostics;
