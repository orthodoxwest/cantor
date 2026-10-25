// A psalm tone's line typed in the St Meinrad chant font, as the parish booklets print it under a
// psalm's heading: the font draws each note from a keystroke, so the line pastes into Word as text
// set in "Meinrad". The keyboard is the one cantor-content's Meinrad decoder reads (its NOTES.md):
// one key per staff step, ten to a row, whatever the clef.
import { psalm } from "neuma";

/** A slot of the tone line: its neume, and its place in the tone. */
export interface ToneSlot {
  neume: string;
  /** "open" is a slot taking any number of syllables, none included, which the booklets print hollow. */
  role: "intonation" | "tenor" | "preparatory" | "accent" | "open" | "ending";
}

export interface ToneLine {
  clef: string;
  mediant: ToneSlot[];
  termination: ToneSlot[];
}

interface Syllable {
  neume: string;
  role: string;
}

/** Each slot's place in the tone as `counts` give it the syllables of `sung`, null for a slot taking none. */
function placesOf(counts: number[], sung: Syllable[]): (string | null)[] {
  let at = 0;
  return counts.map((c) => {
    const role = c > 0 ? sung[at]!.role : null;
    at += c;
    return role;
  });
}

/** The neumes of GABC in order, each with the text before it. */
const neumes = (gabc: string) => [...gabc.matchAll(/([^()]*)\(([^)]*)\)/g)].map((m) => ({ text: m[1]!.trim(), neume: m[2]! }));

const CLEF_GABC = /^[cf]b?[1-4]$/;
const BAR = /^(?:[,;:`]|::|;\d|[,;:]\?)$/;
/** How many notes a GABC neume sings: its pitch letters, less those naming an alteration. */
const noteCount = (neume: string) => neume.replace(/[a-mA-M][xy#]/g, "").match(/[a-mA-M]/g)?.length ?? 0;

/**
 * The tone line as `Chant.fromTone` writes it (`gabc`), each slot given its place in the tone
 * from the psalm `text` set to the tone: the verses sing the slots, the open ones as often as a
 * half needs. A slot no verse sings is open. Null when the verses can't be matched to the line.
 */
export function toneLine(gabc: string, text: string, tone: string): ToneLine | null {
  const all = neumes(gabc);
  const clef = all[0]?.neume ?? "";
  const mid = all.findIndex((n) => n.text === "*");
  if (!CLEF_GABC.test(clef) || mid < 0) return null;
  const line = {
    mediant: all.slice(1, mid).map((n) => n.neume),
    termination: all.slice(mid + 1).filter((n) => !BAR.test(n.neume)).map((n) => n.neume),
  };

  // Each sung syllable of the text: its neume and its place in the tone.
  const setting = psalm(text, tone);
  const halves = new Map<string, Syllable[]>();
  let note = 0;
  for (const { neume } of neumes(setting.gabc.replace(/^[^%]*%%/s, ""))) {
    const count = CLEF_GABC.test(neume) ? 0 : noteCount(neume);
    if (!count) continue;
    const n = setting.notes[note];
    if (!n) return null;
    note += count;
    if (n.part === "flex") continue;
    const key = `${n.verse}:${n.part}`;
    if (!halves.has(key)) halves.set(key, []);
    halves.get(key)!.push({ neume, role: n.role });
  }
  if (note !== setting.notes.length) return null;

  const roles = { mediant: [] as (string | null)[], termination: [] as (string | null)[] };
  const varies = { mediant: [] as boolean[], termination: [] as boolean[] };
  for (const part of ["mediant", "termination"] as const) {
    const slots = line[part];
    const sungs = [...halves].filter(([key]) => key.endsWith(part)).map(([, sung]) => sung);
    const known: (string | null)[] = slots.map(() => null);
    // Halves singing each slot after the tenor once name the slots' places; the rest are
    // matched to those, so an accent left with no open slot after it keeps its own place.
    for (const sung of sungs) {
      const counts = align(slots, sung, known);
      if (!counts) continue;
      const got = placesOf(counts, sung);
      const tenor = got.indexOf("tenor");
      if (tenor >= 0 && counts.every((c, i) => c === 1 || i === tenor || (c === 0 && i < tenor)))
        got.forEach((r, i) => (known[i] ??= r));
    }
    roles[part] = [...known];
    varies[part] = slots.map(() => false);
    for (const sung of sungs) {
      const counts = align(slots, sung, known);
      if (!counts) continue;
      placesOf(counts, sung).forEach((r, i) => (roles[part][i] ??= r));
      counts.forEach((c, i) => c !== 1 && (varies[part][i] = true));
    }
  }

  const build = (part: "mediant" | "termination"): ToneSlot[] | null => {
    const slots = line[part];
    const tenor = roles[part].indexOf("tenor");
    if (tenor < 0) return null;
    return slots.map((neume, i) => {
      const r = roles[part][i];
      if (i < tenor) return { neume, role: "intonation" };
      if (i === tenor) return { neume, role: "tenor" };
      if (r === "accent" || r === "preparatory") return { neume, role: r };
      // The last slot is the final note, though a half may sing it more than once.
      const open = i < slots.length - 1 && (r === null || varies[part][i]);
      return { neume, role: open ? "open" : "ending" };
    });
  };
  const mediant = build("mediant");
  const termination = build("termination");
  return mediant && termination ? { clef, mediant, termination } : null;
}

/**
 * How many syllables of `sung` each slot takes, in order, or null if they can't be matched: a
 * slot takes syllables sung to its neume in one place in the tone, its `known` place if any. A slot taking other than
 * one costs, more the later it comes, so a half one syllable short leaves out the open slot
 * before the final note rather than the final note.
 */
function align(slots: string[], sung: Syllable[], known: (string | null)[]): number[] | null {
  const n = slots.length;
  const m = sung.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  const took: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  cost[0]![0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      // Slot i-1 takes the c syllables before j.
      for (let c = 0; c <= j; c++) {
        if (c > 0) {
          const s = sung[j - c]!;
          const place = known[i - 1] ?? sung[j - 1]!.role;
          if (s.neume !== slots[i - 1] || s.role !== place) break;
        }
        const extra = c === 1 ? 0 : (c === 0 ? 1 : (c - 1) / 2) + i / 1000;
        const total = cost[i - 1]![j - c]! + extra;
        if (total < cost[i]![j]!) {
          cost[i]![j] = total;
          took[i]![j] = c;
        }
      }
    }
  }
  if (cost[n]![m] === Infinity) return null;
  const counts = new Array<number>(n);
  for (let i = n, j = m; i > 0; i--) {
    counts[i - 1] = took[i]![j]!;
    j -= counts[i - 1]!;
  }
  return counts;
}

// ---- the keystrokes -------------------------------------------------------------------------

/** Staff positions 1 to 10, below line 1 to above line 4, whatever the clef: GABC's letters. */
const PITCH = "cdefghijkl";
const HOME = "asdfghjkl;";
const HOME_UP = "ASDFGHJKL:";
const TOP = "qwertyuiop";
const VIRGA = "1234567890";
const DIAMOND = "!@#$%^&*()";
/** The dot beside a note at each position, in the space at or above it, as the booklets type it. */
const DOT = " nmm,,..///";
const CLEF: Record<string, string> = { c4: "B", c3: "V", c2: "C", f3: "X", f4: "Z" };
const pua = (base: number, pos: number) => String.fromCharCode(base + pos);
/** Private-use glyphs: an accent over the note after it, a hollow note, a flat, a quilisma, an oriscus. */
const ACCENT = "";
const HOLLOW = 0xeab0;
const FLAT = 0xec00;
const QUILISMA = 0xea90;
const ORISCUS = 0xeb80;
const PORRECTUS = 0xead0;
const PORRECTUS_WIDE = 0xeaf0;
const STEM_DOWN = 0xeb40;

interface Note {
  pos: number;
  shape: "punctum" | "virga" | "inclinatum" | "quilisma" | "oriscus";
  flat: boolean;
  dots: number;
}

/** A neume's notes, or null for GABC this doesn't type (notes off the staff, naturals, signs). */
function parseNeume(neume: string): Note[] | null {
  const notes: Note[] = [];
  const flats = new Set<number>();
  for (let i = 0; i < neume.length; i++) {
    const c = neume[i]!;
    const low = c.toLowerCase();
    const pos = PITCH.indexOf(low) + 1;
    if (/[a-mA-M]/.test(c)) {
      if (!pos) return null;
      if (neume[i + 1] === "x") {
        flats.add(pos);
        i++;
        continue;
      }
      if (neume[i + 1] === "y" || neume[i + 1] === "#") return null;
      notes.push({ pos, shape: c === low ? "punctum" : "inclinatum", flat: flats.delete(pos), dots: 0 });
      continue;
    }
    const last = notes.at(-1);
    if (!last) return null;
    if (c === "v") last.shape = "virga";
    else if (c === "w") last.shape = "quilisma";
    else if (c === "o") last.shape = "oriscus";
    else if (c === ".") last.dots++;
    else if (!"'_/!~".includes(c)) return null;
  }
  return notes.length ? notes : null;
}

const single = (n: Note) =>
  n.shape === "virga"
    ? VIRGA[n.pos - 1]!
    : n.shape === "inclinatum"
      ? DIAMOND[n.pos - 1]!
      : n.shape === "quilisma"
        ? pua(QUILISMA, n.pos)
        : n.shape === "oriscus"
          ? pua(ORISCUS, n.pos)
          : HOME[n.pos - 1]!;

/**
 * The keys drawing a neume's notes as one figure where the font has it (pes, clivis, torculus,
 * porrectus), else note by note: a climacus is its virga and diamonds.
 */
function figure(notes: Note[]): string {
  const [a, b, c] = notes;
  const plain = notes.every((n) => n.shape === "punctum");
  if (a && b && !c && plain && a.pos < b.pos) return HOME_UP[a.pos - 1]! + HOME[b.pos - 1]!;
  if (a && b && !c && a.shape === "quilisma" && b.shape === "punctum" && a.pos < b.pos) return pua(QUILISMA, a.pos) + HOME[b.pos - 1]!;
  if (a && b && !c && plain && a.pos > b.pos) return TOP[a.pos - 1]! + HOME[b.pos - 1]!;
  if (a && b && c && notes.length === 3 && plain && a.pos < b.pos && c.pos < b.pos)
    return HOME[a.pos - 1]! + TOP[b.pos - 1]! + HOME[c.pos - 1]!;
  if (a && b && c && notes.length === 3 && plain && b.pos < a.pos && c.pos > b.pos && a.pos - b.pos <= 2)
    return pua(a.pos - b.pos === 1 ? PORRECTUS : PORRECTUS_WIDE, a.pos) + pua(STEM_DOWN, c.pos);
  return notes.map(single).join("");
}

/** A slot's keys: its flats, its figure with an accent or hollow head, and its dots. */
function slotKeys(slot: ToneSlot): string | null {
  const notes = parseNeume(slot.neume);
  if (!notes) return null;
  const flats = notes.filter((n) => n.flat).map((n) => pua(FLAT, n.pos)).join("");
  const hollow = slot.role === "open" && notes.length === 1 && notes[0]!.shape === "punctum";
  const body = hollow ? pua(HOLLOW, notes[0]!.pos) : figure(notes);
  // Dots follow the figure, each at the height of the note it follows: "gf.." dots both.
  const dotted = notes.flatMap((n, i) => (n.dots > 1 && i > 0 ? [notes[i - 1]!, n] : n.dots ? [n] : []));
  const dots = dotted.map((n) => DOT[n.pos]!).join("");
  return flats + (slot.role === "accent" ? ACCENT : "") + body + dots;
}

/**
 * The tone line as Meinrad keystrokes, as the booklets set it: the clef, the intonation to the
 * tenor, a bar,
 * the tenor three times, a quarter bar, the mediant's cadence, a bar; the tenor again, a quarter
 * bar, the termination's cadence and a double bar. Accents carry the booklets' accent sign and
 * open slots are hollow. `c` and `v` are the font's wide and narrow spaces. Null when a clef or
 * neume isn't one the keyboard types.
 */
export function meinrad(line: ToneLine): string | null {
  const clef = CLEF[line.clef];
  if (!clef) return null;
  const keys = (slots: ToneSlot[]) => {
    const out = slots.map(slotKeys);
    return out.every((k) => k !== null) ? (out as string[]) : null;
  };
  const half = (slots: ToneSlot[]) => {
    const t = slots.findIndex((s) => s.role === "tenor");
    const lead = keys(slots.slice(0, t));
    const tenor = keys([slots[t]!]);
    const cadence = keys(slots.slice(t + 1));
    return lead && tenor && cadence ? { lead, tenor: tenor[0]!, cadence } : null;
  };
  const m = half(line.mediant);
  const t = half(line.termination);
  if (!m || !t) return null;
  const recite = (tenor: string) => `c${[tenor, tenor, tenor].join("c")}c[c`;
  return (
    `${clef}c` +
    `${[...m.lead, m.tenor].join("vv")}cv]` +
    recite(m.tenor) +
    `${m.cadence.join("cv")}c]` +
    recite(t.tenor) +
    `${t.cadence.join("cv")}c}`
  );
}
