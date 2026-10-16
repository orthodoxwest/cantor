/** Who is calling: a director or a student, named by Cloudflare Access (or a header in dev). */
export interface Identity {
  id: string;
  email: string | null;
}

/** What identity reads from the Worker's environment. */
export interface IdentityEnv {
  ENV: string;
  /** The Access team's domain, "https://<team>.cloudflareaccess.com". */
  ACCESS_TEAM?: string;
  /** The Access application's audience tag. */
  ACCESS_AUD?: string;
}

/**
 * The caller, or null. Outside dev only a Cloudflare Access token whose signature, issuer,
 * audience and expiry all check out names one; with the team or audience unset, nobody does.
 * Access adds the token as a header on the paths its application covers; elsewhere the
 * browser still sends it as the CF_Authorization cookie, which is checked the same way. (The
 * cookie travels with any request to the host, so a route that changes anything must not rely
 * on it alone.)
 */
export async function identity(headers: Headers, env: IdentityEnv, now = Date.now()): Promise<Identity | null> {
  if (env.ENV === "dev") {
    const id = headers.get("X-Dev-User");
    return id ? { id, email: null } : null;
  }
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  const team = env.ACCESS_TEAM.replace(/\/+$/, "");
  const header = headers.get("Cf-Access-Jwt-Assertion");
  // The browser may hold more than one cookie of the name (another path or a parent domain);
  // the first that verifies names the caller.
  for (const jwt of header ? [header] : cookies(headers, "CF_Authorization").slice(0, 3)) {
    try {
      const who = await verifyAccessJwt(jwt, team, env.ACCESS_AUD, now);
      if (who) return who;
    } catch {
      // A malformed token names nobody.
    }
  }
  return null;
}

function cookies(headers: Headers, name: string): string[] {
  const found: string[] = [];
  for (const pair of (headers.get("Cookie") ?? "").split(";")) {
    const at = pair.indexOf("=");
    const value = at > 0 && pair.slice(0, at).trim() === name ? pair.slice(at + 1).trim() : "";
    if (value) found.push(value);
  }
  return found;
}

const decoder = new TextDecoder();
const fromBase64Url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (part: string): unknown => JSON.parse(decoder.decode(fromBase64Url(part)));

/** Each team's signing keys by key id, as last fetched, and when. */
const teams = new Map<string, { keys: Map<string, CryptoKey>; fetched: number }>();
/** Keys are fetched again after an hour, so a key Access drops stops working; a token naming a
 * key not seen fetches them again at most once a minute. */
const KEYS_TTL = 3_600_000;
const REFETCH = 60_000;

/** When fetching a team's keys last failed: no request fetches them again for a few seconds. */
const failed = new Map<string, number>();
const RETRY = 10_000;
/** A fetch under way, shared by the requests (and cookies) that need it. */
const fetching = new Map<string, Promise<boolean>>();

async function signingKey(team: string, kid: string, now: number): Promise<CryptoKey | undefined> {
  const known = teams.get(team);
  const fresh = known && now - known.fetched < KEYS_TTL;
  if (fresh && (known.keys.has(kid) || now - known.fetched < REFETCH)) return known.keys.get(kid);
  if (now - (failed.get(team) ?? -Infinity) < RETRY) return fresh ? known.keys.get(kid) : undefined;
  let fetched = fetching.get(team);
  if (!fetched) {
    fetched = fetchKeys(team, now)
      .catch(() => false)
      .finally(() => fetching.delete(team));
    fetching.set(team, fetched);
  }
  if (!(await fetched)) {
    failed.set(team, now);
    return fresh ? known.keys.get(kid) : undefined;
  }
  return teams.get(team)?.keys.get(kid);
}

async function fetchKeys(team: string, now: number): Promise<boolean> {
  const res = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) return false;
  const { keys: jwks } = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  teams.set(team, { keys, fetched: now });
  return true;
}

async function verifyAccessJwt(jwt: string, team: string, aud: string, now: number): Promise<Identity | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts as [string, string, string];
  const header = json(head) as { alg?: unknown; kid?: unknown };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const key = await signingKey(team, header.kid, now);
  if (!key) return null;
  const signed = new TextEncoder().encode(`${head}.${body}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64Url(signature), signed))) return null;
  const claims = json(body) as { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; sub?: unknown; email?: unknown };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const seconds = now / 1000;
  if (claims.iss !== team || !audiences.includes(aud)) return null;
  if (typeof claims.exp !== "number" || claims.exp <= seconds) return null;
  if (typeof claims.nbf === "number" && claims.nbf > seconds) return null;
  if (typeof claims.sub !== "string" || claims.sub === "") return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}
