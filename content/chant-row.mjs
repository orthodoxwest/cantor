// A score as a row of the `chants` table and an entry of the library: its title (English, or the Greek and Latin of the Mass), the
// score's own name, kind, mode, book and words, read with neuma's summary, and whether it is
// approved for use in the AWRV. Shared by
// content/build.mjs and the private seed scripts in cantor-content; call after neuma's init().

/** GABC headers: `key:value;` lines before `%%`. */
export function headers(gabc) {
  const head = gabc.split(/^%%$/m, 1)[0];
  const out = {};
  for (const m of head.matchAll(/^([\w-]+):([\s\S]*?);\s*$/gm)) out[m[1]] = m[2].trim();
  return out;
}

/** The incipit as a title: the trailing stop gone, and the capital an initial carries over to
 * the next word ("A Light to lighten") put back to lower case. */
export function titleOf(incipit) {
  const words = incipit.trim().replace(/[\s,;:.]+$/, "").split(/\s+/);
  if (words.length > 1 && words[0].length === 1 && /^[A-Z][a-z]/.test(words[1]) && !/^(Lord|God|Christ|Jesu|Jesus)\b/.test(words[1]))
    words[1] = words[1][0].toLowerCase() + words[1].slice(1);
  return words.join(" ");
}

/** The score's name less what the title repeats ("Advent tone" for "Before the ending of the
 * day (Advent tone)"), or null when nothing is left. */
export function subtitle(name, title) {
  if (!name) return null;
  const rest = name.toLowerCase().startsWith(title.toLowerCase()) ? name.slice(title.length).replace(/^[\s(,]+|[)\s]+$/g, "") : name;
  return rest || null;
}

/** Whether a score is approved for use in the AWRV, by its `awrv:` header ("yes" or "no"): null
 * when it has none, or one that says neither. */
export function approvalOf(value) {
  const v = value?.trim().toLowerCase();
  return v === "yes" ? true : v === "no" ? false : null;
}

/** The row for a score: `summarize` is neuma's. `awrv`, when given, is the AWRV's approval and
 * stands over the score's header. */
export function chantRow(slug, gabc, summarize, { source = null, url = null, book, awrv } = {}) {
  const h = headers(gabc);
  const s = summarize(gabc);
  const title = titleOf(s.incipit) || s.name || slug;
  return {
    slug,
    title,
    name: subtitle(s.name, title),
    mode: h.mode ?? s.mode?.name ?? null,
    kind: s.kind,
    book: book === undefined ? s.book : book,
    source: source ?? h.source ?? null,
    url: url ?? h.url ?? null,
    words: s.text,
    awrv: awrv === undefined ? approvalOf(h.awrv) : awrv,
    gabc,
  };
}
