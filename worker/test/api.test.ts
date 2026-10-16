import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";

const get = (path: string, headers?: HeadersInit, bindings: Env = env) =>
  app.request(path, { headers }, bindings);

describe("api", () => {
  it("reports health", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: expect.any(String) });
  });

  it("lists chants without their GABC", async () => {
    const res = await get("/api/chants");
    expect(res.status).toBe(200);
    const rows = await res.json<{ slug: string; gabc?: string }[]>();
    expect(rows.map((r) => r.slug)).toEqual(["crux-fidelis", "ubi-caritas"]);
    expect(rows[0]).not.toHaveProperty("gabc");
  });

  it("returns one chant with its GABC", async () => {
    const res = await get("/api/chants/ubi-caritas");
    expect(res.status).toBe(200);
    const row = await res.json<{ slug: string; mode: string; gabc: string }>();
    expect(row.slug).toBe("ubi-caritas");
    expect(row.mode).toBe("6");
    expect(row.gabc).toContain("%%");
    expect((await get("/api/chants/missing")).status).toBe(404);
  });

  it("serves a psalm's booklet pointing, its halves included, to a known caller", async () => {
    const res = await get("/api/pointing/116", { "X-Dev-User": "student" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual([
      {
        id: "test/1",
        label: "viii.1",
        tone: "8.G",
        nearest: "8.G",
        match: "exact",
        section: "Test",
        verses: [{ n: 1, pointed: "I am well · pléased * that the Lord hath · héard" }],
      },
    ]);
    expect(await (await get("/api/pointing/1", { "X-Dev-User": "student" })).json()).toEqual([]);
    expect((await get("/api/pointing/x", { "X-Dev-User": "student" })).status).toBe(404);
  });

  it("keeps the booklets' pointing from strangers", async () => {
    expect((await get("/api/pointing/116")).status).toBe(401);
  });

  it("names the dev user from the header", async () => {
    const res = await get("/api/me", { "X-Dev-User": "student" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "student", email: null });
  });

  it("rejects a request without identity", async () => {
    expect((await get("/api/me")).status).toBe(401);
  });

  it("reads the Access token's payload outside dev", async () => {
    const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const jwt = `${b64url('{"alg":"RS256"}')}.${b64url('{"sub":"abc","email":"student@example.com"}')}.sig`;
    const prod = { ...env, ENV: "prod" };
    const res = await get("/api/me", { "Cf-Access-Jwt-Assertion": jwt }, prod);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc", email: "student@example.com" });
    expect((await get("/api/me", { "X-Dev-User": "student" }, prod)).status).toBe(401);
  });
});
