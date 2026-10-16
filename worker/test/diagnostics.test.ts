import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";

const ORIGIN = "http://localhost";
const ROWS = [
  ["Browser", "Safari 18 on iOS 18.1"],
  ["Round trip", "182 ms"],
];

const post = (body: string, headers: Record<string, string> = { Origin: ORIGIN }) =>
  app.request("/api/diagnostics", { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } }, env);

describe("diagnostics", () => {
  it("keeps a report with the browser's user agent and nothing else about who sent it", async () => {
    const res = await post(JSON.stringify({ rows: ROWS }), { Origin: ORIGIN, "User-Agent": "TestAgent/1.0", "X-Dev-User": "singer" });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT * FROM diagnostics ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>();
    expect(row).toMatchObject({ user_agent: "TestAgent/1.0", report: JSON.stringify(ROWS) });
    expect(Object.keys(row!).sort()).toEqual(["created_at", "id", "report", "user_agent"]);
  });

  it("refuses a report from another site, one too large, and one that is not a table", async () => {
    expect((await post(JSON.stringify({ rows: ROWS }), { Origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post(JSON.stringify({ rows: ROWS }), {})).status).toBe(403);
    expect((await post(JSON.stringify({ rows: [["x", "y".repeat(20_000)]] }))).status).toBe(413);
    for (const body of ["nope", "{}", JSON.stringify({ rows: [] }), JSON.stringify({ rows: [["a", 1]] }), JSON.stringify({ rows: [["", "b"]] }), JSON.stringify({ rows: Array(41).fill(["a", "b"]) })])
      expect((await post(body)).status, body).toBe(400);
  });
});
