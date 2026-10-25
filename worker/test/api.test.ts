import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { identity } from "../src/identity";
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
    expect(rows[0]).toMatchObject({ title: "Faithful Cross", name: "Crux fidelis", kind: "hymn", words: "Faithful Cross", awrv: 1 });
    expect(rows[1]).toMatchObject({ slug: "ubi-caritas", awrv: null });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("Vary")).toBe("Cookie, Cf-Access-Jwt-Assertion");
  });

  it("lists the private chants only to a known caller", async () => {
    const res = await get("/api/chants", { "X-Dev-User": "student" });
    const rows = await res.json<{ slug: string; awrv: number | null }[]>();
    expect(rows.map((r) => r.slug)).toEqual(["private-test", "crux-fidelis", "private-sung", "ubi-caritas"]);
    expect(rows.map((r) => r.awrv)).toEqual([0, 1, null, null]);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("finds a private chant for a known caller and for nobody else", async () => {
    const hidden = await get("/api/chants/private-test");
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get("Cache-Control")).toBe("private, no-store");
    const res = await get("/api/chants/private-test", { "X-Dev-User": "student" });
    expect(res.status).toBe(200);
    const row = await res.json<{ slug: string; gabc: string }>();
    expect(row.gabc).toContain("BOok");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("gives a private chant's recording with it, to a known caller only", async () => {
    expect((await get("/api/chants/private-sung")).status).toBe(404);
    const sung = await (await get("/api/chants/private-sung", { "X-Dev-User": "student" })).json<{ recording: unknown }>();
    expect(sung.recording).toEqual([{ index: 0, from_s: 1.05, to_s: 1.5, cents: -12.5, trace: [[1.1, -10], [1.2, -14]] }]);
    const plain = await (await get("/api/chants/private-test", { "X-Dev-User": "student" })).json<object>();
    expect(plain).not.toHaveProperty("recording");
    expect(await (await get("/api/chants/ubi-caritas")).json<object>()).not.toHaveProperty("recording");
    for (const bad of ["{not json", '{"index":0}']) {
      await env.DB.prepare("UPDATE private_chants SET recording = ? WHERE slug = 'private-test'").bind(bad).run();
      const res = await get("/api/chants/private-test", { "X-Dev-User": "student" });
      expect(res.status).toBe(200);
      expect(await res.json<object>()).not.toHaveProperty("recording");
    }
    await env.DB.prepare("UPDATE private_chants SET recording = NULL WHERE slug = 'private-test'").run();
  });

  it("says where to hear a private chant's recording once its sound is kept, and gives it to a known caller only", async () => {
    const student = { "X-Dev-User": "student" };
    const served = async (slug: string) => (await get(`/api/chants/${slug}`, student)).json<{ audio?: string }>();
    expect(await served("private-sung")).not.toHaveProperty("audio");
    expect((await get("/api/chants/private-sung/recording", student)).status).toBe(404);
    const sound = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 1, 2, 3]);
    const kept = await env.TAKES.put("recordings/private-sung.flac", sound);
    // A chant with no recording is not heard by its sound alone, nor a public one.
    await env.TAKES.put("recordings/private-test.flac", sound);
    await env.TAKES.put("recordings/ubi-caritas.flac", sound);
    try {
      // Named for the sound as kept.
      expect((await served("private-sung")).audio).toBe(`/api/chants/private-sung/recording?v=${kept!.etag}`);
      expect(await served("private-test")).not.toHaveProperty("audio");
      expect(await (await get("/api/chants/ubi-caritas")).json<object>()).not.toHaveProperty("audio");
      const res = await get("/api/chants/private-sung/recording", student);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(sound);
      expect(res.headers.get("Content-Type")).toBe("audio/flac");
      expect(res.headers.get("Content-Length")).toBe(String(sound.length));
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
      expect(res.headers.get("Vary")).toBe("Cookie, Cf-Access-Jwt-Assertion");
      expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      // A copy the caller has of it, unchanged, is kept, and none sent again.
      const etag = res.headers.get("ETag")!;
      const again = await get("/api/chants/private-sung/recording", { ...student, "If-None-Match": etag });
      expect(again.status).toBe(304);
      expect(await again.arrayBuffer()).toHaveProperty("byteLength", 0);
      expect(again.headers.get("ETag")).toBe(etag);
      // Asked only that: other conditions, or a copy not named as the store names one, get it all.
      const conditions: Record<string, string>[] = [{ "If-Match": '"other"' }, { "If-Unmodified-Since": "Mon, 01 Jan 2001 00:00:00 GMT" }, { "If-None-Match": "unquoted" }];
      for (const condition of conditions) {
        const whole = await get("/api/chants/private-sung/recording", { ...student, ...condition });
        expect(whole.status, JSON.stringify(condition)).toBe(200);
        expect(new Uint8Array(await whole.arrayBuffer())).toEqual(sound);
      }
      // A stranger is turned away before anything is looked up.
      const calls: string[] = [];
      const counted = <T extends object>(name: string, target: T): T =>
        new Proxy(target, {
          get(t, prop) {
            const value = Reflect.get(t, prop) as unknown;
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              calls.push(`${name}.${String(prop)}`);
              return (value as (...a: unknown[]) => unknown).apply(t, args);
            };
          },
        });
      const watched = { ...env, DB: counted("DB", env.DB), TAKES: counted("TAKES", env.TAKES) } as Env;
      expect((await get("/api/chants/private-sung/recording", undefined, watched)).status).toBe(404);
      expect(calls).toEqual([]);
      expect((await get("/api/chants/private-sung/recording", student, watched)).status).toBe(200);
      expect(calls).toContain("TAKES.get");
      for (const [path, headers] of [
        ["/api/chants/private-sung/recording", undefined],
        ["/api/chants/private-test/recording", student],
        ["/api/chants/ubi-caritas/recording", student],
        ["/api/chants/missing/recording", student],
      ] as const) {
        const hidden = await get(path, headers);
        expect(hidden.status, path).toBe(404);
        expect(hidden.headers.get("Cache-Control")).toBe("private, no-store");
        expect(hidden.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      }
      // Heard only where its chant is served with its ribbon: not with a ribbon that is not one,
      // nor under a public chant of the same slug, which is the one served.
      await env.DB.prepare("UPDATE private_chants SET recording = ? WHERE slug = 'private-test'").bind('{"index":0}').run();
      expect((await get("/api/chants/private-test/recording", student)).status).toBe(404);
      await env.DB.prepare("UPDATE private_chants SET recording = (SELECT recording FROM private_chants WHERE slug = 'private-sung') WHERE slug = 'private-test'").run();
      expect((await get("/api/chants/private-test/recording", student)).status).toBe(200);
      await env.DB.prepare("INSERT INTO chants (slug, title, gabc) VALUES ('private-test', 'Shadow', '(c4) A(f) (::)')").run();
      expect(await served("private-test")).not.toHaveProperty("audio");
      expect((await get("/api/chants/private-test/recording", student)).status).toBe(404);
    } finally {
      await env.DB.prepare("DELETE FROM chants WHERE slug = 'private-test'").run();
      await env.DB.prepare("UPDATE private_chants SET recording = NULL WHERE slug = 'private-test'").run();
      await env.TAKES.delete(["recordings/private-sung.flac", "recordings/private-test.flac", "recordings/ubi-caritas.flac"]);
    }
  });

  it("gives a chant rendered in a cantor's voice from its GABC as served, once its sound is kept, to a known caller only", async () => {
    const student = { "X-Dev-User": "student" };
    const sha256 = async (text: string) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const gabcOf = async (table: string, slug: string) => (await env.DB.prepare(`SELECT gabc FROM ${table} WHERE slug = ?`).bind(slug).first<{ gabc: string }>())!.gabc;
    const ubi = await gabcOf("chants", "ubi-caritas");
    const render = async (slug: string, gabc: string) =>
      env.DB.prepare("INSERT INTO renderings (slug, gabc_sha256, pulse, transpose, zero) VALUES (?, ?, 0.5, -3, 0.08)").bind(slug, await sha256(gabc)).run();
    const served = async (slug: string, headers?: HeadersInit, bindings: Env = env) => {
      const res = await get(`/api/chants/${slug}`, headers, bindings);
      return { res, body: await res.json<{ rendering?: { audio: string }; recording?: unknown; gabc: string }>() };
    };
    const sungGabc = await gabcOf("private_chants", "private-sung");
    await render("ubi-caritas", ubi);
    await render("private-sung", sungGabc);
    const sound = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 4, 5, 6]);
    // Kept under the SHA-256 of the GABC it was sung from.
    const keyOf = async (slug: string, gabc: string) => `renderings/${slug}/${await sha256(gabc)}.flac`;
    try {
      // Without its sound, none.
      expect((await served("ubi-caritas", student)).body).not.toHaveProperty("rendering");
      expect((await get("/api/chants/ubi-caritas/rendering", student)).status).toBe(404);
      // A sound kept under the slug alone, or another GABC's, is not this chant's.
      await env.TAKES.put("renderings/ubi-caritas.flac", sound);
      await env.TAKES.put(await keyOf("ubi-caritas", "(c4) A(f) (::)"), sound);
      expect((await served("ubi-caritas", student)).body).not.toHaveProperty("rendering");
      const kept = await env.TAKES.put(await keyOf("ubi-caritas", ubi), sound);
      const keptPrivate = await env.TAKES.put(await keyOf("private-sung", sungGabc), sound);
      // A public chant comes with it to a known caller, named for the sound as kept, and that
      // answer is kept for no one else.
      const known = await served("ubi-caritas", student);
      expect(known.body.rendering).toEqual({ audio: `/api/chants/ubi-caritas/rendering?v=${kept!.etag}`, pulse: 0.5, transpose: -3, zero: 0.08 });
      expect(known.body.gabc).toBe(ubi);
      expect(known.res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(known.res.headers.get("Vary")).toBe("Cookie, Cf-Access-Jwt-Assertion");
      // To a stranger it is the chant as it was, kept for all.
      const stranger = await served("ubi-caritas");
      expect(stranger.body).not.toHaveProperty("rendering");
      expect(stranger.res.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(stranger.res.headers.get("Vary")).toBe("Cookie, Cf-Access-Jwt-Assertion");
      // A private chant comes with it beside its recording.
      const hidden = await served("private-sung", student);
      expect(hidden.body.rendering).toEqual({ audio: `/api/chants/private-sung/rendering?v=${keptPrivate!.etag}`, pulse: 0.5, transpose: -3, zero: 0.08 });
      expect(hidden.body.recording).toHaveLength(1);
      // Its sound, as a recording's is given.
      const res = await get("/api/chants/ubi-caritas/rendering", student);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(sound);
      expect(res.headers.get("Content-Type")).toBe("audio/flac");
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
      expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      const again = await get("/api/chants/ubi-caritas/rendering", { ...student, "If-None-Match": res.headers.get("ETag")! });
      expect(again.status).toBe(304);
      // Asked for by the name the chant gave it, it is heard; by a name no longer kept, a page
      // that would time another sound as the last has none. So too a recording.
      expect((await get(known.body.rendering!.audio, student)).status).toBe(200);
      expect((await get("/api/chants/ubi-caritas/rendering?v=stale", student)).status).toBe(404);
      // As a browser asks again for the copy it has: unchanged, kept; by a stale name, none.
      const etag = res.headers.get("ETag")!;
      expect((await get(known.body.rendering!.audio, { ...student, "If-None-Match": etag })).status).toBe(304);
      expect((await get("/api/chants/ubi-caritas/rendering?v=stale", { ...student, "If-None-Match": etag })).status).toBe(404);
      const recorded = await env.TAKES.put("recordings/private-sung.flac", sound);
      expect((await get(`/api/chants/private-sung/recording?v=${recorded!.etag}`, student)).status).toBe(200);
      expect((await get("/api/chants/private-sung/recording?v=stale", student)).status).toBe(404);
      expect((await get("/api/chants/private-sung/rendering", student)).status).toBe(200);
      // A stranger is turned away before anything is looked up, and has the chant without asking
      // the store of sounds.
      const calls: string[] = [];
      const counted = <T extends object>(name: string, target: T): T =>
        new Proxy(target, {
          get(t, prop) {
            const value = Reflect.get(t, prop) as unknown;
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              calls.push(`${name}.${String(prop)}`);
              return (value as (...a: unknown[]) => unknown).apply(t, args);
            };
          },
        });
      const watched = { ...env, DB: counted("DB", env.DB), TAKES: counted("TAKES", env.TAKES) } as Env;
      expect((await get("/api/chants/ubi-caritas/rendering", undefined, watched)).status).toBe(404);
      expect(calls).toEqual([]);
      expect((await served("ubi-caritas", undefined, watched)).body).not.toHaveProperty("rendering");
      expect(calls.filter((call) => call.startsWith("TAKES"))).toEqual([]);
      for (const [path, headers] of [
        ["/api/chants/ubi-caritas/rendering", undefined],
        ["/api/chants/private-sung/rendering", undefined],
        ["/api/chants/crux-fidelis/rendering", student],
        ["/api/chants/missing/rendering", student],
      ] as const) {
        const none = await get(path, headers);
        expect(none.status, path).toBe(404);
        expect(none.headers.get("Cache-Control")).toBe("private, no-store");
        expect(none.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      }
      // A store of renderings that fails to answer is as none: the chant is still served.
      const broken = {
        ...env,
        DB: new Proxy(env.DB, {
          get(t, prop) {
            const value = Reflect.get(t, prop) as unknown;
            if (prop !== "prepare") return typeof value === "function" ? (value as () => unknown).bind(t) : value;
            return (sql: string) => t.prepare(sql.replace("FROM renderings", "FROM no_such_table"));
          },
        }),
      } as Env;
      const unanswered = await served("ubi-caritas", student, broken);
      expect(unanswered.res.status).toBe(200);
      expect(unanswered.body).not.toHaveProperty("rendering");
      expect((await get("/api/chants/ubi-caritas/rendering", student, broken)).status).toBe(404);
      // A chant corrected since it was rendered is not heard as it was, public or private, nor
      // once its row names the corrected GABC before that GABC's sound is kept.
      const fixed = ubi.replace("(h) (::)", "(g) (::)");
      await env.DB.prepare("UPDATE chants SET gabc = ? WHERE slug = 'ubi-caritas'").bind(fixed).run();
      const corrected = await served("ubi-caritas", student);
      expect(corrected.body).not.toHaveProperty("rendering");
      expect(corrected.res.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect((await get("/api/chants/ubi-caritas/rendering", student)).status).toBe(404);
      await env.DB.prepare("UPDATE renderings SET gabc_sha256 = ? WHERE slug = 'ubi-caritas'").bind(await sha256(fixed)).run();
      expect((await served("ubi-caritas", student)).body).not.toHaveProperty("rendering");
      expect((await get("/api/chants/ubi-caritas/rendering", student)).status).toBe(404);
      await env.DB.prepare("UPDATE private_chants SET gabc = ? WHERE slug = 'private-sung'").bind(sungGabc.replace("(f) (::)", "(g) (::)")).run();
      const privately = await served("private-sung", student);
      expect(privately.body).not.toHaveProperty("rendering");
      expect(privately.body.recording).toHaveLength(1);
      expect((await get("/api/chants/private-sung/rendering", student)).status).toBe(404);
      await env.DB.prepare("UPDATE private_chants SET gabc = ? WHERE slug = 'private-sung'").bind(sungGabc).run();
      expect((await get("/api/chants/private-sung/rendering", student)).status).toBe(200);
      // Under a public chant of the same slug, that chant is the one served, and it was not rendered.
      await env.DB.prepare("INSERT INTO chants (slug, title, gabc) VALUES ('private-sung', 'Shadow', '(c4) A(f) (::)')").run();
      expect((await served("private-sung", student)).body).not.toHaveProperty("rendering");
      expect((await get("/api/chants/private-sung/rendering", student)).status).toBe(404);
    } finally {
      await env.DB.prepare("DELETE FROM chants WHERE slug = 'private-sung'").run();
      await env.DB.prepare("UPDATE chants SET gabc = ? WHERE slug = 'ubi-caritas'").bind(ubi).run();
      await env.DB.prepare("UPDATE private_chants SET gabc = ? WHERE slug = 'private-sung'").bind(sungGabc).run();
      await env.DB.prepare("DELETE FROM renderings").run();
      const { objects } = await env.TAKES.list({ prefix: "renderings/" });
      await env.TAKES.delete([...objects.map((o) => o.key), "recordings/private-sung.flac"]);
    }
  });

  it("sends a visitor who signs in back to a page on this site, and nowhere else", async () => {
    const to = async (next: string) => (await get(`/signin?next=${encodeURIComponent(next)}`)).headers.get("Location");
    expect(await to("/library?q=light#lumen-gentium")).toBe("/library?q=light#lumen-gentium");
    for (const next of ["//evil.example", "/\\evil.example", "https://evil.example/", "/\t/evil.example", "library", ""])
      expect(await to(next)).toBe("/");
    const res = await get("/signin");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
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
    expect(await res.json()).toEqual({ id: "student", email: null, name: null });
  });

  it("rejects a request without identity", async () => {
    expect((await get("/api/me")).status).toBe(401);
  });

  it("keeps the name a signed-in person gives, and forgets it when emptied", async () => {
    const put = (name: unknown, headers: Record<string, string> = {}) =>
      app.request("/api/me", { method: "PUT", body: JSON.stringify({ name }), headers: { Origin: "http://localhost", "X-Dev-User": "director", ...headers } }, env);
    expect(await (await put("  Choir   director ")).json()).toEqual({ id: "director", email: null, name: "Choir director" });
    expect(await (await get("/api/me", { "X-Dev-User": "director" })).json()).toEqual({ id: "director", email: null, name: "Choir director" });
    expect((await put("Someone", { Origin: "https://evil.example" })).status).toBe(403);
    expect((await put("Someone", { "X-Dev-User": "" })).status).toBe(401);
    for (const bad of [3, null, "x".repeat(61), "a\u0000b", "a\u202eb", "a\u200fb", "e\u0301\u0301\u0301\u0301", "You", " the  SINGER! ", "A reader", "Ｙｏｕ", "...", "A-reader", "The_singer", "Y o u", "Yo\u200du", "You\u3164", "\u3164", "You · 3 Oct", "a\u0308\u0301\u0301\u0301"])
      expect([bad, (await put(bad)).status]).toEqual([bad, 400]);
    // Names written with joiners, and in any script, are kept as given.
    for (const good of ["\u0645\u06cc\u200c\u0631\u0632\u0627", "Fr. Ñuño", "Y".repeat(60), "ကျော်ဇော", "ज़िंदगी", "יִשָּׂשכָר", "Nguyễn"]) expect(await (await put(good)).json()).toMatchObject({ name: good });
    expect((await app.request("/api/me", { method: "PUT", body: JSON.stringify({ name: "x".repeat(5000) }), headers: { Origin: "http://localhost", "X-Dev-User": "director" } }, env)).status).toBe(413);
    expect(await (await put("")).json()).toMatchObject({ name: null });
    expect(await (await get("/api/me", { "X-Dev-User": "director" })).json()).toMatchObject({ name: null });
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
      expect(await res.json()).toEqual({ id: "abc", email: "student@example.com", name: null });
      expect((await get("/api/pointing/116", { "Cf-Access-Jwt-Assertion": jwt }, prod)).status).toBe(200);
    });

    it("names the caller from the Access cookie where no header is added", async () => {
      const jwt = await token(good());
      const res = await get("/api/me", { Cookie: `theme=dark; CF_Authorization=${jwt}` }, prod);
      expect(await res.json()).toEqual({ id: "abc", email: "student@example.com", name: null });
      const list = await get("/api/chants", { Cookie: `CF_Authorization=${jwt}` }, prod);
      expect((await list.json<{ slug: string }[]>()).map((r) => r.slug)).toContain("private-test");
      expect((await get("/api/chants/private-test", { Cookie: `CF_Authorization=${jwt}` }, prod)).status).toBe(200);
      const forged = await token(good(), (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        false,
        ["sign"],
      ) as CryptoKeyPair).privateKey);
      const stale = await token({ ...good(), exp: now() - 1 });
      expect((await get("/api/me", { Cookie: `CF_Authorization=${stale}; CF_Authorization=${jwt}` }, prod)).status).toBe(200);
      for (const Cookie of [`CF_Authorization=${forged}`, `CF_Authorization=${await token({ ...good(), exp: now() - 1 })}`, `XCF_Authorization=${jwt}`, "CF_Authorization="]) {
        expect((await get("/api/me", { Cookie }, prod)).status).toBe(401);
        expect((await get("/api/chants/private-test", { Cookie }, prod)).status).toBe(404);
      }
    });

    it("waits a few seconds after a team's keys fail to load before fetching them again", async () => {
      const DOWN = "https://down.cloudflareaccess.com";
      const down = { ...prod, ACCESS_TEAM: DOWN };
      const headers = new Headers({ "Cf-Access-Jwt-Assertion": await token({ ...good(), iss: DOWN }) });
      const calls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith(DOWN)).length;
      const t = Date.now();
      expect(await identity(headers, down, t)).toBeNull();
      expect(await identity(headers, down, t + 9_999)).toBeNull();
      expect(calls()).toBe(1);
      expect(await identity(headers, down, t + 10_000)).toBeNull();
      expect(calls()).toBe(2);
    });

    it("never lets /api/me be cached", async () => {
      expect((await get("/api/me", { "Cf-Access-Jwt-Assertion": await token(good()) }, prod)).headers.get("Cache-Control")).toBe("private, no-store");
      expect((await get("/api/me", {}, prod)).headers.get("Cache-Control")).toBe("private, no-store");
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
