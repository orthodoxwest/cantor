// The chant library, from the Worker's /api/chants: the public chants (content/chants, CC0),
// and for a signed-in visitor the private ones too. Each chant's GABC is fetched when needed.
import type { OfficePartKind } from "neuma";

export interface LibraryChant {
  slug: string;
  /** The English opening words, as a title. */
  title: string;
  /** The score's own name, often the Latin incipit, less what the title repeats. */
  name: string | null;
  kind: OfficePartKind | null;
  /** "viii", "ii", or as the score gives it; null when it gives none. */
  mode: string | null;
  book: string | null;
  source: string | null;
  url: string | null;
  /** The sung words, for search. */
  words: string;
}

export interface FullChant extends LibraryChant {
  gabc: string;
}

const ROMAN = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii"];

const KINDS: Partial<Record<OfficePartKind, string>> = {
  antiphon: "Antiphon",
  introit: "Introit",
  gradual: "Gradual",
  alleluia: "Alleluia",
  tract: "Tract",
  sequence: "Sequence",
  offertory: "Offertory",
  communion: "Communion",
  hymn: "Hymn",
  responsory: "Responsory",
  "short-responsory": "Short responsory",
  versicle: "Versicle",
  psalm: "Psalm",
  canticle: "Canticle",
};

/** The kind as a heading word ("Antiphon"), or null. */
export const kindName = (kind: OfficePartKind | null): string | null => (kind && KINDS[kind]) ?? null;

/** "Antiphon · Mode viii", or what of it is known. */
export function kicker(chant: Pick<LibraryChant, "kind" | "mode">): string {
  return [kindName(chant.kind), chant.mode && `Mode ${chant.mode}`].filter(Boolean).join(" · ");
}

type Row = Omit<LibraryChant, "words"> & { words: string | null; mode: string | null };

function fromRow(row: Row): LibraryChant {
  const n = Number(row.mode);
  return { ...row, mode: Number.isInteger(n) && n >= 1 && n <= 8 ? ROMAN[n]! : row.mode || null, words: row.words ?? "" };
}

// Titles in the order a reader looks for them: case ignored, and a leading ℣, ℟ or number
// ("℣. Rest eternal", "1. Israel's King") passed over.
const collator = new Intl.Collator("en", { sensitivity: "base" });
const sortKey = (title: string) => title.replace(/^(?:[℣℟]\.?|\d+\.|\.+)\s*/u, "") || title;
export const byTitle = (a: Pick<LibraryChant, "title" | "slug">, b: Pick<LibraryChant, "title" | "slug">) =>
  collator.compare(sortKey(a.title), sortKey(b.title)) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

// ---- searching ---------------------------------------------------------------------------

/** HTML-escapes `s`. */
export const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c]};`);
/** `s` without accents, in lower case. */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const WORD = /[\p{L}\p{N}]/u;
// An apostrophe joins its word ("Israel's" is one word, found by "israel").
const wordsOf = (s: string) =>
  fold(s)
    .replace(/['’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
/** A mode's numerals, which find a whole word only, so that "ii" is not "viii". */
const NUMERALS = new Set([...ROMAN.slice(1), "1", "2", "3", "4", "5", "6", "7", "8"]);

/** The words of a search. */
export const terms = (q: string): string[] => wordsOf(q);

const searched = new WeakMap<LibraryChant, string[]>();
/** The words a chant is found by: its title, name and sung words, its kind, and its mode. */
function searchWords(c: LibraryChant): string[] {
  let words = searched.get(c);
  if (!words) {
    const n = ROMAN.indexOf(c.mode ?? "");
    words = wordsOf([c.title, c.name, c.words, kindName(c.kind), c.mode && `mode ${c.mode}`, n > 0 && String(n)].filter(Boolean).join(" "));
    searched.set(c, words);
  }
  return words;
}

const begins = (t: string) => (w: string) => (NUMERALS.has(t) ? w === t : w.startsWith(t));

/** Whether every term begins one of the chant's words ("antiphon viii", "light lighten"). */
export function finds(c: LibraryChant, ts: readonly string[]): boolean {
  const words = searchWords(c);
  return ts.every((t) => words.some(begins(t)));
}

/** `text`, escaped, with the terms marked where they begin a word. */
export function highlight(text: string, ts: readonly string[]): string {
  const f = fold(text);
  // Folding that changes the length would put the marks in the wrong places.
  if (!ts.length || f.length !== text.length) return escape(text);
  let out = "";
  let from = 0;
  for (let i = 0; i < f.length; ) {
    const t =
      i === 0 || !WORD.test(f[i - 1]!) ? ts.find((t) => f.startsWith(t, i) && !(NUMERALS.has(t) && WORD.test(f[i + t.length] ?? ""))) : undefined;
    if (!t) {
      i++;
      continue;
    }
    out += `${escape(text.slice(from, i))}<mark>${escape(text.slice(i, i + t.length))}</mark>`;
    i = from = i + t.length;
  }
  return out + escape(text.slice(from));
}

let list: Promise<LibraryChant[]> | null = null;

/** Every chant the visitor may see, in title order. */
export function library(): Promise<LibraryChant[]> {
  list ??= fetch("/api/chants")
    .then((res) => {
      if (!res.ok) throw new Error(`the library answered ${res.status}`);
      return res.json() as Promise<Row[]>;
    })
    .then((rows) => rows.map(fromRow).sort(byTitle))
    .catch((error: unknown) => {
      list = null;
      throw error;
    });
  return list;
}

const chants = new Map<string, Promise<FullChant | null>>();

/** One chant with its GABC; null when there is none the visitor may see. */
export function chant(slug: string): Promise<FullChant | null> {
  let found = chants.get(slug);
  if (!found) {
    found = fetch(`/api/chants/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`the library answered ${res.status}`);
        const row = (await res.json()) as Row & { gabc: string };
        return { ...fromRow(row), gabc: row.gabc };
      })
      .catch((error: unknown) => {
        chants.delete(slug);
        throw error;
      });
    chants.set(slug, found);
  }
  return found;
}
