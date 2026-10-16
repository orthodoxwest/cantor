import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    expect(rows[0]).toMatchObject({ title: "Faithful Cross", name: "Crux fidelis", kind: "hymn", words: "Faithful Cross" });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("Vary")).toBe("Cookie, Cf-Access-Jwt-Assertion");
  });

  it("lists the private chants only to a known caller", async () => {
    const res = await get("/api/chants", { "X-Dev-User": "student" });
    expect((await res.json<{ slug: string }[]>()).map((r) => r.slug)).toEqual(["private-test", "crux-fidelis", "ubi-caritas"]);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("finds a private chant for a known caller and for nobody else", async () => {
    expect((await get("/api/chants/private-test")).status).toBe(404);
    const res = await get("/api/chants/private-test", { "X-Dev-User": "student" });
    expect(res.status).toBe(200);
    const row = await res.json<{ slug: string; gabc: string }>();
    expect(row.gabc).toContain("BOok");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
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

  describe("outside dev", () => {
    const TEAM = "https://example.cloudflareaccess.com";
    const AUD = "test-aud";
    const prod = { ...env, ENV: "prod", ACCESS_TEAM: TEAM, ACCESS_AUD: AUD };
    const b64url = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const text = (s: string) => b64url(new TextEncoder().encode(s));
    let pair: CryptoKeyPair;
    const now = () => Math.floor(Date.now() / 1000);

    async function token(claims: Record<string, unknown>, key = pair.privateKey, kid = "k1"): Promise<string> {
      const head = `${text(JSON.stringify({ alg: "RS256", kid }))}.${text(JSON.stringify(claims))}`;
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head));
      return `${head}.${b64url(new Uint8Array(sig))}`;
    }
    const good = () => ({ iss: TEAM, aud: [AUD], sub: "abc", email: "student@example.com", exp: now() + 60 });

    beforeAll(async () => {
      pair = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
        String(input) === `${TEAM}/cdn-cgi/access/certs`
          ? Response.json({ keys: [{ ...jwk, kid: "k1" }] })
          : new Response(null, { status: 404 }),
      );
    });
    afterAll(() => vi.restoreAllMocks());

    it("names the caller from a verified Access token", async () => {
      const jwt = await token(good());
      const res = await get("/api/me", { "Cf-Access-Jwt-Assertion": jwt }, prod);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "abc", email: "student@example.com" });
      expect((await get("/api/pointing/116", { "Cf-Access-Jwt-Assertion": jwt }, prod)).status).toBe(200);
    });

    it("names the caller from the Access cookie where no header is added", async () => {
      const jwt = await token(good());
      const res = await get("/api/me", { Cookie: `theme=dark; CF_Authorization=${jwt}` }, prod);
      expect(await res.json()).toEqual({ id: "abc", email: "student@example.com" });
      const list = await get("/api/chants", { Cookie: `CF_Authorization=${jwt}` }, prod);
      expect((await list.json<{ slug: string }[]>()).map((r) => r.slug)).toContain("private-test");
      expect((await get("/api/chants/private-test", { Cookie: `CF_Authorization=${jwt}` }, prod)).status).toBe(200);
      const forged = await token(good(), (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        false,
        ["sign"],
      ) as CryptoKeyPair).privateKey);
      for (const Cookie of [`CF_Authorization=${forged}`, `CF_Authorization=${await token({ ...good(), exp: now() - 1 })}`, `XCF_Authorization=${jwt}`, "CF_Authorization="]) {
        expect((await get("/api/me", { Cookie }, prod)).status).toBe(401);
        expect((await get("/api/chants/private-test", { Cookie }, prod)).status).toBe(404);
      }
    });

    it("takes a single audience as well as a list", async () => {
      const jwt = await token({ ...good(), aud: AUD });
      expect((await get("/api/me", { "Cf-Access-Jwt-Assertion": jwt }, prod)).status).toBe(200);
    });

    it("lets in no forged, foreign, expired or dev-header caller", async () => {
      const other = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        false,
        ["sign"],
      )) as CryptoKeyPair;
      const unsigned = `${text('{"alg":"RS256","kid":"k1"}')}.${text(JSON.stringify(good()))}.sig`;
      const rejected = [
        unsigned,
        await token(good(), other.privateKey),
        await token(good(), pair.privateKey, "unknown"),
        await token({ ...good(), aud: ["another-app"] }),
        await token({ ...good(), iss: "https://another.cloudflareaccess.com" }),
        await token({ ...good(), exp: now() - 1 }),
        await token({ ...good(), sub: "" }),
      ];
      for (const jwt of rejected) {
        expect((await get("/api/pointing/116", { "Cf-Access-Jwt-Assertion": jwt }, prod)).status).toBe(401);
        expect((await get("/api/me", { "Cf-Access-Jwt-Assertion": jwt }, prod)).status).toBe(401);
      }
      const none = `${text('{"alg":"none","kid":"k1"}')}.${text(JSON.stringify(good()))}.`;
      expect((await get("/api/me", { "Cf-Access-Jwt-Assertion": none }, prod)).status).toBe(401);
      expect((await get("/api/me", { "Cf-Access-Jwt-Assertion": "not.a!.token" }, prod)).status).toBe(401);
      expect((await get("/api/me", { "Cf-Access-Jwt-Assertion": await token({ ...good(), nbf: now() + 60 }) }, prod)).status).toBe(401);
      expect((await get("/api/pointing/116", { "X-Dev-User": "student" }, prod)).status).toBe(401);
      // Nor does a bad token or a dev header reveal a private chant.
      for (const headers of [{ "X-Dev-User": "student" }, { "Cf-Access-Jwt-Assertion": rejected[0]! }] as Record<string, string>[]) {
        expect((await (await get("/api/chants", headers, prod)).json<{ slug: string }[]>()).map((r) => r.slug)).not.toContain("private-test");
        expect((await get("/api/chants/private-test", headers, prod)).status).toBe(404);
      }
      // Without the team and audience configured, nobody is signed in.
      const unset = { ...env, ENV: "prod", ACCESS_TEAM: "", ACCESS_AUD: "" };
      expect((await get("/api/me", { "Cf-Access-Jwt-Assertion": await token(good()) }, unset)).status).toBe(401);
    });
  });
});
