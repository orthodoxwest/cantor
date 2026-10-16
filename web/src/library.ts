// The public chant library (content/chants, CC0), bundled with the pages that show it and
// described by neuma's summary. Call after neuma's init().
import { summarize, type OfficePartKind } from "neuma";

export interface LibraryChant {
  slug: string;
  gabc: string;
  /** The English opening words, as a title. */
  title: string;
  /** The score's own name, often the Latin incipit, less any of it the title repeats
   * ("Advent tone" for "Before the ending of the day (Advent tone)"); null when nothing is left. */
  name: string | null;
  kind: OfficePartKind | null;
  /** "viii", "ii", or null. */
  mode: string | null;
  book: string | null;
  url: string | null;
  text: string;
}

const files = import.meta.glob<string>("../../content/chants/*.gabc", { query: "?raw", import: "default", eager: true });

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
export function kicker(chant: LibraryChant): string {
  return [kindName(chant.kind), chant.mode && `Mode ${chant.mode}`].filter(Boolean).join(" · ");
}

/** The incipit as a title: the trailing stop gone, and the capital an initial carries over to
 * the next word ("A Light to lighten") put back to lower case. */
function titleOf(incipit: string): string {
  const words = incipit.trim().replace(/[\s,;:.]+$/, "").split(/\s+/);
  if (words.length > 1 && words[0]!.length === 1 && /^[A-Z][a-z]/.test(words[1]!) && !/^(Lord|God|Christ|Jesu|Jesus)\b/.test(words[1]!))
    words[1] = words[1]![0]!.toLowerCase() + words[1]!.slice(1);
  return words.join(" ");
}

function subtitle(name: string | null, title: string): string | null {
  if (!name) return null;
  const rest = name.toLowerCase().startsWith(title.toLowerCase()) ? name.slice(title.length).replace(/^[\s(,]+|[)\s]+$/g, "") : name;
  return rest || null;
}

function header(gabc: string, key: string): string | null {
  const head = gabc.split(/^%%$/m, 1)[0] ?? "";
  return new RegExp(`^${key}:(.*?);\\s*$`, "m").exec(head)?.[1]?.trim() || null;
}

let cache: LibraryChant[] | null = null;

/** Every chant, in title order. */
export function library(): LibraryChant[] {
  if (cache) return cache;
  cache = Object.entries(files)
    .map(([path, gabc]) => {
      const s = summarize(gabc);
      const number = s.mode?.number ?? null;
      const title = titleOf(s.incipit) || s.name || "Untitled";
      return {
        slug: path.slice(path.lastIndexOf("/") + 1, -5),
        gabc,
        title,
        name: subtitle(s.name, title),
        kind: s.kind,
        mode: number !== null && number >= 1 && number <= 8 ? ROMAN[number]! : (s.mode?.name ?? null),
        book: s.book,
        url: header(gabc, "url"),
        text: s.text,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
  return cache;
}

/** One chant by slug, or undefined. */
export const chant = (slug: string): LibraryChant | undefined => library().find((c) => c.slug === slug);
