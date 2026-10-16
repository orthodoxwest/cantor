/** Who is calling: a director or a student, named by Cloudflare Access (or a header in dev). */
export interface Identity {
  id: string;
  email: string | null;
}

export function identity(headers: Headers, env: string): Identity | null {
  if (env === "dev") {
    const id = headers.get("X-Dev-User");
    return id ? { id, email: null } : null;
  }
  const jwt = headers.get("Cf-Access-Jwt-Assertion");
  return jwt ? fromAccessJwt(jwt) : null;
}

// TODO: verify the Access token before trusting it. Sketch:
//   1. fetch `${team}/cdn-cgi/access/certs` (cache by kid) and pick the key the header's kid names;
//   2. verify the RS256 signature with crypto.subtle (importKey "jwk", RSASSA-PKCS1-v1_5, SHA-256);
//   3. check iss is the team domain, aud contains the application's AUD tag, exp is in the future.
// Until then only the payload is decoded; Access in front of the Worker is what rejects strangers.
function fromAccessJwt(jwt: string): Identity | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims !== "object" || claims === null) return null;
    const { sub, email } = claims as { sub?: unknown; email?: unknown };
    if (typeof sub !== "string" || sub === "") return null;
    return { id: sub, email: typeof email === "string" ? email : null };
  } catch {
    return null;
  }
}
