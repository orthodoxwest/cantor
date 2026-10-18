import { Chant, init, summarize } from "neuma";
import { Cursor } from "./cursor";
import { Guide, PULSE } from "./guide";
import { type Entry, Listener } from "./listen";
import DEFAULT_GABC from "../../content/chants/lumen-gentium.gabc?raw";
import { escape, finds, highlight, kicker, library, chant as findChant, terms, type LibraryChant } from "./library";
import { describePitch, noteName } from "./notes";
import { drawMarks, type Mark } from "./marks";
import { SCALE, Score } from "./score";
import { across, drawRibbon, type GridCell, type Judged, places, type Place, secondAt, span, STRIP } from "./ribbon";
import { offerSignIn } from "./beam";
import { copyWhenReady, sendTake, signedIn } from "./send";
import { audioContext } from "./audio";
import { letSleep, stayAwake } from "./awake";
import { Drone, droneNote, modeNumber } from "./drone";
import { melismaNeumes, phraseOf, syllableRuns, tapLoop } from "./loop";
import { recordedTimes, recordingSound } from "./recording";
import { Replay } from "./replay";
import { grewOver, grown, outside, saidIn, viewOf } from "./again";
import { opening, stepCell } from "./grid";
import { byPhrase, runOf, stepTo, sungOrder, writtenStep } from "./review";
import { neutralTable, sing, type Singing, type SungNote, VoiceTable } from "./singer";
import { headphonesIn, ONSET_WINDOW, throughHeard, timed, type Timed } from "./timing";
import { anyKept, chantKey, forget, keep, type Kept, kept, notesOf, onNews, whenSung } from "./kept";

void offerSignIn();

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
// ?test=1 pins the cursor to the page's clock, which tests can fake.
const test = params.get("test") === "1";
// ?voice=URL sings the guide with a recorded voice file; without it, or if it fails to load,
// the guide sings the neutral vowel.
const voiceUrl = params.get("voice");

// ?chant=SLUG picks a chant from the library; the first route's chant otherwise, bundled so
// the page works when the library cannot be reached.
const DEFAULT = "lumen-gentium";
const asked = params.get("chant") ?? DEFAULT;
const [, found] = await Promise.all([init(), findChant(asked).catch(() => null)]);
const piece = found ?? { slug: DEFAULT, title: "A light to lighten the Gentiles", kind: "antiphon" as const, mode: "viii", name: "Lumen gentium", gabc: DEFAULT_GABC };
if (!found && asked !== DEFAULT) byId("status").textContent = "That chant is not in the library, so here is the first one.";
byId("kicker").textContent = ["Practice", kicker({ kind: piece.kind, mode: piece.mode, name: piece.name })].filter(Boolean).join(" · ");
byId("title").textContent = piece.title;
document.title = `${piece.title} · Practice · Cantor`;

// Another chant is found by its words as they are typed: a few of the library's chants, each a
// link to practise it.
const find = byId<HTMLInputElement>("find");
const foundList = byId<HTMLOListElement>("found");
const foundNote = byId<HTMLSpanElement>("found-note");
/** Matches listed at a time; more words narrow them. */
const FOUND = 8;
let everything: LibraryChant[] | null = null;
let reaching = false;
let unreachable = false;

/** Fetches the library once it is wanted, and again after a failure. */
function reach(): void {
  if (everything || reaching) return;
  reaching = true;
  unreachable = false;
  void library()
    .then(
      (all) => (everything = all),
      () => (unreachable = true),
    )
    .finally(() => {
      reaching = false;
      drawFound();
    });
}

/** The address of `slug`'s practice, keeping the rest of this one's. */
function practice(slug: string): string {
  const next = new URLSearchParams(params);
  next.set("chant", slug);
  return `/sing?${next}`;
}

function drawFound(): void {
  const q = find.value.trim();
  const ts = find.disabled ? [] : terms(q);
  const matches = ts.length && everything ? everything.filter((c) => finds(c, ts)) : [];
  foundList.innerHTML = matches
    .slice(0, FOUND)
    .map(
      (c) => `<li><a href="${escape(practice(c.slug))}"${c.slug === piece.slug ? ' aria-current="page"' : ""}>
  <span class="name">${highlight(c.title, ts)}${c.name ? ` <span class="latin">${highlight(c.name, ts)}</span>` : ""}</span>
  <span class="kicker">${escape(kicker(c))}</span></a></li>`,
    )
    .join("");
  foundList.hidden = !matches.length;
  let note = "";
  if (!ts.length) note = "";
  else if (!everything) note = unreachable ? "The library could not be reached." : "Searching…";
  else if (!matches.length) note = `Nothing matches “${q}”.`;
  else if (matches.length > FOUND) note = `${FOUND} of ${matches.length}; another word narrows them.`;
  else note = matches.length === 1 ? "1 chant" : `${matches.length} chants`;
  foundNote.textContent = note;
}
find.addEventListener("focus", reach);
find.addEventListener("input", () => {
  reach();
  drawFound();
});
// Words already in the box, typed before the page was ready or put back by the browser on
// going back to it, are searched for too.
if (find.value.trim()) reach();
const links = () => [...foundList.querySelectorAll<HTMLAnchorElement>("a")];
find.addEventListener("keydown", (e) => {
  // Enter practises the first match (not the Enter that ends an input method's composing, which
  // Safari sends as key code 229), the down arrow goes into the list, Escape clears.
  if (e.key === "Escape" && find.value) {
    e.preventDefault();
    find.value = "";
    drawFound();
    return;
  }
  const first = links()[0];
  if (!first) return;
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    location.assign(first.href);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    first.focus();
  }
});
foundList.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return find.focus();
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const all = links();
  const at = all.indexOf(document.activeElement as HTMLAnchorElement);
  if (at < 0) return;
  e.preventDefault();
  (all[at + (e.key === "ArrowDown" ? 1 : -1)] ?? (e.key === "ArrowUp" ? find : all[at]!)).focus();
});
const score = new Score(byId("score"), new Chant(piece.gabc), SCALE);
const cursor = new Cursor(score);

// After a scored take: above the score, the core's two sentences on the take, the singer's key
// (which the guide then sings in) and how to read the ribbon; on the score, the ribbon under the
// staff and the core's marks on the notes; under it, the marks in words, gathered by phrase; and
// above the bar, the card of the mark open. Where the chant has an aligned recording of the same
// notes, the ribbon draws its trace under the singer's. A note, a band or a mark tapped chooses
// its phrase, for Compare, Guide and Yours to play alone, and the bar steps from mark to mark.
const result = byId<HTMLElement>("result");
const summaryText = byId<HTMLParagraphElement>("summary");
const saidHint = byId<HTMLSpanElement>("said-hint");
const keyText = byId<HTMLParagraphElement>("key");
const inKeyLine = byId<HTMLParagraphElement>("in-key-line");
const inKeyBox = byId<HTMLInputElement>("in-key");
const recordedText = byId<HTMLParagraphElement>("recorded");
// A run of the take sung again: the core's words of it beside the take, and the same words for a
// screen reader (the line on the screen hidden from it, so they are read once), filled anew for
// each run so that the same words are heard again without the line moving the score.
const againText = byId<HTMLParagraphElement>("again-said");
const againHeard = byId<HTMLParagraphElement>("again-heard");
// The take before this one of the same chant, kept on the device, drawn dotted under it unless
// the singer turns it off; the foot of the page says takes are kept, and forgets them at a tap.
const beforeLine = byId<HTMLParagraphElement>("before-line");
const beforeBox = byId<HTMLInputElement>("before");
const beforeWhen = byId<HTMLSpanElement>("before-when");
const keptText = byId<HTMLParagraphElement>("kept");
const keptSaid = byId<HTMLSpanElement>("kept-said");
const forgottenText = byId<HTMLSpanElement>("forgotten");
/** What the foot says once the takes kept are forgotten, here or in another tab. */
const FORGOTTEN = "Forgotten: no take is kept on this device now.";
/** How many times the takes kept have been forgotten, here or in another tab: a take kept read
 * before the latest is not drawn. */
let forgettings = 0;
const forgetButton = byId<HTMLButtonElement>("forget");
/** Where the singer's choice of whether to see the take before is remembered. */
const BEFORE_KEY = "cantor.before";
try {
  beforeBox.checked = localStorage.getItem(BEFORE_KEY) !== "off";
} catch {
  // A browser that keeps nothing shows it.
}
/** The take kept before the take shown, while that take is shown. */
let before: { of: Judged; take: Kept } | null = null;
const readingText = byId<HTMLDetailsElement>("reading");
const recording = found?.recording ?? [];
const placesSection = byId<HTMLElement>("places");
const markedList = byId<HTMLOListElement>("marked");
const cutText = byId<HTMLParagraphElement>("cut");
// The card of the place open (the bar names it): the core's words, how its first note is written
// from the note before, and the step into it to hear.
const why = byId<HTMLDivElement>("why");
const whyWords = byId<HTMLParagraphElement>("why-words");
/** The card's words again where a screen reader hears them: always on the page, so that they
 * are read out when a mark opens with its card. */
const whySaid = byId<HTMLParagraphElement>("why-said");
const whyStep = byId<HTMLSpanElement>("why-step");
const unopenButton = byId<HTMLButtonElement>("unopen");
/** Names `button` `label`, read aloud and shown on hover alike. */
function labelButton(button: HTMLButtonElement, label: string): void {
  if (button.getAttribute("aria-label") === label) return;
  button.setAttribute("aria-label", label);
  button.title = label;
}
const stepButton = byId<HTMLButtonElement>("step");
let shown: Judged | null = null;
/** The take shown as it is heard back: when each of its notes was due in its audio, the seconds
 * a pulse it was sung at, and its audio decoded; and whether it is a run sung again. */
interface Heardback {
  times: Timed[];
  pulse: number;
  audio: (ctx: AudioContext) => Promise<AudioBuffer>;
  again: boolean;
}
/** A run of the take shown sung again, while it is shown over the take: its notes, the key it
 * was sung and judged in (in cents from the score, the core's `key_at`), it judged (its bands,
 * marks and endings of the chant's notes by index, its words beside the take), and how it is
 * heard back. Another run sung again, or another take, takes its place; `replaced` is what of the
 * run sung again before it this one does not hold ([`outside`]), drawn as in the take again. */
interface Again {
  run: [number, number];
  key: number;
  judged: Judged;
  back: Heardback;
  replaced: Array<[number, number]>;
}
let again: Again | null = null;
/** What is drawn of the take shown: the take, with the run sung again in place of it there
 * ([`viewOf`]). */
let viewed: Judged | null = null;
/** The note the singer stopped the take shown at, or null when it ran to the end; and whether
 * the guide was in their headphones. */
let cutAt: number | null = null;
let shownWorn = false;
/** The Pitch the take shown was sung at, in semitones from the score's. */
let shownPitch = 0;

/** A place in the take shown that the core tells of: one of its marks, or a phrase ending it
 * heard off pitch (of those the summary's second sentence counts) that none of its marks tells
 * of already, over notes `first` to `last`, with the core's words for it and the note they are
 * of (a mark's first, an ending's furthest off). */
interface Spot {
  first: number;
  last: number;
  at: number;
  words: string;
  mark: Mark | null;
}
/** The places of the take shown, when it was heard: its marks first, each at the index its ring
 * on the score has, then its endings off pitch that no mark tells of already. */
let spots: Spot[] = [];
/** The place the summary's sentence of endings off pitch opens: the first ending's, or the mark
 * that tells of it already. */
let saidAt: number | null = null;
/** The place open, by index, or none. */
let open: number | null = null;
/** The ending a cell of the grid opened where no place among the spots is it: one off pitch that
 * a mark not on its own note tells of already (a verse's, say), whose card is then the ending's
 * own, so that it says what the cell does. Let go as any place opens or closes. */
let cellOpen: Spot | null = null;
/** Whether the place open was opened from a cell of the grid, which closing it goes back to. */
let openedByCell = false;
/** The place whose card is open: one of the spots, or an ending a cell opened. */
const openSpot = (): Spot | undefined => (open === null ? (cellOpen ?? undefined) : spots[open]);
/** The place last opened, which the steps go on from while the run chosen holds it. */
let lastOpen: number | null = null;

/** Opens place `k`, or none; the step of another place stops, so that it does not play on under
 * a card that has moved on. */
function setOpen(k: number | null): void {
  if ((k !== open || cellOpen) && playing?.button === stepButton) stopPlay();
  open = k;
  cellOpen = null;
  openedByCell = false;
  if (k !== null) lastOpen = k;
}

function spotsOf(judged: Judged | null): Spot[] {
  if (!judged || judged.verdict.key_cents === null) return [];
  return [
    ...judged.verdict.marks.map((mark, k) => ({ first: mark.first, last: mark.last, at: mark.first, words: judged.told[k] ?? "", mark })),
    ...(judged.endings ?? []).flatMap(({ first, last, note, mark, words }) => (mark === null ? [{ first, last, at: note, words, mark: null }] : [])),
  ];
}

/** The place the first ending off pitch is (`saidAt`): the mark that tells of it already, or
 * the first of the endings among the places, after the marks. */
function saidOf(judged: Judged | null): number | null {
  const first = judged?.endings?.[0];
  if (!first || spots.length === 0) return null;
  return first.mark ?? judged.verdict.marks.length;
}

/** Whether place `spot` is of the run sung again: its marks and endings are the only ones within it. */
const ofAgain = (spot: { first: number; last: number }) => again !== null && spot.first >= again.run[0] && spot.last <= again.run[1];

/** How many of `ks`, places, are marks and how many endings, in words: "2 marks, an ending off
 * pitch". */
function counted(ks: readonly number[]): string {
  const marks = ks.filter((k) => spots[k]?.mark).length;
  const endings = ks.length - marks;
  return [
    marks ? `${marks} mark${marks === 1 ? "" : "s"}` : "",
    endings === 1 ? "an ending off pitch" : endings ? `${endings} endings off pitch` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** What the core found of a take it could not judge, `what` (the take, or a run sung again), sung
 * with the guide in headphones if `worn`, and what to try. */
function unheard(judged: Judged, what = "the take", worn = shownWorn): string {
  if (judged.verdict.outcome === "masked")
    return `The guide was louder than your voice, so too little of it was heard to judge ${what}. Use headphones, or untick Headphones so the guide gives only the opening notes.`;
  const begin = worn ? "with the guide" : "when the cursor appears";
  return `Too little of your voice was heard to judge ${what}. Sing nearer the microphone and a little louder, beginning ${begin}.`;
}

/** How far the singer started (`key` cents from the score) from the guide sung at `pitch`
 * semitones: folded, as the key is, into an octave either side, in cents. */
function fromGuide(key: number, pitch: number): number {
  return ((((key - pitch * 100 + 600) % 1200) + 1200) % 1200) - 600;
}

/** Whether a key `from` cents from the guide is far enough from it to tell, and to sing in. */
const away = (from: number) => Math.abs(from) >= 25;

/** Where the singer started against the guide (`key` cents from the score, sung at `pitch`
 * semitones), in words a beginner can act on: a take is judged in the singer's own key, so
 * only a key away from the guide's is worth telling, with the Pitch that would begin the next
 * take there. */
function keyLine(key: number, pitch: number): string {
  const from = fromGuide(key, pitch);
  const semis = Math.round(from / 100);
  const about = Math.abs(from - semis * 100) >= 25 ? "about " : "";
  if (semis === 0)
    return away(from) ? `You started close to the guide’s pitch, a little ${from > 0 ? "sharp" : "flat"}.` : "You started on the guide’s pitch.";
  const n = Math.abs(semis);
  let meet = pitch + semis;
  if (meet > 7) meet -= 12;
  if (meet < -7) meet += 12;
  const label = [...pitchSelect.options].find((o) => Number(o.value) === meet)?.text;
  return (
    `You started ${about}${n} semitone${n === 1 ? "" : "s"} ${semis > 0 ? "above" : "below"} the guide. ` +
    "That is fine: chant may be sung in any key that suits your voice, and each note is judged from the one you started in." +
    (label ? ` To begin your next take there, set Pitch to “${label}”.` : "")
  );
}

/** Where the guide sings beside a take over the notes `range` (the whole chant when none), in
 * semitones from the score: where the singer started, or over a run sung again where they sang it
 * again, while a take heard away from the guide is shown and the singer keeps the guide there;
 * else undefined, at the Pitch. Exactly, not to the nearest semitone, so that only the singer's
 * own faults sound apart. */
function reviewTranspose(range: readonly [number, number] | null | undefined): number | undefined {
  const key = range && again && inside(range, again.run) ? again.key : (shown?.verdict.key_cents ?? null);
  if (key === null || !inKeyBox.checked || !away(fromGuide(key, shownPitch))) return undefined;
  return key / 100;
}

/** Whether the notes `range` are all of `run`'s. */
const inside = (range: readonly [number, number], run: readonly [number, number]) => range[0] >= run[0] && range[1] <= run[1];

/** The words sung on note `i`: its syllable, or for a note with none (a jubilus) the last
 * sung before it in its verse. */
function syllableOf(i: number): string {
  const notes = score.timeline.notes;
  const verse = notes[i]?.verse;
  for (let j = i; j >= 0; j--) {
    const n = notes[j];
    if (!n || n.verse !== verse) break;
    const text = n.syllableText.trim();
    if (text) return text;
  }
  return "";
}

/** The words of notes `a` to `b`, word by word: "Al-le-lu-ia" sung on them reads "Alleluia". */
function wordsOf(a: number, b: number): string {
  const notes = score.timeline.notes.slice(a, b + 1);
  let out = "";
  let word: number | null = null;
  let syllable: number | null = null;
  for (const n of notes) {
    if (n.syllable === syllable) continue;
    syllable = n.syllable;
    const text = n.syllableText.trim().replace(/-$/, "");
    if (!text) continue;
    out += (word !== null && n.word !== word ? " " : "") + text;
    word = n.word;
  }
  return out;
}

/** Notes `a` to `b` by number: "Note 4", "Notes 4 to 9". */
const numbered = (a: number, b: number) => (a === b ? `Note ${a + 1}` : `Notes ${a + 1} to ${b + 1}`);

/** Notes `a` to `b` in a sentence: their words, quoted, when they hold whole words ("“alleluia”");
 * else by number ("notes 3 to 6"). */
function runWords(a: number, b: number): string {
  const notes = score.timeline.notes;
  const whole = notes[a - 1]?.word !== notes[a]?.word && notes[b + 1]?.word !== notes[b]?.word;
  const words = whole ? wordsOf(a, b) : "";
  return words ? `“${words}”` : numbered(a, b).toLowerCase();
}

/** The syllables at either end of notes `a` to `b`, quoted: "“al … ia”", or none. */
function ends(a: number, b: number): string {
  const sung = [syllableOf(a), a === b ? "" : syllableOf(b)].filter(Boolean);
  return sung.length ? `“${sung.join(" … ")}”` : "";
}

/** The take the places are listed for. */
let listedFor: Judged | null = null;

/** The places the core tells of written out under the score, gathered by the phrase each is in
 * (one row a phrase, folded, in the order sung), each with the note it is on, so that a phone can
 * read what the rings mean in a list; each opens its place on the score. Listed once a take, so
 * that opening one keeps the rows as they were opened and the button its focus. */
function listSpots(judged: Judged | null): void {
  if (judged === listedFor) {
    for (const b of markedList.querySelectorAll<HTMLButtonElement>("[data-opens]"))
      b.setAttribute("aria-expanded", String(Number(b.dataset.opens) === open));
    return;
  }
  listedFor = judged;
  placesSection.hidden = spots.length === 0;
  const { pauses, notes } = score.timeline;
  markedList.replaceChildren(
    ...byPhrase(spots, pauses, notes.length).map(({ run: [a, b], marks: ks }) => {
      const summary = document.createElement("summary");
      summary.append(
        Object.assign(document.createElement("span"), { className: "phrase", textContent: wordsOf(a, b) || numbered(a, b) }),
        " ",
        Object.assign(document.createElement("span"), { className: "count", textContent: counted(ks) }),
      );
      const list = document.createElement("ol");
      list.setAttribute("role", "list");
      list.append(
        ...ks.map((k) => {
          const spot = spots[k]!;
          const sung = syllableOf(spot.at);
          const where = `${numbered(spot.first, spot.last)}${sung ? `, “${sung}”` : ""}: `;
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.opens = String(k);
          button.setAttribute("aria-controls", "why");
          button.setAttribute("aria-expanded", String(k === open));
          button.append(Object.assign(document.createElement("span"), { className: "where", textContent: where }), spot.words);
          const item = document.createElement("li");
          item.append(button);
          return item;
        }),
      );
      const details = document.createElement("details");
      details.append(summary, list);
      const item = document.createElement("li");
      item.append(details);
      return item;
    }),
  );
}
markedList.addEventListener("click", (e) => {
  const button = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-opens]");
  if (!button || !shown) return;
  const k = Number(button.dataset.opens);
  toggleSpot(k);
  // The place on the score, clear of its card above the bar.
  if (open !== null) bringIntoView(k);
});

// A psalm sung to a tone, verse by verse, under the score: the core's grid of the take shown, with
// the parts a run sung again called in place of the take's (grid.ts). One tab stop among its
// cells, the arrows moving along a row and down a column.
const gridSection = byId<HTMLElement>("grid");
const gridColumns = byId<HTMLTableRowElement>("grid-columns");
const gridRows = byId<HTMLTableSectionElement>("grid-rows");
/** The view the grid is drawn for. */
let griddedFor: Judged | null = null;
/** The part of a verse the keyboard was last on in the grid, by its notes ("16-22"), kept while
 * the grid is drawn again. */
let gridAt: string | null = null;

/** The cell at row `r`, column `c` of the grid drawn, and the button of a cell by row and column
 * or by its notes. */
const gridCell = (r: number, c: number) => griddedFor?.grid?.rows[r]?.cells[c] ?? null;
const cellButton = (r: number, c: number) => gridRows.querySelector<HTMLButtonElement>(`button[data-row="${r}"][data-col="${c}"]`);
const runButton = (run: string | null | undefined) => (run ? gridRows.querySelector<HTMLButtonElement>(`button[data-run="${run}"]`) : null);

/** Draws the grid of `view`, the take shown with any run sung again in its place, or hides it:
 * once a view, so that a tap keeps its cell and the keyboard its place; else only which cell holds
 * the run chosen. */
function drawGrid(view: Judged | null): void {
  const grid = view?.grid ?? null;
  gridSection.hidden = !grid || grid.rows.length === 0;
  if (view !== griddedFor) {
    const focused = gridRows.contains(document.activeElement);
    griddedFor = view;
    const cell = (tag: "th" | "td", text = "") => Object.assign(document.createElement(tag), { textContent: text });
    const span = (className: string, text: string) => Object.assign(document.createElement("span"), { className, textContent: text });
    gridColumns.replaceChildren(...(grid ? ["Verse", ...grid.columns.map((c) => c.name)] : []).map((name) => cell("th", name)));
    for (const th of gridColumns.children) th.setAttribute("scope", "col");
    gridRows.replaceChildren(
      ...(grid?.rows ?? []).map((row, r) => {
        const head = cell("th");
        head.setAttribute("scope", "row");
        head.append(span("n", String(row.number)), " ", span("words", opening(wordsOf(row.first, row.last))));
        const tr = document.createElement("tr");
        tr.append(
          head,
          ...row.cells.map((part, c) => {
            const td = cell("td");
            if (!part) return td;
            const button = document.createElement("button");
            button.type = "button";
            button.className = `cell ${part.called}`;
            Object.assign(button.dataset, { row: String(r), col: String(c), run: `${part.first}-${part.last}` });
            button.append(span("said", part.words), ...(part.inner ?? []).map((inner) => span("inner", inner.words)));
            if (part.was) button.append(span("was", `Your take: ${told(part.was)}`));
            const name = grid!.columns[c]?.name ?? "";
            button.setAttribute("aria-label", `${name} of verse ${row.number}: ${told(part)}${part.was ? `. Your take: ${told(part.was)}` : ""}`);
            td.append(button);
            return td;
          }),
        );
        return tr;
      }),
    );
    if (!runButton(gridAt)) gridAt = null;
    if (focused) (runButton(gridAt) ?? gridRows.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
  }
  const chosen = loop?.join("-");
  for (const b of gridRows.querySelectorAll<HTMLButtonElement>("button[data-run]")) b.setAttribute("aria-pressed", String(b.dataset.run === chosen));
  rove();
}

/** What `cell` says: how its ending was called, and the endings off pitch inside it. */
const told = (cell: GridCell) => [cell.words, ...(cell.inner ?? []).map((inner) => inner.words)].join(". ");

/** Puts the grid's one tab stop on the cell the keyboard was last on, else the one holding the
 * run chosen, else the first. */
function rove(): void {
  const buttons = [...gridRows.querySelectorAll<HTMLButtonElement>("button[data-row]")];
  const stop = runButton(gridAt) ?? buttons.find((b) => b.getAttribute("aria-pressed") === "true") ?? buttons[0];
  for (const b of buttons) b.tabIndex = b === stop ? 0 : -1;
}

/** The place that tells of the ending off pitch `cell` tells of (its own, or when its own was
 * not, the first inside it) in the same words: the mark on that ending's own note when one is,
 * else the ending, among the spots when no mark tells of it already, else on its own. None for a
 * cell that tells of none. */
function placeOfCell(cell: GridCell): number | Spot | null {
  const [from, to] = cell.called === "off-pitch" && cell.ending ? cell.ending : cell.inner?.[0] ? [cell.inner[0].first, cell.inner[0].last] : [-1, -1];
  const ending = viewed?.endings?.find((e) => e.first === from && e.last === to);
  if (!ending) return null;
  const mark = ending.mark === null ? undefined : viewed?.verdict.marks[ending.mark];
  if (mark?.kind === "note" && mark.first === ending.note) return ending.mark;
  const k = ending.mark === null ? spots.findIndex((s) => !s.mark && s.first === from && s.last === to) : -1;
  return k >= 0 ? k : { first: from, last: to, at: ending.note, words: ending.words, mark: null };
}

/** Opens `place`, one of the spots or an ending of its own, or none. */
function openPlace(place: number | Spot | null): void {
  setOpen(typeof place === "number" ? place : null);
  if (place !== null && typeof place !== "number") cellOpen = place;
}

/** Chooses the part of a verse in cell `[r, c]` of the grid to play and sing again, opening the
 * place that tells of its ending off pitch if one does; the part chosen already is let go. In a
 * take, which nothing is chosen in, it opens that place or closes it. */
function chooseCell(r: number, c: number): void {
  const cell = gridCell(r, c);
  if (!cell || !shown) return;
  const place = placeOfCell(cell);
  if (taking) {
    if (place === null) return;
    const opened = typeof place === "number" ? open === place : cellOpen?.first === place.first && cellOpen.last === place.last;
    openPlace(opened ? null : place);
    openedByCell = !opened;
    return drawResult();
  }
  const chosen = loop !== null && loop[0] === cell.first && loop[1] === cell.last;
  stopPlay();
  if (chosen) return setLoop(null);
  setLoop([cell.first, cell.last], typeof place === "number" ? place : null);
  if (place !== null && typeof place !== "number") {
    openPlace(place);
    drawResult();
  }
  openedByCell = place !== null;
}

/** The cell of the grid a button is, by row and column. */
const cellOf = (target: EventTarget | null) => {
  const button = (target as Element | null)?.closest<HTMLButtonElement>("button[data-row]");
  return button ? ([Number(button.dataset.row), Number(button.dataset.col)] as [number, number]) : null;
};
gridRows.addEventListener("click", (e) => {
  const at = cellOf(e.target);
  if (!at) return;
  gridAt = cellButton(...at)!.dataset.run!;
  chooseCell(...at);
  // Clear of the bar and of the card it may have opened.
  reveal([runButton(gridAt)], "smooth");
});
gridRows.addEventListener("focusin", (e) => {
  const at = cellOf(e.target);
  if (!at) return;
  gridAt = cellButton(...at)!.dataset.run!;
  rove();
});
gridRows.addEventListener("keydown", (e) => {
  const at = cellOf(e.target);
  if (!at || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const to = stepCell(griddedFor?.grid?.rows ?? [], at, e.key);
  // At an edge the keyboard stays, and the page does not scroll.
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) e.preventDefault();
  const button = to && cellButton(...to);
  if (!button) return;
  gridAt = button.dataset.run!;
  rove();
  button.focus();
});

/** What shows place `k` on the score: a mark's ring, or an ending's note off. */
function spotOnScore(k: number): Element | null {
  const spot = spots[k];
  if (!spot) return null;
  if (spot.mark) return score.host.querySelector(`[data-mark="${k}"]`);
  const note = score.timeline.notes[spot.at];
  return note ? (score.ink(note.id)[0] ?? null) : null;
}

/** Scrolls place `k` on the score (a mark's ring, or an ending's note off), with the band under
 * the note it is of that shows why it is told, to the middle of what the bar and the card leave of
 * the window, unless they are already clear of them; where both do not fit, the place goes to
 * the top. */
function bringIntoView(k: number): void {
  const spot = spots[k];
  reveal([spotOnScore(k), spot ? score.host.querySelector(`[data-band="${spot.at}"]`) : null], "smooth");
}

/** Scrolls `els` together to the middle of what the bar and the card leave of the window, unless
 * they are already clear of them; where they do not fit, their top goes to the top. */
function reveal(els: ReadonlyArray<Element | null>, behavior: "smooth" | "auto"): void {
  const boxes = els.flatMap((el) => (el ? [el.getBoundingClientRect()] : []));
  if (boxes.length === 0) return;
  // The bar may have grown with what was just drawn in it, before its observer has run.
  document.documentElement.style.setProperty("--bar-h", `${bar.getBoundingClientRect().height}px`);
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  // The page's scroll padding keeps clear of the bar and the card at the foot.
  const clear = window.innerHeight - (parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0);
  // Already clear, the page stays where it is: a scroll still under way, to a place chosen
  // before, is stopped, or it would carry this one out of view.
  if (top >= 0 && bottom <= clear) return window.scrollBy({ top: 0, behavior: "instant" });
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const by = bottom - top <= clear ? (top + bottom) / 2 - clear / 2 : top - 8;
  window.scrollBy({ top: by, behavior: still ? "auto" : behavior });
}

/** Shows `text` as the core's words for the place open, announcing it only when it changes. */
function say(text: string): void {
  if (whyWords.textContent !== text) whyWords.textContent = whySaid.textContent = text;
}

/** The card of the place open, if one is: the core's words, and how the note they are of is
 * written from the one before, the step that Hear the step plays. */
function drawCard(): void {
  const spot = openSpot();
  why.hidden = !spot;
  if (!spot) {
    // Closed, it covers nothing: a place brought into view at once need not keep clear of it.
    document.documentElement.style.setProperty("--why-h", "0px");
    return say("");
  }
  const kind = spot.mark ? "mark" : "ending";
  why.setAttribute("aria-label", `The ${kind} open`);
  labelButton(unopenButton, `Close the ${kind}`);
  say(spot.words);
  const { notes } = score.timeline;
  const before = notes[spot.at - 1];
  const at = notes[spot.at];
  // Of a verse not heard there is nothing of the singer's to hear; nor of the note before a run
  // sung again.
  const step = before && at && spot.mark?.kind !== "verse-missing" && !(ofAgain(spot) && spot.at === again?.run[0]);
  // A keyboard on a step going, as at a mark with none, stays in the card.
  if (!step && document.activeElement === stepButton) unopenButton.focus({ preventScroll: true });
  stepButton.hidden = !step;
  const which = !spot.mark ? "That note is written" : spot.first === spot.last ? "Written" : "Its first note is written";
  whyStep.textContent = step ? `${which} ${writtenStep(at.semitones - before.semitones)}.` : "";
  // Measured now, not when the observer next runs, so that a ring brought into view at once
  // keeps clear of it.
  document.documentElement.style.setProperty("--why-h", `${why.getBoundingClientRect().height}px`);
}

/** Where the bands of the take shown lie, as last drawn. */
let strips: { places: Place[]; stripTop: (line: number) => number } | null = null;
/** Where the take is as it plays back: the note it is in (null in a pause, or outside what it
 * plays), and how many seconds into it; null while it is not playing. */
let heardAt: { note: number | null; t: number } | null = null;

/** The playhead's place: across the band of the note the take is in, where in the note it is;
 * none outside the notes, in a pause, or past where the take was judged. */
function playheadAt(): { x: number; top: number } | null {
  const band = heardAt?.note == null ? undefined : heardBands()?.[heardAt.note];
  const p = band && strips?.places[band.index];
  if (!heardAt || !band || !p || !strips) return null;
  return { x: across(p, band, heardAt.t), top: strips.stripTop(p.line) };
}

/** The bands of what plays back, on its own clock: a run sung again's where it plays, else the
 * take's. */
const heardBands = () => (playingBack?.again ? viewed : shown)?.ribbon;

/** The playhead as it is drawn among the strips. */
function playheadSvg(): string {
  const at = playheadAt();
  const [x, top] = at ? [at.x.toFixed(1), at.top] : ["0", 0];
  return `<line class="playhead" visibility="${at ? "visible" : "hidden"}" x1="${x}" x2="${x}" y1="${top + 2}" y2="${top + STRIP - 2}"/>`;
}

/** Moves the playhead to where the take is. */
function drawPlayhead(): void {
  const line = score.host.querySelector<SVGLineElement>(".playhead");
  const at = playheadAt();
  if (!line) return;
  line.setAttribute("visibility", at ? "visible" : "hidden");
  if (!at) return;
  const x = at.x.toFixed(1);
  line.setAttribute("x1", x);
  line.setAttribute("x2", x);
  line.setAttribute("y1", String(at.top + 2));
  line.setAttribute("y2", String(at.top + STRIP - 2));
}

function drawResult(): void {
  drawChosen();
  const judged = shown;
  const key = judged?.verdict.key_cents ?? null;
  result.hidden = !judged;
  drawSummary(judged);
  // A take stopped is judged to the end of the last phrase finished (the ear's `judge_gabc`).
  const total = score.timeline.notes.length;
  const through = judged?.ribbon.length ?? 0;
  cutText.hidden = !judged || cutAt === null || through >= total;
  if (judged && cutAt !== null)
    cutText.textContent =
      through === 0
        ? `You stopped the take at note ${cutAt + 1} of ${total}, before its first phrase was sung through, so there is nothing to judge yet.`
        : `You stopped the take at note ${cutAt + 1} of ${total}, so it is judged through note ${through}, where the last phrase you sang through ended.`;
  listSpots(key === null ? null : viewed);
  drawGrid(key === null ? null : viewed);
  if (!judged || key === null) {
    score.showStrips(null);
    why.hidden = true;
    say("");
    readingText.hidden = true;
    recordedText.hidden = true;
    beforeLine.hidden = true;
    againText.textContent = againHeard.textContent = "";
    saidFor = null;
    inKeyLine.hidden = true;
    keyText.hidden = judged?.ribbon.length === 0;
    if (judged) keyText.textContent = unheard(judged);
    return;
  }
  keyText.hidden = false;
  readingText.hidden = false;
  inKeyLine.hidden = !away(fromGuide(key, shownPitch));
  // The recording is of the chant as the library gave it, so not of another put on the page.
  const underlay = score.source === piece.gabc && recording.length === judged.ribbon.length ? recording : [];
  recordedText.hidden = !underlay.some((b) => b.trace.length > 0);
  const was = before?.of === judged ? before.take : null;
  beforeLine.hidden = !was;
  if (was) beforeWhen.textContent = whenSung(was.at, Date.now());
  // A run sung again is drawn over the take, the take's bands there dotted under it, as the take
  // before is elsewhere.
  const sung = again;
  const view = viewed ?? judged;
  const inRun = (i: number) => sung !== null && i >= sung.run[0] && i <= sung.run[1];
  const faint = [...(was && beforeBox.checked ? was.bands.filter((b) => !inRun(b.index)) : []), ...judged.ribbon.filter((b) => inRun(b.index))];
  const said = sung
    ? [
        `You sang ${runWords(sung.run[0], sung.run[1])} again.`,
        ...sung.judged.summary,
        "Your take’s bars there are dotted under the new ones.",
        ...(sung.replaced.length ? [`Your take is shown again at ${sung.replaced.map(([x, y]) => runWords(x, y)).join(" and ")}, which you sang again before.`] : []),
      ].join(" ")
    : "";
  if (againText.textContent !== said) againText.textContent = said;
  // The hidden line is kept in the page while empty, so that a screen reader hears it each time
  // it is filled: emptied for a new run, and filled a moment later, though its words are the
  // last run's.
  if (sung !== saidFor) {
    againHeard.textContent = "";
    if (said)
      requestAnimationFrame(() => {
        if (again === sung && againText.textContent === said) againHeard.textContent = said;
      });
  }
  saidFor = sung;
  score.showStrips((timeline, room) => {
    strips = { places: places(timeline.notes), stripTop: room.stripTop };
    return (
      // The marks first, so that the keyboard reaches them before the bands; the playhead over
      // the bands.
      drawMarks(timeline.notes, view.verdict.marks, room.shift, open) +
      drawRibbon(timeline.notes, view.ribbon, room.stripTop, 0, loop, bandName, underlay, faint) +
      playheadSvg()
    );
  });
  drawCard();
  // Now that the strips are drawn, the score is as tall as it will be.
  drawOverview();
  keyText.textContent = keyLine(key, shownPitch);
}

/** The run sung again the line beside the take was last drawn for. */
let saidFor: Again | null = null;

/** The take the summary is drawn for, and the place its sentence of endings opened. */
let summarisedFor: Judged | null = null;
let summarisedAt: number | null = null;

/** The core's two sentences of the take; the second, when it tells of endings off pitch, opens
 * the first of them, from which the bar steps to the rest. Drawn once a take, so that the button
 * keeps its focus. */
function drawSummary(judged: Judged | null): void {
  if (judged === summarisedFor && saidAt === summarisedAt) {
    summaryText.querySelector(".said")?.setAttribute("aria-expanded", String(open !== null && open === saidAt));
    return;
  }
  summarisedFor = judged;
  summarisedAt = saidAt;
  const [whole, endings, ...rest] = judged?.summary ?? [];
  const k = saidAt;
  if (endings === undefined || k === null) summaryText.textContent = judged?.summary.join(" ") ?? "";
  else {
    const button = Object.assign(document.createElement("button"), { type: "button", className: "said", textContent: endings });
    button.setAttribute("aria-controls", "why");
    button.setAttribute("aria-describedby", "said-hint");
    saidHint.textContent = (judged?.endings?.length ?? 0) > 1 ? "Opens the first of them." : "Opens it.";
    button.setAttribute("aria-expanded", String(open === k));
    button.addEventListener("click", () => {
      if (open !== k) chooseSpot(k);
      bringIntoView(k);
    });
    summaryText.replaceChildren(...[whole ?? "", " ", button, ...rest.map((r) => ` ${r}`)]);
  }
  summaryText.hidden = !summaryText.textContent;
}
beforeBox.addEventListener("change", () => {
  try {
    localStorage.setItem(BEFORE_KEY, beforeBox.checked ? "on" : "off");
  } catch {
    // Remembered for this page only.
  }
  drawResult();
});

/** Whether `judged` is a take worth keeping, and drawing one kept under: one heard. */
const keepable = (judged: Judged) => judged.verdict.key_cents !== null && judged.ribbon.length > 0;

/** How long a take shown waits for the take kept before it, in seconds: the read begins with the
 * take, so it is long done by then unless the browser's storage is not answering, and the take is
 * not held up for it. */
const KEPT_WAIT = 0.25;

/** The take kept of `gabc` on the notes the page has now, or null when there is none or it could
 * not be read; it never fails. Asked for as a take begins, so that it is found by the time the
 * take is shown and drawn with it, and the score is laid out once. */
async function findKept(gabc: string): Promise<Kept | null> {
  const notes = notesOf(score.timeline.notes);
  try {
    return await kept(await chantKey(gabc), notes);
  } catch {
    // A browser that keeps nothing (a private window may not) shows no take before.
    return null;
  }
}

/** Sets the take before `judged` to what `finding` found, if it has within [`KEPT_WAIT`], and
 * the takes kept have not been forgotten since it was asked for, when they had been forgotten
 * `since` times; one found later is not drawn, as it would move the score drawn without it. */
async function findBefore(judged: Judged, finding: Promise<Kept | null>, since: number): Promise<void> {
  const was = await Promise.race([finding, wait(KEPT_WAIT).then(() => null)]);
  before = was && keepable(judged) && forgettings === since ? { of: judged, take: was } : null;
}

/** Keeps the take just shown, `judged` against `gabc`, as the last of its chant on this device;
 * a take not heard is not kept, nor replaces one. */
async function keepShown(judged: Judged, gabc: string): Promise<void> {
  if (!keepable(judged)) return;
  const take = { at: Date.now(), notes: notesOf(score.timeline.notes), bands: judged.ribbon };
  try {
    await keep(await chantKey(gabc), take);
    sayKept();
  } catch {
    // As above: nothing is kept.
  }
}

/** The foot of the page says takes are kept, and offers to forget them. */
function sayKept(): void {
  keptText.hidden = keptSaid.hidden = false;
  if (forgottenText.textContent) forgottenText.textContent = "";
}

/** The foot of the page says the takes kept are forgotten, in place of saying they are kept, and
 * no take before is drawn. */
function sayForgotten(): void {
  forgettings++;
  before = null;
  keptSaid.hidden = true;
  if (forgottenText.textContent !== FORGOTTEN) forgottenText.textContent = FORGOTTEN;
}

// Once any take is kept, the foot of the page says so.
void anyKept().then(
  (any) => {
    if (any) sayKept();
  },
  () => {},
);

/** Does `change`, which may show or hide a line above the score, keeping `el` where it was on the
 * screen, as a browser that anchors scrolling would. */
function keeping(el: Element, change: () => void): void {
  const at = el.getBoundingClientRect().top;
  change();
  const moved = el.getBoundingClientRect().top - at;
  if (moved !== 0) window.scrollBy(0, moved);
}

forgetButton.addEventListener("click", () => {
  void forget().then(
    () =>
      // The button stays under the finger, with the focus, as the line above the score goes.
      keeping(forgetButton, () => {
        sayForgotten();
        drawResult();
      }),
    () => {
      // Forgotten already, they still are; else the foot says so in place of saying they are kept.
      if (forgottenText.textContent === FORGOTTEN) return;
      keptSaid.hidden = true;
      forgottenText.textContent = "Your takes could not be forgotten.";
    },
  );
});
// Forgotten in another tab, the take before is no longer drawn here either; kept in another,
// the foot says so again.
onNews((news) => {
  if (news === "kept") return sayKept();
  const drawn = before !== null;
  sayForgotten();
  if (drawn) steadily(drawResult);
});

// The guide sings anew from where it is next played; the take and the recording, each in its own
// key, play on.
inKeyBox.addEventListener("change", () => {
  if (playing && playing.button !== hearButton && playing.button !== recordingButton) stopPlay();
});

// A take shown may be sent, by a signed-in singer: the button gives a link to it.
const sendLine = byId<HTMLParagraphElement>("send-line");
const sendButton = byId<HTMLButtonElement>("send");
const sentText = byId<HTMLSpanElement>("sent");
const known = signedIn();
/** The take shown, as it would be sent (judged against `gabc`, at `pulse` seconds a pulse,
 * its first note at `offset`), until it is sent or another is shown. */
interface ToSend {
  gabc: string;
  pulse: number;
  offset: number;
  judged: Judged;
}
let toSend: ToSend | null = null;
/** Whether a take is being sent. */
let sending = false;

/** Offers to send the take just shown. */
function offerSend(take: ToSend): void {
  offerReplay(take);
  toSend = take;
  void known.then((yes) => {
    if (toSend === take) sendLine.hidden = !yes;
  });
}

/** Keeps the page on this chant, or lets another be found. */
function holdChant(on: boolean): void {
  find.disabled = on;
  drawFound();
}

/** Holds a new take and the chant while the take being sent is read from the ear, which
 * keeps only the last take, or lets them go. */
function holdTake(on: boolean): void {
  takeButton.disabled = on || !guide;
  holdChant(on);
}

sendButton.addEventListener("click", () => {
  const take = toSend;
  // A take under way holds the page; a run sung again leaves the take shown, and Send with it.
  if (!take || sending || taking) return;
  sendButton.disabled = true;
  sentText.textContent = "Sending…";
  sending = true;
  holdTake(true);
  const audio = wavOfTake();
  void audio.finally(() => holdTake(false)).catch(() => {});
  const link = audio.then(({ wav, seconds }) => {
    const { gabc, pulse, offset, judged } = take;
    return sendTake(wav, { slug: piece.slug, title: piece.title, gabc, pulse, offset, seconds, judged });
  });
  const copied = copyWhenReady(link);
  link.then(
    async (url) => {
      const done = await copied;
      sending = false;
      const told = done ? "Link copied. Anyone with it can hear this take: " : "Send this link; anyone with it can hear this take: ";
      // A take no longer shown still gets its link, in the status line.
      if (toSend !== take) return setStatus(`${told}${url}`, true);
      toSend = null;
      sendButton.hidden = true;
      const a = document.createElement("a");
      a.href = a.textContent = url;
      sentText.replaceChildren(told, a);
    },
    (error: unknown) => {
      sending = false;
      const why = `The take could not be sent: ${error instanceof Error ? error.message : String(error)}`;
      // During a take Send waits, and the status is the take's; the take shown is told beside Send.
      if (toSend === take) {
        sendButton.disabled = taking;
        sentText.textContent = taking ? why : "";
      }
      if (!taking || toSend !== take) setStatus(why);
    },
  );
});

/** Shows a judged take, stopped by the singer at note `cut` if it was and sung with the guide
 * in headphones if `worn`, or clears it. */
function showResult(judged: Judged | null, cut: number | null = null, worn = false): void {
  if (!judged) offerReplay(null);
  // A run chosen before the take, or beside another, is let go: Yours plays the take whole
  // until a phrase of it is chosen.
  shown = viewed = judged;
  again = null;
  spots = spotsOf(judged);
  saidAt = saidOf(judged);
  if (judged && loop) setLoop(null);
  cutAt = judged ? cut : null;
  shownWorn = worn;
  // Pitch cannot change during a take, so it is the take's.
  shownPitch = judged ? Number(pitchSelect.value) : 0;
  setOpen(null);
  lastOpen = null;
  toSend = null;
  sendLine.hidden = true;
  sendButton.hidden = sendButton.disabled = false;
  sentText.textContent = "";
  // The ribbon says what was heard; the length of the take is no longer news (anything else
  // the status says stays).
  if (judged && status.textContent === heardLine) setStatus("");
  drawResult();
}

/** Does `change`, which may show or hide a line above the score, keeping the score where it
 * was on the screen. */
function steadily(change: () => void): void {
  const before = score.host.getBoundingClientRect().top;
  change();
  const moved = score.host.getBoundingClientRect().top - before;
  if (moved !== 0) window.scrollBy(0, moved);
}

// Tapping a mark opens its card and chooses the phrase it is in; tapping it again closes the card.
// Tapping a note's band chooses its phrase, as tapping the note does; while the take plays back,
// a band of a note it plays tapped plays it from there instead.
function tap(target: EventTarget | null, keyboard: boolean, clientX?: number): boolean {
  if (!shown) return false;
  const el = target as Element | null;
  const mark = el?.closest<SVGGElement>("[data-mark]");
  const band = el?.closest<SVGGElement>("[data-band]");
  let again: string;
  if (mark) {
    const k = Number(mark.dataset.mark);
    steadily(() => toggleSpot(k));
    again = `[data-mark="${k}"]`;
  } else if (band && !taking) {
    const index = Number(band.dataset.band);
    if (seek(index, band, keyboard ? undefined : clientX)) return true;
    steadily(() => choose(index));
    again = `[data-band="${index}"]`;
  } else {
    return false;
  }
  // The strips were drawn again; keep a keyboard's place, and the mark in view above its card.
  const now = score.host.querySelector<SVGGElement>(again);
  if (keyboard) now?.focus({ preventScroll: true });
  if (mark && open !== null) bringIntoView(Number(mark.dataset.mark));
  return true;
}
score.host.addEventListener("click", (e) => {
  if (!tap(e.target, false, e.clientX)) tapScore(e);
});

/** While the take plays back, plays it on from note `index`, if it plays it: from the moment
 * at `clientX` across the note's band `band`, or with none (a keyboard) from the note's start.
 * False when the take is not playing that note. */
function seek(index: number, band: Element, clientX: number | undefined): boolean {
  const notes = replay.notes;
  const heard = heardBands()?.[index];
  const p = strips?.places[index];
  if (!replay.playing || !notes || index < notes[0] || index > notes[1] || !heard || !p) return false;
  const hit = band.querySelector(".band-hit")?.getBoundingClientRect();
  const t =
    clientX !== undefined && hit && hit.width > 0
      ? secondAt(p, heard, p.left + ((clientX - hit.left) / hit.width) * (p.right - p.left))
      : span(heard)[0];
  replay.seek(t);
  return true;
}
score.host.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && tap(e.target, true)) return e.preventDefault();
  // The arrows move along the bands, one tab stop among them.
  const band = (e.target as Element | null)?.closest<SVGGElement>("[data-band]");
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!band || !step || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  const to = Number(band.dataset.band) + step;
  score.host.querySelector<SVGGElement>(`[data-band="${to}"]`)?.focus();
});

/** Opens place `k`, choosing what Compare, Guide and Yours play there: a mark's phrase or
 * phrases, an ending's own notes; what plays goes on if they were chosen already. */
function chooseSpot(k: number): void {
  const spot = spots[k];
  if (!spot) return;
  if (taking || !guide) {
    setOpen(k);
    return drawResult();
  }
  const run = spot.mark ? runOf(spot, score.timeline.pauses, score.timeline.notes.length) : ([spot.first, spot.last] as [number, number]);
  if (!loop || loop[0] !== run[0] || loop[1] !== run[1]) stopPlay();
  setLoop(run, k);
}

/** Opens place `k`, or closes it, leaving what it chose chosen. */
function toggleSpot(k: number): void {
  if (open !== k) return chooseSpot(k);
  setOpen(null);
  drawResult();
}

/** The place the steps go on from: the one open, or the one last opened while the run chosen
 * still holds it; else none, and they go from the run chosen. */
function stepFrom(): number | null {
  if (open !== null) return open;
  const last = lastOpen === null ? undefined : spots[lastOpen];
  return last && loop && last.first >= loop[0] && last.last <= loop[1] ? lastOpen : null;
}

/** Opens the place before or after the one open (or last opened, or the run chosen), in the
 * order sung, brought into view. */
function stepSpot(by: 1 | -1): void {
  const k = stepTo(spots, stepFrom(), loop, by);
  if (k === null) return;
  chooseSpot(k);
  bringIntoView(k);
}

const readout = byId<HTMLOutputElement>("readout");
const status = byId<HTMLParagraphElement>("status");
/** Shows `text` in the status line: as an error, or quietly when it is `news` and nothing
 * has gone wrong. */
function setStatus(text: string, news = false): void {
  status.textContent = text;
  status.classList.toggle("error", !news && text !== "");
}
/** What the status said of the last take heard. */
let heardLine = "";
/** What Your take says of a phrase past where the take was stopped, until another is chosen
 * or a take heard. */
const NONE_HEARD = "You stopped the take before this phrase, so there is none of it to hear.";
/** What Compare says of a take stopped before anything of it was judged. */
const NONE_JUDGED = "You stopped the take before its first phrase was sung through, so there is nothing to compare yet.";
/** Lets go of what the status says of what there is none of to hear, once it may be heard. */
function quieten(): void {
  if (status.textContent === NONE_HEARD || status.textContent === NONE_JUDGED) setStatus("");
}
/** What the status says of a recording that could not be had, before why. */
const UNPLAYED = "The recording could not be played";
/** What the status says while the recording's sound is first fetched, over what it said, which
 * it says again once the sound comes or the play is stopped. */
const FETCHING = "Fetching the recording…";
let saidBeforeFetching: { text: string; news: boolean } | null = null;
function unsayFetching(): void {
  const said = saidBeforeFetching;
  saidBeforeFetching = null;
  if (said && status.textContent === FETCHING) setStatus(said.text, said.news);
}
const failedListening = (error: unknown) =>
  setStatus(`Listening failed: ${error instanceof Error ? error.message : String(error)}`);
/** Counts takes, so a take stopped while it is starting does not go on. */
let takes = 0;
let taking = false;
const listener = new Listener(
  (frame) => {
    // Frames flushed after a stop are not live.
    if (!listener.listening) return;
    // During a take the readout says only the note, quietly: the cents from concert pitch
    // would read as a verdict, and the singer's key is their own.
    const text = frame.midi === null ? "–" : taking ? noteName(frame.midi) : describePitch(frame.midi);
    if (readout.textContent !== text) readout.textContent = text;
  },
  (error) => {
    // A take that cannot be heard is over.
    if (taking) stopTake();
    failedListening(error);
  },
);
/** Listens freely, unscored, or stops; the tests hear the microphone this way. A take is the
 * page's one way to sing and be heard. */
async function toggleListening(): Promise<void> {
  if (listener.listening) {
    listener.stop();
    listener.heard?.then(
      (h) => setStatus((heardLine = `Heard ${h.seconds.toFixed(1)} s.`), true),
      failedListening,
    );
    return;
  }
  showResult(null);
  try {
    await listener.start();
  } catch (error) {
    readout.textContent = error instanceof Error ? error.message : String(error);
  }
}

// Play (disabled in the page) waits for the voice; without one the guide stays off, and so
// does a take, which it leads.
const playButton = byId<HTMLButtonElement>("play");
const failed = (error: unknown) => {
  console.error("guide voice:", error);
  return undefined;
};
const recorded = voiceUrl ? await VoiceTable.load(voiceUrl).catch(failed) : undefined;
const table = recorded ?? (await neutralTable().catch(failed));
const guide =
  table &&
  new Guide(score, cursor, {
    table,
    gabc: piece.gabc,
    clock: test ? () => performance.now() / 1000 : undefined,
    // A loop between times round, or a play about to end, keeps Play pressed (see `play`).
    onStop: () => {
      if (playing === null) playButton.setAttribute("aria-pressed", "false");
    },
    onError: (message) =>
      setStatus(
        !taking ? message : singingAgain ? "The guide voice failed, so it was stopped; your take is as it was." : "The guide voice failed, so the take was stopped.",
      ),
  });
// Start note sounds the opening notes a take without headphones is given (`cueNotes`), to
// find the pitch before singing; Play and it each stop the other.
const noteButton = byId<HTMLButtonElement>("note");
/** The starting pitch, while it sounds. */
let pitching: Singing | null = null;
/** Counts presses of Start note, so one pressed again while it is starting does not go on. */
let pitches = 0;

function stopPitch(): void {
  pitches++;
  pitching?.stop();
  pitching = null;
  noteButton.setAttribute("aria-pressed", "false");
}

async function soundPitch(): Promise<void> {
  if (!guide || !table) return;
  stopPlay();
  stopPitch();
  const press = pitches;
  noteButton.setAttribute("aria-pressed", "true");
  if (status.classList.contains("error")) setStatus("");
  const noteFailed = (error: unknown) => {
    console.error("start note:", error);
    if (press !== pitches) return;
    stopPitch();
    setStatus(`The starting pitch could not be sung: ${error instanceof Error ? error.message : String(error)}`);
  };
  try {
    const ctx = await audioContext();
    if (press !== pitches) return;
    const cue = await sing(ctx, cueNotes(guide.notes()), { table, gabc: score.source, onError: noteFailed });
    if (press !== pitches) return cue.stop();
    pitching = cue;
    await wait(cue.end - ctx.currentTime);
    if (press === pitches) stopPitch();
  } catch (error) {
    noteFailed(error);
  }
}

// Drone holds the reciting note (droneNote) under Play, Start note or the singer's own
// practice, until it is pressed again or a take begins.
const droneButton = byId<HTMLButtonElement>("drone");
let drone: Drone | null = null;
/** Counts presses of Drone, so one pressed again while it is starting does not go on. */
let drones = 0;

function stopDrone(fade = true): void {
  drones++;
  drone?.stop(fade);
  // Before a take, a drone still fading is cut too.
  if (!fade) Drone.cutAll();
  drone = null;
  droneButton.setAttribute("aria-pressed", "false");
  letSleep("drone");
}

async function startDrone(): Promise<void> {
  if (!guide) return;
  const press = ++drones;
  droneButton.setAttribute("aria-pressed", "true");
  stayAwake("drone");
  try {
    const ctx = await audioContext();
    if (press !== drones) return;
    const { notes, pauses } = score.timeline;
    // The chant's body ends at its first double bar, before any verse and repeat cue.
    const double = pauses.find((p) => p.kind === "double");
    const sung = guide.notes();
    const mode = summarize(score.source).mode?.number ?? modeNumber(piece.mode);
    const midi = droneNote(
      notes.map((n, i) => ({ semitones: n.semitones, midi: sung[i]!.midi, recitation: n.recitation })),
      mode !== null && mode >= 1 && mode <= 8 ? mode : null,
      double ? double.beforeNote - 1 : notes.length - 1,
    );
    if (midi === null) return stopDrone();
    drone = new Drone(ctx, midi);
  } catch (error) {
    if (press !== drones) return;
    stopDrone();
    setStatus(`The drone could not sound: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Speed and Pitch set the guide's pulse and transposition, so the voice, the cursor, a take's
// timing, Start note and Drone all follow them; the clef's do is named when it moves. They
// are kept in the address, and so in the links to the chants found.
const speedSelect = byId<HTMLSelectElement>("speed");
/** The clef's do moved by 0 to 11 semitones, spelled as a singer would read the key. */
const DO_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const pitchSelect = byId<HTMLSelectElement>("pitch");
const doText = byId<HTMLSpanElement>("do");
for (let s = -7; s <= 7; s++) {
  const label = s === 0 ? "As written" : `${s > 0 ? "+" : "−"}${Math.abs(s)} semitone${Math.abs(s) === 1 ? "" : "s"}`;
  pitchSelect.add(new Option(label, String(s)));
}
const askedSpeed = params.get("speed");
if ([...speedSelect.options].some((o) => o.value === askedSpeed)) speedSelect.value = askedSpeed!;
const askedPitch = Number(params.get("pitch") ?? 0);
pitchSelect.value = String(Number.isInteger(askedPitch) && Math.abs(askedPitch) <= 7 ? askedPitch : 0);

function applyTempo(): void {
  const pulse = Number(speedSelect.value);
  const transpose = Number(pitchSelect.value);
  if (guide) {
    guide.pulse = pulse;
    guide.transpose = transpose;
  }
  doText.hidden = transpose === 0;
  doText.textContent = `The clef’s do is ${DO_NAMES[(transpose + 12) % 12]}.`;
  if (pulse === PULSE) params.delete("speed");
  else params.set("speed", speedSelect.value);
  if (transpose === 0) params.delete("pitch");
  else params.set("pitch", String(transpose));
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  // The chants found lead to their practice at this speed and pitch.
  drawFound();
}
applyTempo();
for (const select of [speedSelect, pitchSelect]) {
  select.addEventListener("change", () => {
    // What is sounding was set going at the old speed and pitch; Start note and a drone have
    // no speed.
    stopPlay();
    if (select === pitchSelect) stopPitch();
    const retune = select === pitchSelect && droneButton.getAttribute("aria-pressed") === "true";
    applyTempo();
    if (retune) {
      stopDrone();
      void startDrone();
    }
  });
}

// A loop: tapping a note or its syllable plays its phrase, between divisions (loop.ts), over and
// over, the cursor following; tapping another phrase stretches the loop to it, a bar loops the
// phrase it ends, and a tap in the loop narrows it, to the phrase, between breaths, then to a
// neume of a melisma, until nothing narrower is left and it lets the loop go, as Whole chant
// does. Beside a take the run chosen is played once, by Compare, Guide or Yours, or by Repeat
// over and over.
const loopText = byId<HTMLSpanElement>("loop-text");
const unloopButton = byId<HTMLButtonElement>("unloop");
// Beside a take, the bar names the place open or the run chosen, steps from place to place, and
// lets the run go.
const chosenLine = byId<HTMLDivElement>("chosen");
const chosenText = byId<HTMLSpanElement>("chosen-text");
const prevButton = byId<HTMLButtonElement>("prev");
const nextButton = byId<HTMLButtonElement>("next");
const unchooseButton = byId<HTMLButtonElement>("unchoose");
const loopStyle = document.head.appendChild(document.createElement("style"));
// The bar's height, which the chosen line or a second row of buttons changes, and the card's
// over it, for what must stay clear of them (the card itself, the foot of the score, a ring
// brought into view).
const bar = document.querySelector<HTMLElement>(".bar")!;
const measure = (el: HTMLElement, name: string) =>
  new ResizeObserver(() => document.documentElement.style.setProperty(name, `${el.getBoundingClientRect().height}px`)).observe(el);
measure(bar, "--bar-h");
measure(why, "--why-h");
let loop: [number, number] | null = null;
/** The neumes of the chant's melismas and its syllables, and the chant they are of. */
let neumes: { of: string; at: ReturnType<typeof melismaNeumes>; syllables: ReturnType<typeof syllableRuns> } | null = null;
/** The pause between times round a loop, and in Compare between the guide and the take, in
 * pulses. */
const BREATH = 2;

/** Chooses the run `next` to play, or none, with mark `mark` open in it, or none. */
function setLoop(next: [number, number] | null, mark: number | null = null): void {
  loop = next;
  setOpen(mark);
  // The steps go on from a mark closed only while the run it chose holds.
  if (mark === null) lastOpen = null;
  quieten();
  const [a, b] = next ?? [0, -1];
  const ids = score.timeline.notes.slice(a, b + 1).map((n) => n.id);
  // A rule rather than classes on the ink, so the run stays marked when the score is drawn again.
  // Tinted lighter than the cursor's note, so it stands out within it, and not in a take; beside
  // a take's result its bands are tinted too.
  const free = "body:not(.taking) #score";
  const bands = Array.from({ length: ids.length }, (_, k) => `[data-band="${a + k}"] .band-hit`).join(",");
  loopStyle.textContent = ids.length
    ? `${free} :is(${ids.map((id) => `[data-note~="${id}"]`).join(",")}):not(.cantor-current){fill:color-mix(in srgb, var(--rubric) 50%, var(--bg))}` +
      `${free} :is(${bands}){fill:color-mix(in srgb, var(--rubric) 10%, transparent)}`
    : "";
  unloopButton.hidden = !next;
  const narrows = next !== null && Array.from({ length: b - a + 1 }, (_, k) => tapped(next, a + k)).some(Boolean);
  loopText.textContent = next
    ? `Play goes over notes ${a + 1} to ${b + 1} until you stop it.${narrows ? " Tap a note in it to play less of it." : ""}`
    : "Tap a phrase or a bar on the score to play it over and over.";
  // Beside a take, its bands say which are chosen, and the card which mark is open.
  if (shown) drawResult();
  else drawChosen();
}

/** The bar's line beside a take shown: the place open, as a mark among the marks or an ending
 * among the endings, in the order sung; or the run chosen; or the whole chant and how many of
 * each it has; with the steps to the place before and after. */
function drawChosen(): void {
  drawOverview();
  const run = taking ? null : againRun();
  // What Sing again sings, when it is more than the run chosen ([`grown`]).
  // The bar says it in short, so that it stays low on a phone; the button's title and the status
  // as it is sung say why.
  const grows = run && loop && (run[0] !== loop[0] || run[1] !== loop[1]) && shown ? run : null;
  const more = grows ? `Sing again sings ${numbered(...grows).toLowerCase()}` : "";
  if (!taking && guide) {
    takeButton.textContent = run ? "Sing again" : "Sing a take";
    takeButton.title =
      grows && loop && shown
        ? `${more}, ${grewOver(shown, loop)}, in the key you sang them in, to see them over your take`
        : run
          ? "Sing the notes chosen again, in the key you sang them in, to see them over your take"
          : "";
  }
  chosenLine.hidden = !shown || taking || (!loop && spots.length === 0);
  if (chosenLine.hidden || !shown) return;
  // Kept in its place while there is no run to let go, so that the steps do not move under a
  // finger stepping on.
  unchooseButton.style.visibility = loop ? "" : "hidden";
  prevButton.hidden = nextButton.hidden = spots.length === 0;
  // Named for what they step among.
  const among = spots.every((s) => s.mark) ? "mark" : spots.some((s) => s.mark) ? "mark or ending" : "ending";
  labelButton(prevButton, `Previous ${among}`);
  labelButton(nextButton, `Next ${among}`);
  // At either end the step is off but keeps the keyboard.
  prevButton.setAttribute("aria-disabled", String(stepTo(spots, stepFrom(), loop, -1) === null));
  nextButton.setAttribute("aria-disabled", String(stepTo(spots, stepFrom(), loop, 1) === null));
  const spot = open === null ? undefined : spots[open];
  const quoted = (a: number, b: number) => {
    const sung = ends(a, b);
    return sung ? ` · ${sung}` : "";
  };
  let text: string;
  if (spot && open !== null) {
    // Its place among those of its kind.
    const kind = sungOrder(spots).filter((k) => !spots[k]!.mark === !spot.mark);
    text = `${spot.mark ? "Mark" : "Ending"} ${kind.indexOf(open) + 1} of ${kind.length}${quoted(spot.first, spot.last)}`;
  } else if (loop) {
    const [a, b] = loop;
    // A take stopped short is judged, and heard, only so far.
    const sungAgain = again && again.run[0] === a && again.run[1] === b ? " · sung again" : "";
    text = `${numbered(a, b)}${quoted(a, b)}${a >= shown.ribbon.length ? " · after your take stopped" : sungAgain}${more ? ` · ${more}` : ""}`;
  } else {
    const marks = spots.filter((s) => s.mark).length;
    const endings = spots.length - marks;
    const many = (n: number, what: string) => (n ? [` · ${n} ${what}${n === 1 ? "" : "s"}`] : []);
    text = ["Whole chant", ...many(marks, "mark"), ...many(endings, "ending")].join("");
  }
  // Announced only when it changes.
  if (chosenText.textContent !== text) chosenText.textContent = text;
}

// A long chant's phrases in the bar beside a take, to go to one at a tap, or along them in a drag.
const overview = byId<HTMLDivElement>("overview");
/** The note the keyboard was put on in the strip, the first of the segment it was put on, kept
 * while the segments it goes to as the strip is made again hold it. */
let keyboardNote: number | null = null;
const within = ([a, b]: readonly [number, number], i: number) => a <= i && i <= b;
overview.addEventListener("focusin", (e) => {
  const run = e.target instanceof HTMLButtonElement ? runOfSegment(e.target) : null;
  if (run && (keyboardNote === null || !within(run, keyboardNote))) keyboardNote = run[0];
});
/** The fewest phrases a chant has for the overview to be drawn. */
const OVERVIEW_PHRASES = 3;
/** The narrowest a segment is drawn, in CSS pixels: past as many as fit, each is of several
 * phrases together. */
const SEGMENT_PX = 12;
/** The take, the chant and the runs the overview's segments were made for. */
let overviewOf: { judged: Judged; source: string; runs: string } | null = null;

/** The chant's phrases, from division to division (loop.ts `phraseOf`). */
function phrases(): Array<[number, number]> {
  const { notes, pauses } = score.timeline;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < notes.length; ) {
    const run = phraseOf(i, pauses, notes.length);
    out.push(run);
    i = run[1] + 1;
  }
  return out;
}

/** The runs of the overview's segments, across `width` pixels with `gap` between them: a
 * phrase each, or where more phrases than fit, as many segments as fit, the phrases shared
 * among them as evenly as they go. */
function segmentRuns(all: ReadonlyArray<[number, number]>, width: number, gap: number): Array<[number, number]> {
  const fit = Math.max(1, Math.floor((width + gap) / (SEGMENT_PX + gap)));
  const count = Math.min(all.length, fit);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < count; k++) {
    const [from, to] = [Math.floor((k * all.length) / count), Math.floor(((k + 1) * all.length) / count) - 1];
    out.push([all[from]![0], all[to]![1]]);
  }
  return out;
}

/** The overview, beside a heard take of a chant of [`OVERVIEW_PHRASES`] phrases or more whose
 * score is taller than the window, while no card is open (the card is of one place; the strip is
 * to go elsewhere): a segment a phrase (or a few, where they would not all fit), as wide as its
 * notes are many, named by its words and ticked at the note each place the core tells of is
 * shown at; those in the run chosen current. The one tab stop is the segment with the keyboard,
 * else the first current one, else the first. Made again only for another take, chant or width,
 * and then the keyboard goes to the segment of the run it was on. */
function drawOverview(): void {
  const all = shown && !taking && shown.verdict.key_cents !== null && why.hidden ? phrases() : [];
  overview.hidden = all.length < OVERVIEW_PHRASES || score.host.getBoundingClientRect().height <= window.innerHeight;
  if (overview.hidden || !shown) {
    overviewOf = null;
    return overview.replaceChildren();
  }
  const focused = segments().find((b) => b === document.activeElement);
  const focusedRun = focused ? runOfSegment(focused) : null;
  // The keyboard goes to the segment with the note it was put on, so that a narrower strip and a
  // wider one again bring it back where it was.
  const keyboardAt = focusedRun && keyboardNote !== null && within(focusedRun, keyboardNote) ? keyboardNote : focusedRun?.[0];
  const runs = segmentRuns(all, overview.clientWidth, parseFloat(getComputedStyle(overview).columnGap) || 0);
  const made = runs.map(([a, b]) => `${a}-${b}`).join(" ");
  if (overviewOf?.judged !== viewed || overviewOf.source !== score.source || overviewOf.runs !== made) {
    overviewOf = { judged: viewed ?? shown, source: score.source, runs: made };
    const phraseAt = new Map(all.map(([a], n) => [a, n + 1]));
    const lastAt = new Map(all.map(([, b], n) => [b, n + 1]));
    overview.replaceChildren(
      ...runs.map(([a, b]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.run = `${a}-${b}`;
        button.style.flexGrow = String(b - a + 1);
        button.style.minWidth = `${SEGMENT_PX}px`;
        const words = wordsOf(a, b);
        const [first, last] = [phraseAt.get(a)!, lastAt.get(b)!];
        const ks = sungOrder(spots).filter((k) => spots[k]!.at >= a && spots[k]!.at <= b);
        const name = first === last ? `Phrase ${first}` : `Phrases ${first} to ${last}`;
        button.setAttribute("aria-label", `${name}${words ? `, “${words}”` : ""}${ks.length ? `, ${counted(ks)}` : ""}`);
        button.title = words;
        button.append(words);
        for (const k of ks) {
          const tick = Object.assign(document.createElement("span"), { className: spots[k]!.mark ? "tick" : "tick ending" });
          tick.style.left = `${(((spots[k]!.at - a + 0.5) / (b - a + 1)) * 100).toFixed(1)}%`;
          button.append(tick);
        }
        return button;
      }),
    );
  }
  const buttons = segments();
  const over = (button: HTMLButtonElement, [a, b]: readonly [number, number]) => {
    const [c, d] = runOfSegment(button);
    return a <= d && b >= c;
  };
  const current = buttons.map((button) => loop !== null && over(button, loop));
  const keyboard = keyboardAt === undefined ? -1 : buttons.findIndex((button) => within(runOfSegment(button), keyboardAt));
  const stop = keyboard >= 0 ? keyboard : Math.max(current.indexOf(true), 0);
  buttons.forEach((button, i) => {
    if (current[i]) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
    button.tabIndex = i === stop ? 0 : -1;
  });
  if (focusedRun && buttons[stop] !== document.activeElement) buttons[stop]?.focus({ preventScroll: true });
}
// Whether the score is taller than the window changes as either does; the strip shown or hidden
// changes the bar, measured after it.
window.addEventListener("resize", () => drawOverview());
new ResizeObserver(() => requestAnimationFrame(() => drawOverview())).observe(score.host);

/** The overview's segments, in order. */
function segments(): HTMLButtonElement[] {
  return [...overview.querySelectorAll<HTMLButtonElement>("[data-run]")];
}

/** The run of phrases segment `button` of the overview stands for. */
function runOfSegment(button: HTMLElement): [number, number] {
  const [a, b] = button.dataset.run!.split("-").map(Number);
  return [a!, b!];
}

/** Brings the start of segment `button`'s run into view. */
function revealSegment(button: HTMLElement, behavior: "smooth" | "auto"): void {
  const [a] = runOfSegment(button);
  const note = score.timeline.notes[a];
  reveal([note ? (score.ink(note.id)[0] ?? null) : null, score.host.querySelector(`[data-band="${a}"]`)], behavior);
}

/** Chooses the run of segment `button`, unless it is chosen already, and brings its start into
 * view. */
function goTo(button: HTMLElement, behavior: "smooth" | "auto"): void {
  if (taking || !guide) return;
  const [a, b] = runOfSegment(button);
  if (!loop || loop[0] !== a || loop[1] !== b) {
    stopPlay();
    setLoop([a, b]);
  }
  revealSegment(button, behavior);
}
overview.addEventListener("click", (e) => {
  const button = (e.target as Element | null)?.closest<HTMLButtonElement>("[data-run]");
  if (button) goTo(button, "smooth");
});
// The arrows move along the segments, Home and End to the first and last, one tab stop among them.
overview.addEventListener("keydown", (e) => {
  const buttons = segments();
  const at = buttons.indexOf(e.target as HTMLButtonElement);
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: buttons.length - 1 }[e.key];
  if (to === undefined || at < 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  const button = buttons[to];
  if (!button) return;
  buttons[at]!.tabIndex = -1;
  button.tabIndex = 0;
  button.focus();
});
// A drag along the overview shows each segment it passes and brings it into view, and chooses
// the one it ends on, so that the score is drawn again once; a tap is a click.
let dragging: { id: number; x: number; moved: boolean; at: HTMLButtonElement | null } | null = null;
overview.addEventListener("pointerdown", (e) => {
  if (e.button === 0) dragging = { id: e.pointerId, x: e.clientX, moved: false, at: null };
});
overview.addEventListener("pointermove", (e) => {
  if (!dragging || dragging.id !== e.pointerId) return;
  // A press let go away from the page ended there.
  if ((e.buttons & 1) === 0) return endDrag(null);
  if (!dragging.moved) {
    if (Math.abs(e.clientX - dragging.x) < 6) return;
    dragging.moved = true;
    overview.setPointerCapture(e.pointerId);
  }
  const button = segments().find((b) => {
    const box = b.getBoundingClientRect();
    return e.clientX >= box.left && e.clientX < box.right;
  });
  if (!button || button === dragging.at) return;
  dragging.at?.classList.remove("passing");
  dragging.at = button;
  button.classList.add("passing");
  revealSegment(button, "auto");
});
/** Ends the drag under way, choosing the segment it ended on if it was let go there (`ended`),
 * and moving the keyboard there if it was in the overview. */
function endDrag(ended: PointerEvent | null): void {
  const drag = dragging;
  if (!drag || (ended && ended.pointerId !== drag.id)) return;
  dragging = null;
  drag.at?.classList.remove("passing");
  if (!ended || ended.type !== "pointerup" || !drag.moved || !drag.at) return;
  const keyboard = overview.contains(document.activeElement);
  // A touch that moves less than the browser's slop is still a tap to it, and its click would
  // land on whatever the bar, drawn again, now has under the finger.
  afterDrag = true;
  // The keyboard first, so that the segment chosen is the tab stop as it is drawn.
  if (keyboard) drag.at.focus({ preventScroll: true });
  goTo(drag.at, "auto");
}
// Let go anywhere: off the overview, a press does not go on as a drag.
window.addEventListener("pointerup", (e) => endDrag(e));
window.addEventListener("pointercancel", (e) => endDrag(e));
/** Whether the click that may follow a drag just chosen is to be let fall. */
let afterDrag = false;
window.addEventListener("pointerdown", () => (afterDrag = false), true);
window.addEventListener(
  "click",
  (e) => {
    if (!afterDrag) return;
    afterDrag = false;
    // Only a click a press sends; one from a key, a script or assistive technology goes through.
    if (e.detail === 0) return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

prevButton.addEventListener("click", () => {
  if (prevButton.getAttribute("aria-disabled") !== "true") stepSpot(-1);
});
nextButton.addEventListener("click", () => {
  if (nextButton.getAttribute("aria-disabled") !== "true") stepSpot(1);
});
unloopButton.addEventListener("click", () => {
  if (taking) return;
  stopPlay();
  setLoop(null);
});
unchooseButton.addEventListener("click", () => {
  if (taking) return;
  stopPlay();
  // The button goes; the keyboard stays in the bar.
  (hearButton.hidden ? playButton : hearButton).focus();
  setLoop(null);
});
unopenButton.addEventListener("click", () => {
  if (open === null && !cellOpen) return;
  const k = open;
  const byCell = openedByCell;
  setOpen(null);
  drawResult();
  // A place a cell opened: the keyboard goes back to the cell, brought into view if the card or
  // the bar covered it.
  if (byCell || k === null) {
    const cell = runButton(gridAt);
    (cell ?? nextButton).focus({ preventScroll: true });
    return reveal([cell], "smooth");
  }
  // The keyboard goes back to the place on the score: a mark's ring, or the band of an ending's
  // note off.
  const spot = spots[k];
  const on = spot && score.host.querySelector<SVGGElement>(spot.mark ? `[data-mark="${k}"]` : `[data-band="${spot.at}"]`);
  (on ?? nextButton).focus({ preventScroll: true });
});

/** The note a tap on the score means: a note's ink, a syllable's first note, or the last note
 * before a bar tapped; -1 for none. */
function tappedNote(e: MouseEvent): number {
  const { notes, pauses } = score.timeline;
  const el = e.target as Element | null;
  const ink = el?.closest("[data-note]");
  if (ink) {
    const id = Number(ink.getAttribute("data-note")!.split(" ")[0]);
    return notes.findIndex((n) => n.id === id);
  }
  const syllable = el?.closest("[data-syllable]");
  if (syllable) return notes.findIndex((n) => n.syllable === Number(syllable.getAttribute("data-syllable")));
  const box = score.host.getBoundingClientRect();
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  const bar = pauses.find((p) => {
    if (!p.bar) return false;
    const line = score.line(p.bar.line);
    return Math.abs(x - p.bar.cx) <= 12 && y >= line.top && y <= line.bottom;
  });
  return bar ? bar.beforeNote - 1 : -1;
}

function tapScore(e: MouseEvent): void {
  const i = tappedNote(e);
  if (i >= 0) choose(i);
}

/** The run a tap on note `i` chooses with `run` chosen (`tapLoop`). */
function tapped(run: readonly [number, number] | null, i: number): [number, number] | null {
  const { notes, pauses } = score.timeline;
  if (neumes?.of !== score.source) neumes = { of: score.source, at: melismaNeumes(notes, score.source, pauses), syllables: syllableRuns(notes) };
  return tapLoop(run, i, pauses, notes.length, neumes.at, neumes.syllables);
}

/** What a tap on note `i`'s band does (`tapped`), in words, from its note: while the take plays
 * that note, plays it on from there (`seek`); else chooses its phrase, or the run it stretches or
 * narrows the run chosen to, or lets the run go. */
function bandName(i: number): string {
  const playing = replay.notes;
  if (replay.playing && playing && i >= playing[0] && i <= playing[1])
    return `Note ${i + 1}: play ${playingBack?.again ? "it as you sang it again" : "your take"} on from here`;
  const run = tapped(loop, i);
  const [a, b] = phraseOf(i, score.timeline.pauses, score.timeline.notes.length);
  if (run && run[0] === a && run[1] === b) return `Choose the phrase of note ${i + 1}`;
  return `Note ${i + 1}: ${run ? `choose ${numbered(run[0], run[1]).toLowerCase()}` : "let the run go"}`;
}

/** Whether the bands were last named for a take playing back (`bandName`). */
let namedPlaying = false;

/** Names the bands drawn again, once the take starts or stops playing back. */
function renameBands(): void {
  if (namedPlaying === replay.playing) return;
  namedPlaying = replay.playing;
  for (const band of score.host.querySelectorAll<SVGGElement>("[data-band][role=button]")) band.setAttribute("aria-label", bandName(Number(band.dataset.band)));
}

/** Chooses the phrase of note `i`, or stretches the run to it, narrows it or lets it go. */
function choose(i: number): void {
  if (taking || !guide) return;
  stopPlay();
  setLoop(tapped(loop, i));
}

// What plays, one thing at a time: the guide (Play; beside a take Guide once, Repeat over and
// over), the take (Yours), or both in turn (Compare, and a card's Hear the step); and where the
// chant has an aligned recording whose sound is kept, the recording (Recording).
const compareButton = byId<HTMLButtonElement>("compare");
const hearButton = byId<HTMLButtonElement>("hear");
const recordingButton = byId<HTMLButtonElement>("recording");
const repeatButton = byId<HTMLButtonElement>("repeat");
/** Counts plays, so a play stopped while it starts, or waits between its parts, does not go on. */
let plays = 0;
/** The play under way, until it ends or is stopped: its button, whether the take sounds in it,
 * and whether the guide sings in it away from the Pitch, where a drone holds. */
let playing: { run: number; button: HTMLButtonElement; take: boolean; moved: boolean } | null = null;
/** How many plays of the guide have been asked for, for the tests. */
let guidePlays = 0;

function stopPlay(): void {
  plays++;
  playing = null;
  playingBack = null;
  replay.stop();
  recordingReplay.stop();
  guide?.stop();
  for (const button of [playButton, repeatButton, hearButton, compareButton, stepButton, recordingButton]) button.setAttribute("aria-pressed", "false");
  letSleep("play");
  unsayFetching();
}

/** Stops the take sounding, alone or after the guide; the guide alone (and a drone under it)
 * goes on. */
function stopHear(): void {
  if (playing?.take) stopPlay();
}

/** Starts a play with `button` pressed, `take` if the take (or the recording) will sound in it
 * and `moved` if the guide will sing away from the Pitch; its run. A drone would cover the take,
 * and clash with the guide moved, so it stops for either. */
function begin(button: HTMLButtonElement, take: boolean, moved: boolean): number {
  stopPlay();
  stopPitch();
  if (take || moved) stopDrone();
  playing = { run: plays, button, take, moved };
  button.setAttribute("aria-pressed", "true");
  stayAwake("play");
  return plays;
}

/** Whether the play `run` goes on. */
const going = (run: number) => playing?.run === run;

/** Has the guide play as `options` say, counting it. */
function guided(options: Parameters<Guide["play"]>[0]): ReturnType<Guide["play"]> {
  guidePlays++;
  return guide!.play(options);
}

/** Plays the chant, or the run chosen, with `button` pressed: `"once"`; over and over while a
 * run is chosen (`"run"`), else once; or over and over (`"always"`); until it is stopped. Beside
 * a take it sings in the singer's key if they keep the guide there. */
async function play(button: HTMLButtonElement, over: "once" | "run" | "always"): Promise<void> {
  if (!guide) return;
  const transpose = replayable ? reviewTranspose(loop) : undefined;
  const run = begin(button, false, transpose !== undefined);
  const again = () => over === "always" || (over === "run" && loop !== null);
  for (;;) {
    const started = await guided({ range: loop ?? undefined, transpose });
    if (!going(run)) return;
    // Its onStop has let the button go; while the loop goes round it stays pressed.
    button.setAttribute("aria-pressed", "true");
    if (!started || !(await started.ended) || !going(run) || !again()) break;
    await wait(BREATH * guide.pulse);
    if (!going(run)) return;
  }
  if (going(run)) stopPlay();
}

// Yours plays the last take shown back against the score, from the audio the ear keeps for
// sending (decoded once a take), the cursor on each note where it was due; on a phone it takes
// the place of Start note while a take is shown. Compare plays the guide over the same notes
// first.
const replay = new Replay(
  score,
  cursor,
  () => hearButton.setAttribute("aria-pressed", "false"),
  (at) => {
    heardAt = at;
    drawPlayhead();
    renameBands();
  },
);
// Recording plays the chant's aligned recording over the run chosen, or the whole chant, once,
// the cursor where the recording sang each note: in its own key, as it was sung, and the whole
// chant from just before its first note, so not what is spoken before it on the recording. Its
// sound is fetched and decoded the first time it is heard.
const recordingReplay = new Replay(score, cursor, () => recordingButton.setAttribute("aria-pressed", "false"), undefined, "recording");
/** When the recording sang each note of the chant as the library gave it, where it has the
 * recording's sound; null where it has none. */
const recordingAt = found?.audio ? recordedTimes(recording, score.timeline.notes.length) : null;
const recordingAudio = found?.audio && recordingAt ? recordingSound(found.audio) : null;
/** Whether the recording is of the chant on the page: the chant as the library gave it. */
const recordable = () => recordingAudio !== null && score.source === piece.gabc;
/** Offers the recording beside the chant it is of. */
function offerRecording(): void {
  recordingButton.hidden = !recordable();
}
offerRecording();

/** Plays the recording over the run chosen, or from its first note to its last, once. As Yours,
 * it lets go of what the status said of what there was none of to hear, and of a recording that
 * could not be had; while its sound is first fetched, the status says so. */
async function hearRecording(): Promise<void> {
  const times = recordingAt;
  if (!recordable() || !recordingAudio || !times) return;
  quieten();
  if (status.textContent?.startsWith(UNPLAYED)) setStatus("");
  const run = begin(recordingButton, true, false);
  if (!recordingAudio.kept()) {
    saidBeforeFetching = { text: status.textContent ?? "", news: !status.classList.contains("error") };
    setStatus(FETCHING, true);
  }
  try {
    const ctx = await audioContext();
    const buffer = await recordingAudio.sound(ctx);
    // A play stopped meanwhile has let go of the line.
    if (!going(run)) return;
    unsayFetching();
    await recordingReplay.play(ctx, buffer, times, loop ?? [0, times.length - 1]);
  } catch (error) {
    if (!going(run)) return;
    stopPlay();
    return setStatus(`${UNPLAYED}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (going(run)) stopPlay();
}

/** The take shown, as it may be heard again: when each note judged was due in it, which for a
 * take stopped short is fewer notes than the chant's, and the seconds a pulse it was sung at. */
let replayable: Heardback | null = null;
/** What plays back, while it does. */
let playingBack: Heardback | null = null;
/** The audio of the take shown, as the ear sends it to be sent, once asked for, and decoded once
 * first heard; and how many times a take's audio has been decoded, for the tests. The ear keeps
 * only the last take it heard, so the take's is asked for before a run of it is sung again, and
 * kept. */
let takeWav: Promise<{ wav: ArrayBuffer; seconds: number }> | null = null;
let decoded: Promise<AudioBuffer> | null = null;
let decodes = 0;
/** Whether the ear has heard a run sung again since the take shown, and so no longer has its audio. */
let sungSince = false;

/** The take shown's audio, as the ear sends it, asked for once. */
function wavOfTake(): Promise<{ wav: ArrayBuffer; seconds: number }> {
  if (!takeWav) {
    // Not reached from the page, which asks for it before a run is sung again; it guards a later caller.
    if (sungSince) return Promise.reject(new Error("it is no longer kept"));
    const pending = listener.audio();
    // One that failed is asked for again the next time.
    pending.catch(() => {
      if (takeWav === pending) takeWav = null;
    });
    takeWav = pending;
  }
  return takeWav;
}

/** The take shown's audio, decoded the first time it is heard and kept for the next. */
function takeAudio(ctx: AudioContext): Promise<AudioBuffer> {
  if (!decoded) {
    decodes++;
    // Decoding takes the buffer it is given, so it is given a copy: the take may yet be sent.
    const pending = wavOfTake().then(({ wav }) => ctx.decodeAudioData(wav.slice(0)));
    pending.catch(() => {
      if (decoded === pending) decoded = null;
    });
    decoded = pending;
  }
  return decoded;
}

/** What plays back over the notes `range` (the whole take when none): the run sung again, where
 * the run holds them, else the take. */
function heardback(range: readonly [number, number] | null | undefined): Heardback | null {
  return range && again && inside(range, again.run) ? again.back : replayable;
}

/** Offers the take judged as `judged`, sung at `pulse` seconds a pulse, to be heard again, or
 * none; beside it, Play is Guide and plays once, Repeat plays the guide over and over, and
 * Compare plays the guide and the take in turn. */
function offerReplay(take: { judged: Judged; pulse: number } | null): void {
  stopHear();
  decoded = takeWav = null;
  sungSince = false;
  replayable = take && {
    times: (take.judged.notes ?? []).map((n) => ({ start: n.start_s, duration: n.dur_s })),
    pulse: take.pulse,
    audio: takeAudio,
    again: false,
  };
  hearButton.hidden = compareButton.hidden = repeatButton.hidden = !replayable;
  playButton.textContent = replayable ? "Guide" : "Play";
  playButton.classList.toggle("primary", !replayable);
  if (guide) playButton.title = replayable ? "The guide over the phrase chosen, once" : "";
}

/** The notes `run` of the take, as far as it was judged: none of it (false) if it stopped
 * before; the whole take (undefined) for no run. */
function heardRun(take: { times: Timed[] }, run: readonly [number, number] | null): readonly [number, number] | false | undefined {
  if (!run) return undefined;
  const to = Math.min(run[1], take.times.length - 1);
  return run[0] > to ? false : [run[0], to];
}

/** Plays `take` over the notes `range` (all of it when undefined) while play `run` goes on,
 * saying why if it cannot; resolves when it has ended or was stopped. */
async function playTake(run: number, take: Heardback, range: readonly [number, number] | undefined): Promise<void> {
  try {
    const ctx = await audioContext();
    const buffer = await take.audio(ctx);
    if (!going(run)) return;
    playingBack = take;
    await replay.play(ctx, buffer, take.times, range);
  } catch (error) {
    if (!going(run)) return;
    stopPlay();
    setStatus(`Your take could not be played: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Plays the take, or the run sung again, over the run chosen, once. */
async function hear(): Promise<void> {
  const take = heardback(loop);
  if (!take) return;
  const range = heardRun(take, loop);
  if (range === false) return setStatus(NONE_HEARD, true);
  quieten();
  const run = begin(hearButton, true, false);
  await playTake(run, take, range);
  if (going(run)) stopPlay();
}

/** Plays the guide over notes `range` (the whole chant when null), where the singer started if
 * they keep it there and at the take's speed, then after a breath the take over the same notes,
 * once, with `button` pressed: the model, then what was sung. Both go only as far as the take
 * was judged. */
async function compare(range: readonly [number, number] | null, button: HTMLButtonElement): Promise<void> {
  const take = heardback(range);
  if (!guide || !take) return;
  const judged = take.times.length;
  if (judged === 0) return setStatus(NONE_JUDGED, true);
  const heard = heardRun(take, range) ?? (judged < score.timeline.notes.length ? ([0, judged - 1] as const) : undefined);
  if (heard === false) return setStatus(NONE_HEARD, true);
  quieten();
  const transpose = reviewTranspose(range);
  const run = begin(button, true, transpose !== undefined);
  const started = await guided({ range: heard, transpose, pulse: take.pulse });
  if (!going(run)) return;
  if (started && (await started.ended) && going(run)) {
    await wait(BREATH * take.pulse);
    if (going(run)) await playTake(run, take, heard);
  }
  if (going(run)) stopPlay();
}

/** Presses `button` to start what it plays, or, pressed, to stop it; nothing plays in a take. */
function toggle(button: HTMLButtonElement, start: () => Promise<void>): void {
  button.addEventListener("click", () => {
    if (button.getAttribute("aria-pressed") === "true") return stopPlay();
    if (taking) return;
    void start();
  });
}
toggle(hearButton, hear);
toggle(recordingButton, hearRecording);
toggle(compareButton, () => compare(loop, compareButton));
toggle(repeatButton, () => {
  setStatus("");
  return play(repeatButton, "always");
});
// The step into the place open: the note before the one its words are of, and that one.
toggle(stepButton, async () => {
  const spot = openSpot();
  if (spot && spot.at > 0) await compare([spot.at - 1, spot.at], stepButton);
});

if (!guide) {
  playButton.title = noteButton.title = droneButton.title = compareButton.title = repeatButton.title = "The guide voice could not load.";
  setStatus(playButton.title);
} else {
  playButton.disabled = noteButton.disabled = droneButton.disabled = compareButton.disabled = repeatButton.disabled = false;
  droneButton.addEventListener("click", () => {
    if (droneButton.getAttribute("aria-pressed") === "true") return stopDrone();
    // Not under the take, nor against the guide moved from the Pitch the drone holds.
    if (playing?.take || playing?.moved) stopPlay();
    void startDrone();
  });
  playButton.addEventListener("click", () => {
    if (playButton.getAttribute("aria-pressed") === "true") return stopPlay();
    setStatus("");
    // Beside a take, Guide plays once; Repeat goes over and over.
    void play(playButton, replayable ? "once" : "run");
  });
  noteButton.addEventListener("click", () => {
    if (noteButton.getAttribute("aria-pressed") === "true") return stopPitch();
    void soundPitch();
  });
}

// A scored take. The guide through the speaker would reach the microphone, so it is never
// scored: with headphones the guide sings the take in the singer's ears; without, it gives
// the opening notes (the first and the reciting tone) and then the cursor alone leads.
const takeButton = byId<HTMLButtonElement>("take");
const modeText = byId<HTMLSpanElement>("mode");
const modeLine = modeText.parentElement!;
const headphonesBox = byId<HTMLInputElement>("headphones");
/** What the browser says of headphones, until the singer says otherwise. */
let detected: boolean | null = null;
/** Whether the browser names its devices, as it does once the microphone is allowed. */
let named = false;
let chosen = false;
/** How long the cursor waits before the chant begins, after listening begins, in seconds. */
const LEAD = 1.5;
/** How long listening goes on after the last note is due, in seconds: past the latest a take
 * timed by the singer's first sound may run ([`ONSET_WINDOW`]). */
const TAIL = ONSET_WINDOW + 0.5;
/** How the last take was timed, in seconds of the take: when its first note was due, when the
 * singer first sounded, and the first note's start it was judged by. */
let timing: Entry | null = null;

function showMode(): void {
  const worn = headphonesBox.checked;
  const why = chosen
    ? worn
      ? "as you said"
      : "you said no headphones are in"
    : detected === null
      ? "this browser does not say whether headphones are in; tick Headphones if they are"
      : worn
        ? "headphones are in"
        : "no headphones are in";
  modeText.textContent = worn
    ? `A take is scored with the guide in your headphones (${why}). What the guide sings to you is never scored.`
    : `A take is scored with the opening notes only, then the cursor leads, since through the speaker the microphone would hear the guide (${why}). What the guide sings to you is never scored.`;
  // A browser that names its devices but does not say which is playing can be checked.
  if (!chosen && detected === null && named) {
    const check = document.createElement("a");
    check.href = "/diagnostics";
    check.textContent = "Check this browser";
    modeText.append(" ", check, ".");
  }
}

async function detect(take?: number): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    named = devices.some((d) => d.label);
    detected = headphonesIn(devices);
  } catch {
    detected = null;
  }
  // A take keeps the mode it began in.
  if (taking && take !== takes) return;
  if (!chosen) headphonesBox.checked = detected === true;
  showMode();
}
headphonesBox.addEventListener("change", () => {
  chosen = true;
  showMode();
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => void detect());
void detect();

/** Asks for the microphone if it is not yet allowed, so that the question does not come
 * between the opening notes and the take, and the outputs are named. */
async function allowMicrophone(): Promise<void> {
  try {
    if ((await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted") return;
  } catch {
    // The browser cannot say; ask.
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

/** The opening notes the take is given without headphones: the first note, then the reciting
 * tone if it is another; of `notes`, the chant's from note `from`. */
function cueNotes(notes: readonly SungNote[], from = 0): SungNote[] {
  const first = notes[0];
  if (!first) return [];
  const recited = notes.find((_, i) => score.timeline.notes[from + i]?.recitation);
  const cue = [{ ...first, start: 0, duration: 1 }];
  if (recited && recited.midi !== first.midi) cue.push({ ...recited, start: 1.1, duration: 1.4 });
  return cue;
}

const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, Math.max(seconds, 0) * 1000));

/** The opening notes, while they sound; and the last given, as MIDI. */
let cueing: Singing | null = null;
let cued: number[] = [];
/** Whether the chant of the take under way has begun, so that Stop ends it and judges what
 * was sung; and whether Stop was pressed then. */
let chanting = false;
let stopAsked = false;
/** Ends the wait after the chant at once, while the take listens on for a late singer. */
let hurry: (() => void) | null = null;

/** Begins a take, and returns its number: nothing else sounds or listens during it, and nothing
 * that changes how it is sung can be changed. */
function startTaking(): number {
  const take = ++takes;
  taking = true;
  document.body.classList.add("taking");
  stayAwake("take");
  timing = null;
  stopAsked = false;
  stopPlay();
  stopPitch();
  stopDrone(false);
  listener.stop();
  playButton.disabled = noteButton.disabled = droneButton.disabled = headphonesBox.disabled = recordingButton.disabled = true;
  speedSelect.disabled = pitchSelect.disabled = unloopButton.disabled = true;
  holdChant(true);
  takeButton.textContent = "Stop";
  takeButton.title = "";
  sendButton.disabled = true;
  readout.textContent = "–";
  readout.setAttribute("aria-live", "off");
  return take;
}

async function takeScored(): Promise<void> {
  if (!guide || !table) return;
  const take = startTaking();
  // A take that is no longer going leaves the page alone: whatever stopped it has seen to it.
  const going = () => taking && take === takes;
  // The take kept before is read while this one is sung.
  const finding = findKept(score.source);
  const since = forgettings;
  let shownNow = false;
  showResult(null);
  setStatus("");
  try {
    const ctx = await audioContext();
    await allowMicrophone();
    if (!going()) return;
    await detect(take);
    if (!going()) return;
    const worn = headphonesBox.checked;
    // From here the page says nothing it need not: the mode is chosen.
    modeLine.hidden = true;
    if (!worn) {
      setStatus("Listen to the opening notes.", true);
      const notes = cueNotes(guide.notes());
      cued = notes.map((n) => n.midi);
      const cue = await sing(ctx, notes, {
        table,
        gabc: score.source,
        onError: (error) => console.error("opening notes:", error),
      });
      if (!going()) return cue.stop();
      cueing = cue;
      await wait(cue.end - ctx.currentTime + 0.3);
      if (!going()) return;
    }
    await listener.start();
    if (!going()) return;
    readout.textContent = "–";
    const prompt = worn ? "Begin with the guide." : "Begin when the cursor appears.";
    setStatus(prompt, true);
    const started = await guide.play({ voice: worn, lead: LEAD });
    if (!going()) return;
    // A guide that did not start, or failed, has said why.
    if (!started) return listener.stop();
    // Once the chant begins the page shows the cursor and the note alone.
    void wait(started.origin + started.first - ctx.currentTime).then(() => {
      if (going() && status.textContent === prompt) setStatus("");
    });
    chanting = true;
    const finished = await started.ended;
    chanting = false;
    // Stopped once the chant had begun, the take is judged as far as it was sung: where the
    // cursor was, and below, by the singer's own time.
    let cut = !finished && stopAsked ? guide.reached : null;
    if (finished) {
      await new Promise<void>((resolve) => {
        hurry = () => {
          cut = score.timeline.notes.length - 1;
          resolve();
        };
        setTimeout(resolve, TAIL * 1000);
      });
      if (take === takes) hurry = null;
    }
    if (!going()) return;
    listener.stop();
    // A guide that failed has said why.
    if (!finished && cut === null) return;
    // Judging takes a moment; the take cannot be stopped or begun again meanwhile.
    takeButton.disabled = true;
    setStatus(cut === null ? "Listening back to your take…" : "Stopped. Listening back to what you sang…", true);
    const heard = await listener.heard;
    if (!heard || heard.startedAt === null) throw new Error("nothing was heard");
    // The singer hears the guide late by the output's latency, and is heard late by the
    // input's; the cursor is seen at once.
    const output = worn ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0;
    const due = started.origin + started.first - heard.startedAt + listener.inputLatency + output;
    const entry = await listener.entry(due);
    if (!going()) return;
    timing = entry;
    const offset = entry.at - started.first;
    // A take stopped is judged through the last note the singer had time to sing whole, on
    // their own time (they may be late on the cursor), to the end of the last phrase finished
    // there (the ear's `judge_gabc`).
    let through: number | null = null;
    if (cut !== null) {
      through = throughHeard(timed(score.timeline.notes, guide.pulse), offset, heard.seconds);
      if (through === null) {
        setStatus("The take was stopped before its first note was sung through, so there is nothing to judge.", true);
        return;
      }
    }
    const json = await listener.judge(score.source, guide.pulse, offset, through);
    if (!going()) return;
    const judged = JSON.parse(json) as Judged;
    await findBefore(judged, finding, since);
    if (!going()) return;
    setStatus("");
    showResult(judged, cut, worn);
    offerSend({ gabc: score.source, pulse: guide.pulse, offset, judged });
    void keepShown(judged, score.source);
    shownNow = true;
  } catch (error) {
    if (going()) setStatus(`The take failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (take === takes) endTake();
    // The result is above the score, far from where the take ended; it comes into view once
    // the page above it is laid out as it will stay.
    if (shownNow) {
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => result.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" }));
    }
  }
}

/** The run chosen, while it may be sung again: one within the notes the take shown was judged
 * on, a take heard; with the whole of any place of the take it holds part of ([`grown`]). */
function againRun(): [number, number] | null {
  if (!shown?.report || shown.verdict.key_cents === null || !loop || loop[1] >= shown.ribbon.length) return null;
  return grown(shown, loop);
}

/** The take `take` as the ear reads a take a run is sung again after: its verdict and its report. */
const beforeOf = (take: Judged) => JSON.stringify({ verdict: take.verdict, report: take.report });

/** Whether the take under way is of a run sung again. */
let singingAgain = false;

/** A take of the run chosen sung again beside the take shown, in the key the take was in there
 * (the core's): led as a take is, by the guide in headphones or after its first note without,
 * and judged when it is over; stopped before then, it is not judged. Shown over the take, which
 * stays shown, the score where it was. */
async function takeAgain(): Promise<void> {
  const take0 = shown;
  const run = againRun();
  if (!guide || !table || !take0 || !run) return;
  const [a, b] = run;
  // What is sung is what is chosen, and the singer is told when it is more than they chose.
  let more = loop && (loop[0] !== a || loop[1] !== b) ? `${numbered(a, b)}, ${grewOver(take0, loop)}. ` : "";
  if (loop && more) setLoop(run);
  const take = startTaking();
  const going = () => taking && take === takes;
  singingAgain = true;
  setOpen(null);
  drawResult();
  compareButton.disabled = hearButton.disabled = repeatButton.disabled = stepButton.disabled = true;
  setStatus("");
  try {
    const key = await listener.againKey(beforeOf(take0), a, b);
    if (!going()) return;
    if (key === null) return setStatus("Your take has no key to sing it again in.");
    // The take's audio, which the ear lets go of once it hears another, is kept to be heard and sent.
    await wavOfTake();
    if (!going()) return;
    const ctx = await audioContext();
    // Asked for before the first note, so that a browser that asks does not ask between it and
    // the run.
    await allowMicrophone();
    if (!going()) return;
    await detect(take);
    if (!going()) return;
    const worn = headphonesBox.checked;
    const transpose = key / 100;
    modeLine.hidden = true;
    if (!worn) {
      const notes = cueNotes(guide.notes(transpose).slice(a, b + 1), a);
      setStatus(`${more}Listen to ${notes.length > 1 ? "its opening notes" : "its first note"}.`, true);
      more = "";
      cued = notes.map((n) => n.midi);
      const cue = await sing(ctx, notes, {
        table,
        gabc: score.source,
        onError: (error) => console.error("opening notes:", error),
      });
      if (!going()) return cue.stop();
      cueing = cue;
      await wait(cue.end - ctx.currentTime + 0.3);
      if (!going()) return;
    }
    sungSince = true;
    await listener.start();
    if (!going()) return;
    readout.textContent = "–";
    const prompt = `${more}${worn ? "Begin with the guide." : "Begin when the cursor appears."}`;
    setStatus(prompt, true);
    // In the key it is judged in, whether or not the guide sings in the singer's key beside the take.
    const pulse = guide.pulse;
    const started = await guide.play({ voice: worn, lead: LEAD, range: run, transpose });
    if (!going()) return;
    if (!started) return listener.stop();
    void wait(started.origin + started.first - ctx.currentTime).then(() => {
      if (going() && status.textContent === prompt) setStatus("");
    });
    chanting = true;
    const finished = await started.ended;
    chanting = false;
    if (finished) {
      await new Promise<void>((resolve) => {
        hurry = resolve;
        setTimeout(resolve, TAIL * 1000);
      });
      if (take === takes) hurry = null;
    }
    if (!going()) return;
    listener.stop();
    if (!finished) {
      // A guide that failed has said why.
      if (stopAsked) setStatus("Stopped, so it is not judged; your take is as it was.", true);
      return;
    }
    takeButton.disabled = true;
    setStatus("Listening back to what you sang…", true);
    const heard = await listener.heard;
    if (!heard || heard.startedAt === null) throw new Error("nothing was heard");
    const output = worn ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0;
    const due = started.origin + started.first - heard.startedAt + listener.inputLatency + output;
    const entry = await listener.entry(due);
    if (!going()) return;
    timing = entry;
    const json = await judgeAgain(take0, run, key, pulse, entry.at, worn);
    if (!going() || json === null) return;
    setStatus("");
  } catch (error) {
    if (going()) setStatus(`Singing it again failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (take === takes) endTake();
  }
}

/** Judges the last take heard as the notes `run` of the take shown, `take`, sung again in `key`
 * cents at `pulse` seconds a pulse, the first due `offset` seconds into it, and shows it over the
 * take, keeping the score where it was; a run not heard is not shown, and the status says why.
 * Its JSON when it is shown; else null. */
async function judgeAgain(take: Judged, run: [number, number], key: number, pulse: number, offset: number, worn: boolean): Promise<string | null> {
  const [a, b] = run;
  const json = await listener.judgeAgain(score.source, beforeOf(take), pulse, offset, a, b, key);
  const judged = JSON.parse(json) as Judged;
  if (shown !== take) return null;
  if (judged.verdict.outcome !== "heard") {
    setStatus(unheard(judged, `${runWords(a, b)} sung again`, worn), true);
    return null;
  }
  // Heard back from its own audio, each note where it was due in it; those before the run, never
  // played, kept in order before it.
  const notes = judged.notes ?? [];
  const page = timed(score.timeline.notes, pulse);
  const first = notes[0];
  const times = page.slice(0, b + 1).map((t, i) => {
    const n = notes[i - a];
    if (n) return { start: n.start_s, duration: n.dur_s };
    return { start: (first?.start_s ?? offset) - (page[a]!.start - t.start), duration: t.duration };
  });
  const wav = listener.audio();
  wav.catch(() => {});
  let decodedAgain: Promise<AudioBuffer> | null = null;
  const audio = (ctx: AudioContext) => {
    if (!decodedAgain) {
      const pending = wav.then(({ wav: bytes }) => ctx.decodeAudioData(bytes.slice(0)));
      pending.catch(() => {
        if (decodedAgain === pending) decodedAgain = null;
      });
      decodedAgain = pending;
    }
    return decodedAgain;
  };
  stopHear();
  const replaced = again ? outside(again.run, run) : [];
  steadily(() => {
    again = { run, key, judged, back: { times, pulse, audio, again: true }, replaced };
    viewed = viewOf(take, run, judged);
    spots = spotsOf(viewed);
    saidAt = saidIn(take, viewed, run);
    setOpen(null);
    lastOpen = null;
    drawResult();
  });
  return json;
}

/** Ends the take under way at once, so that nothing of it touches the page again. */
function stopTake(): void {
  takes++;
  // The listener stops first, so its last frames do not reach the readout.
  listener.stop();
  stopPlay();
  endTake();
}

function endTake(): void {
  taking = chanting = singingAgain = false;
  hurry = null;
  document.body.classList.remove("taking");
  letSleep("take");
  cueing?.stop();
  cueing = null;
  playButton.disabled = noteButton.disabled = droneButton.disabled = takeButton.disabled = !guide;
  takeButton.textContent = "Sing a take";
  compareButton.disabled = repeatButton.disabled = !guide;
  hearButton.disabled = stepButton.disabled = recordingButton.disabled = false;
  sendButton.disabled = sending;
  readout.textContent = "–";
  readout.setAttribute("aria-live", "polite");
  headphonesBox.disabled = speedSelect.disabled = pitchSelect.disabled = unloopButton.disabled = false;
  holdChant(false);
  modeLine.hidden = !guide;
  drawChosen();
  void detect();
}

if (guide) {
  takeButton.disabled = false;
  takeButton.addEventListener("click", () => {
    // Beside a take, with a run of it chosen, the run is sung again.
    if (!taking) return void (againRun() ? takeAgain() : takeScored());
    // After the chant, Stop ends the take at once and it is judged whole; once the chant has
    // begun, Stop ends it there and it is judged as far as it went (a run sung again, not at all).
    if (hurry) return hurry();
    if (chanting && guide.reached !== null) {
      stopAsked = true;
      return guide.stop();
    }
    const was = singingAgain;
    stopTake();
    setStatus(was ? "Stopped before it began; your take is as it was." : "The take was stopped before the chant began.", true);
  });
} else {
  takeButton.title = "The guide voice could not load.";
  modeLine.hidden = true;
}

if (test) {
  (window as Window & { __cantor?: unknown }).__cantor = {
    frames: listener.frames,
    get timeline() {
      return score.timeline;
    },
    visited: guide?.visited ?? [],
    /** Whether a play has started and the cursor follows it. */
    get following() {
      return guide?.following ?? false;
    },
    get chunks() {
      return guide?.chunks ?? [];
    },
    /** The drone's note while it sounds, as MIDI. */
    get drone() {
      return drone?.midi ?? null;
    },
    /** The notes the guide's latest play sang, as MIDI, and how many plays have been asked of it. */
    get played() {
      return { midi: guide?.latest.map((n) => n.midi) ?? [], plays: guidePlays };
    },
    /** The notes the cursor has marked in the last take heard back, and whether it plays. */
    get replayed() {
      return { visited: replay.visited, playing: replay.playing, decodes };
    },
    /** The notes the cursor has marked in the recording's latest play, whether it plays, and
     * whether its sound is kept. */
    get recorded() {
      return { visited: recordingReplay.visited, playing: recordingReplay.playing, kept: recordingAudio?.kept() ?? false };
    },
    /** The run looped, by note index, or null. */
    get loop() {
      return loop;
    },
    /** Where the guide's voice is at home, as MIDI. */
    centre: table?.centre ?? null,
    /** The notes the guide sings, at the page's speed and pitch. */
    get sung() {
      return guide?.notes() ?? [];
    },
    /** Drones not yet silent, fading ones included. */
    get drones() {
      return Drone.sounding.size;
    },
    /** The opening notes last given a take, or a run sung again, without headphones, as MIDI. */
    get cued() {
      return cued;
    },
    /** The starting pitch's notes while it sounds, as MIDI. */
    get pitch() {
      return pitching && guide ? cueNotes(guide.notes()).map((n) => n.midi) : [];
    },
    voice: recorded ? "recorded" : table ? "neutral" : "none",
    heard: () => listener.heard,
    listen: () => toggleListening(),
    /** Listens, or stops, for a run of the take shown sung again: the take stays shown, and its
     * audio kept. */
    listenAgain: async () => {
      if (listener.listening) return listener.stop();
      await wavOfTake();
      sungSince = true;
      await listener.start();
    },
    /** Shows the last take heard as notes `first` to `last` of the take shown sung again, in the
     * key the core gives, the first due `offset` seconds into it at `pulse` seconds a pulse;
     * returns the JSON. */
    showAgain: async (first: number, last: number, pulse: number, offset: number) => {
      const take = shown;
      if (!take) throw new Error("no take is shown");
      const key = await listener.againKey(beforeOf(take), first, last);
      if (key === null) throw new Error("the take has no key");
      return judgeAgain(take, [first, last], key, pulse, offset, false);
    },
    /** The run sung again shown, and the key it was sung in, or null. */
    get again() {
      return again && { run: again.run, key: again.key };
    },
    take: () => timing,
    // Puts `gabc` on the page at `pulse` seconds a pulse, for a take of another chant.
    practise: (gabc: string, pulse: number) => {
      if (gabc !== score.source) {
        stopPlay();
        setLoop(null);
        offerReplay(null);
        score.setChant(new Chant(gabc));
        offerRecording();
      }
      if (guide) guide.gabc = gabc;
      // Through the Speed select, as a singer would, adding the pulse to it if it is not there.
      if (![...speedSelect.options].some((o) => o.value === String(pulse))) speedSelect.add(new Option(`${pulse} s a pulse`, String(pulse)));
      speedSelect.value = String(pulse);
      applyTempo();
    },
    /** The page's times for the notes on it, at `pulse` seconds a pulse. */
    timed: (pulse: number) => timed(score.timeline.notes, pulse),
    // Shows the last take judged against `gabc` (put on the page if it is not there), through
    // note `through` as if stopped there; returns the JSON.
    show: async (gabc: string, pulse: number, offset: number, through: number | null = null) => {
      if (gabc !== score.source) {
        stopPlay();
        setLoop(null);
        offerReplay(null);
        score.setChant(new Chant(gabc));
        offerRecording();
      }
      const finding = findKept(gabc);
      const since = forgettings;
      const json = await listener.judge(gabc, pulse, offset, through);
      const judged = JSON.parse(json) as Judged;
      await findBefore(judged, finding, since);
      showResult(judged, through);
      offerSend({ gabc, pulse, offset, judged });
      await keepShown(judged, gabc);
      return json;
    },
  };
}
