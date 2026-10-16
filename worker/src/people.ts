// The name a signed-in person gives, shown beside their comments on a take in place of who
// Access says they are.

/** The longest name a person may give. */
export const MAX_NAME = 60;

/** Names that would read as the page's own words for a writer. */
const RESERVED = new Set(["you", "the singer", "singer", "a reader", "reader", "anonymous", "signed in"]);

/**
 * `sent` as a name to keep: spaces collapsed, NFC, at most MAX_NAME characters; "" forgets it;
 * null if it is not one. Control and format characters are refused, but for the joiners some
 * scripts write names with, as are runs of combining marks and the page's own words.
 */
export function nameFrom(sent: unknown): string | null {
  if (typeof sent !== "string") return null;
  const name = sent.normalize("NFC").replace(/\s+/g, " ").trim();
  if ([...name].length > MAX_NAME) return null;
  if (/[\p{Cc}\p{Co}\p{Cs}]|(?![‌‍])\p{Cf}|\p{M}{3}/u.test(name)) return null;
  const plain = name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  if (name && (!plain || RESERVED.has(plain))) return null;
  return name;
}
