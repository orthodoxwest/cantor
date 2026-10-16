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

let list: Promise<LibraryChant[]> | null = null;

/** Every chant the visitor may see, in title order. */
export function library(): Promise<LibraryChant[]> {
  list ??= fetch("/api/chants")
    .then((res) => {
      if (!res.ok) throw new Error(`the library answered ${res.status}`);
      return res.json() as Promise<Row[]>;
    })
    .then((rows) => rows.map(fromRow))
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
