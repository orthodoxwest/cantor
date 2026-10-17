// The chant library, from the Worker's /api/chants: the public chants (content/chants, CC0),
// and for a signed-in visitor the private ones too. Each chant's GABC is fetched when needed.
import type { OfficePartKind } from "neuma";
import type { Band } from "./ribbon";

export interface LibraryChant {
  slug: string;
  /** The opening words, as a title: English, or the Greek and Latin a parish keeps. */
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
  /** An aligned recording of the chant, as the core's ribbon of it (`cantor recording`): only a
   * private chant has one. */
  recording?: Band[];
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
  kyrie: "Kyrie",
  gloria: "Gloria",
  credo: "Creed",
  sanctus: "Sanctus",
  agnus: "Agnus Dei",
  dismissal: "Dismissal",
};

/** The movements of the Ordinary of the Mass, in the order they are sung. */
const ORDINARY: readonly OfficePartKind[] = ["kyrie", "gloria", "credo", "sanctus", "agnus", "dismissal"];
export const isOrdinary = (kind: OfficePartKind | null): boolean => kind !== null && ORDINARY.includes(kind);

// The Masses of the Kyriale by number, with the names they are known by.
const MASSES = [
  "", "Lux et origo", "Kyrie fons bonitatis", "Kyrie Deus sempiterne", "Cunctipotens Genitor Deus",
  "Kyrie magnae Deus potentiae", "Kyrie Rex Genitor", "Kyrie Rex splendens", "De Angelis", "Cum jubilo",
  "Alme Pater", "Orbis factor", "Pater cuncta", "Stelliferi Conditor orbis", "Jesu Redemptor",
  "Dominator Deus", "", "", "Deus Genitor alme",
];
const NUMERALS_UPPER = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII"];

/** The Kyriale Mass a movement belongs to, by the number its name gives ("Kyrie VIII", "Ite
 * XI"); 0 when it gives none. A Creed's number is its own, not a Mass's. */
export function massOf(c: Pick<LibraryChant, "kind" | "name">): number {
  if (!isOrdinary(c.kind) || c.kind === "credo") return 0;
  const m = /^(?:Kyrie|Gloria|Sanctus|Agnus(?: Dei)?|Ite|Benedicamus)\s+([IVX]+)\b/i.exec(c.name ?? "");
  return m ? Math.max(0, NUMERALS_UPPER.indexOf(m[1]!.toUpperCase())) : 0;
}

/** "Mass VIII (De Angelis)", or null for a piece of no numbered Mass. */
export function massName(c: Pick<LibraryChant, "kind" | "name">): string | null {
  const n = massOf(c);
  return n ? `Mass ${NUMERALS_UPPER[n]}${MASSES[n] ? ` (${MASSES[n]})` : ""}` : null;
}

/** Movements of the Mass by Mass, then in the order they are sung; the rest by title after. */
export const byMass = (a: LibraryChant, b: LibraryChant) =>
  (massOf(a) || 99) - (massOf(b) || 99) || ORDINARY.indexOf(a.kind!) - ORDINARY.indexOf(b.kind!) || byTitle(a, b);

/** The kind as a heading word ("Antiphon"), or null. */
export const kindName = (kind: OfficePartKind | null): string | null => (kind && KINDS[kind]) ?? null;

/** "Antiphon · Mode viii", "Mass VIII (De Angelis) · Kyrie · Mode v", or what of it is known. */
export function kicker(chant: Pick<LibraryChant, "kind" | "mode" | "name">): string {
  return [massName(chant), kindName(chant.kind), chant.mode && `Mode ${chant.mode}`].filter(Boolean).join(" · ");
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
/** A mode's numerals. A numeral finds only the whole word ("mode vi" is not "Vidi", "ii" not
 * "viii"), except while it is the last word typed and does not follow "mode", when it begins
 * other words as any term does ("vi" on its way to "Vidi"). */
const NUMERALS = new Set([...ROMAN.slice(1), "1", "2", "3", "4", "5", "6", "7", "8"]);

/** The words of a search. */
export const terms = (q: string): string[] => wordsOf(q);

const searched = new WeakMap<LibraryChant, string[]>();
/** The words a chant is found by: its title, name and sung words, its Mass, its kind, and its
 * mode. */
function searchWords(c: LibraryChant): string[] {
  let words = searched.get(c);
  if (!words) {
    const n = ROMAN.indexOf(c.mode ?? "");
    words = wordsOf([c.title, c.name, c.words, isOrdinary(c.kind) && "Mass", massName(c), kindName(c.kind), c.mode && `mode ${c.mode}`, n > 0 && String(n)].filter(Boolean).join(" "));
    searched.set(c, words);
  }
  return words;
}

/** For each term, whether it finds a word. */
function matchers(ts: readonly string[]): ((w: string) => boolean)[] {
  return ts.map((t, i) =>
    NUMERALS.has(t) && (i < ts.length - 1 || ts[i - 1] === "mode")
      ? (w) => w === t
      : (w) => w.startsWith(t) && !(NUMERALS.has(t) && NUMERALS.has(w) && w !== t),
  );
}

/** Whether every term begins one of the chant's words ("antiphon viii", "light lighten"). */
export function finds(c: LibraryChant, ts: readonly string[]): boolean {
  const words = searchWords(c);
  return matchers(ts).every((m) => words.some(m));
}

/** `text`, escaped, with the terms marked where they begin a word. */
export function highlight(text: string, ts: readonly string[]): string {
  const f = fold(text);
  // Folding that changes the length would put the marks in the wrong places.
  if (!ts.length || f.length !== text.length) return escape(text);
  // The longest term first, so that "l light" marks all of "light".
  const longest = matchers(ts)
    .map((m, i) => ({ m, n: ts[i]!.length }))
    .sort((a, b) => b.n - a.n);
  let out = "";
  let from = 0;
  for (let i = 0; i < f.length; ) {
    const word = i === 0 || !WORD.test(f[i - 1]!) ? f.slice(i).match(/^[\p{L}\p{N}]*/u)![0] : "";
    const n = word ? longest.find(({ m }) => m(word))?.n : undefined;
    if (!n) {
      i++;
      continue;
    }
    out += `${escape(text.slice(from, i))}<mark>${escape(text.slice(i, i + n))}</mark>`;
    i = from = i + n;
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
        const row = (await res.json()) as Row & { gabc: string; recording?: Band[] };
        return { ...fromRow(row), gabc: row.gabc, ...(row.recording ? { recording: row.recording } : {}) };
      })
      .catch((error: unknown) => {
        chants.delete(slug);
        throw error;
      });
    chants.set(slug, found);
  }
  return found;
}
