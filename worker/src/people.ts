// The name a signed-in person gives, shown beside their comments on a take in place of who
// Access says they are.

/** The longest name a person may give. */
export const MAX_NAME = 60;

/** Names that would read as the page's own words for a writer. */
const RESERVED = new Set(["you", "the singer", "singer", "a reader", "reader", "anonymous", "signed in"].flatMap((w) => [w, w.replace(/ /g, "")]));

/**
 * `sent` as a name to keep: spaces collapsed, NFC, at most MAX_NAME characters; "" forgets it;
 * null if it is not one. The page also marks every given name as from one signed in, so a name
 * made to look like its words (in another script's letters, say) still does not read as them.
 */
export function nameFrom(sent: unknown): string | null {
  if (typeof sent !== "string") return null;
  const name = sent.normalize("NFC").replace(/\s+/g, " ").trim();
  if ([...name].length > MAX_NAME) return null;
  // Controls, and format characters but the joiners; blanks that are letters (Hangul fillers,
  // the empty Braille cell); the heading's own separators; long or repeated stacks of marks.
  if (/[\p{Cc}\p{Co}\p{Cs}ᅟᅠㅤﾠ⠀·•‧⋅・]|(?![‌‍])\p{Cf}|\p{M}{6}|(\p{M})\1\1/u.test(name)) return null;
  const folded = name.normalize("NFKC").toLowerCase();
  const plain = (gap: string) => folded.replace(/[^\p{L}\p{N}\s]/gu, gap).replace(/\s+/g, " ").trim();
  if (name && (!plain("") || RESERVED.has(plain("")) || RESERVED.has(plain(" ")) || RESERVED.has(plain("").replace(/ /g, "")))) return null;
  return name;
}
