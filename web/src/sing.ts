import { Chant, init, summarize } from "neuma";
import { Cursor } from "./cursor";
import { Guide, PULSE } from "./guide";
import { type Entry, Listener } from "./listen";
import DEFAULT_GABC from "../../content/chants/lumen-gentium.gabc?raw";
import { escape, finds, highlight, kicker, library, chant as findChant, terms, type LibraryChant } from "./library";
import { describePitch, noteName } from "./notes";
import { drawMarks, type Mark } from "./marks";
import { SCALE, Score } from "./score";
import { drawRibbon, type Judged } from "./ribbon";
import { offerSignIn } from "./beam";
import { copyWhenReady, sendTake, signedIn } from "./send";
import { audioContext } from "./audio";
import { letSleep, stayAwake } from "./awake";
import { Drone, droneNote, modeNumber } from "./drone";
import { tapLoop } from "./loop";
import { Replay } from "./replay";
import { byPhrase, runOf, stepTo, sungOrder, writtenStep } from "./review";
import { neutralTable, sing, type Singing, type SungNote, VoiceTable } from "./singer";
import { headphonesIn, ONSET_WINDOW, timed, type Timed } from "./timing";

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
const keyText = byId<HTMLParagraphElement>("key");
const inKeyLine = byId<HTMLParagraphElement>("in-key-line");
const inKeyBox = byId<HTMLInputElement>("in-key");
const recordedText = byId<HTMLParagraphElement>("recorded");
const readingText = byId<HTMLDetailsElement>("reading");
const recording = found?.recording ?? [];
const placesSection = byId<HTMLElement>("places");
const markedList = byId<HTMLOListElement>("marked");
const cutText = byId<HTMLParagraphElement>("cut");
// The card of the mark open (the bar names it): the core's words, how its first note is written
// from the note before, and the step into it to hear.
const why = byId<HTMLDivElement>("why");
const whyWords = byId<HTMLParagraphElement>("why-words");
const whyStep = byId<HTMLSpanElement>("why-step");
const stepButton = byId<HTMLButtonElement>("step");
let shown: Judged | null = null;
/** The note the singer stopped the take shown at, or null when it ran to the end; and whether
 * the guide was in their headphones. */
let cutAt: number | null = null;
let shownWorn = false;
/** The Pitch the take shown was sung at, in semitones from the score's. */
let shownPitch = 0;
let open: number | null = null;

/** What the core found of a take it could not judge, and what to try. */
function unheard(judged: Judged): string {
  if (judged.verdict.outcome === "masked")
    return "The guide was louder than your voice, so too little of it was heard to judge the take. Use headphones, or untick Headphones so the guide gives only the opening notes.";
  const begin = shownWorn ? "with the guide" : "when the cursor appears";
  return `Too little of your voice was heard to judge the take. Sing nearer the microphone and a little louder, beginning ${begin}.`;
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

/** Where the guide sings beside a take, in semitones from the score: where the singer started,
 * while a take heard away from the guide is shown and the singer keeps the guide there; else
 * undefined, at the Pitch. Exactly, not to the nearest semitone, so that only the singer's own
 * faults sound apart. */
function reviewTranspose(): number | undefined {
  const key = shown?.verdict.key_cents ?? null;
  if (key === null || !inKeyBox.checked || !away(fromGuide(key, shownPitch))) return undefined;
  return key / 100;
}

/** The marks of the take shown, when it was heard. */
const shownMarks = (): readonly Mark[] => (shown && shown.verdict.key_cents !== null ? shown.verdict.marks : []);

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

/** The syllables at either end of notes `a` to `b`, quoted: "“al … ia”", or none. */
function ends(a: number, b: number): string {
  const sung = [syllableOf(a), a === b ? "" : syllableOf(b)].filter(Boolean);
  return sung.length ? `“${sung.join(" … ")}”` : "";
}

/** The take the marks are listed for. */
let listedFor: Judged | null = null;

/** The core's marks written out under the score, gathered by the phrase each chooses (one row a
 * phrase, folded, in the order sung), each with the note it is on, so that a phone can read
 * what the rings mean in a list; each opens its mark on the score. Listed once a take, so that
 * opening one keeps the rows as they were opened and the button its focus. */
function listMarks(judged: Judged | null): void {
  if (judged === listedFor) {
    for (const b of markedList.querySelectorAll<HTMLButtonElement>("[data-opens]"))
      b.setAttribute("aria-expanded", String(Number(b.dataset.opens) === open));
    return;
  }
  listedFor = judged;
  const marks = judged?.verdict.marks ?? [];
  placesSection.hidden = marks.length === 0;
  const { pauses, notes } = score.timeline;
  markedList.replaceChildren(
    ...byPhrase(marks, pauses, notes.length).map(({ run: [a, b], marks: ks }) => {
      const summary = document.createElement("summary");
      const n = ks.length;
      summary.append(
        Object.assign(document.createElement("span"), { className: "phrase", textContent: wordsOf(a, b) || numbered(a, b) }),
        " ",
        Object.assign(document.createElement("span"), { className: "count", textContent: `${n} mark${n === 1 ? "" : "s"}` }),
      );
      const list = document.createElement("ol");
      list.setAttribute("role", "list");
      list.append(
        ...ks.map((k) => {
          const m = marks[k]!;
          const sung = syllableOf(m.first);
          const where = `${numbered(m.first, m.last)}${sung ? `, “${sung}”` : ""}: `;
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.opens = String(k);
          button.setAttribute("aria-controls", "why");
          button.setAttribute("aria-expanded", String(k === open));
          button.append(Object.assign(document.createElement("span"), { className: "where", textContent: where }), judged?.told[k] ?? "");
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
  toggleMark(k);
  // The mark's ring on the score, clear of its card above the bar.
  if (open !== null) bringIntoView(score.host.querySelector(`[data-mark="${k}"]`));
});

/** Scrolls `el` (a mark's ring) to the middle of what the bar and the card leave of the window,
 * unless it is already clear of them. */
function bringIntoView(el: Element | null): void {
  if (!el) return;
  const box = el.getBoundingClientRect();
  // The page's scroll padding keeps clear of the bar and the card at the foot.
  const bottom = window.innerHeight - (parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0);
  if (box.top >= 0 && box.bottom <= bottom) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollBy({ top: (box.top + box.bottom) / 2 - bottom / 2, behavior: still ? "auto" : "smooth" });
}

/** Shows `text` as the core's words for the mark open, announcing it only when it changes. */
function say(text: string): void {
  if (whyWords.textContent !== text) whyWords.textContent = text;
}

/** The card of the mark open, if one is: the core's words, and how its first note is written
 * from the one before, the step that Hear the step plays. */
function drawCard(judged: Judged): void {
  const mark = open === null ? undefined : shownMarks()[open];
  why.hidden = !mark;
  if (!mark || open === null) return say("");
  const { first, last } = mark;
  say(judged.told[open] ?? "");
  const { notes } = score.timeline;
  const before = notes[first - 1];
  const at = notes[first];
  // Of a verse not heard there is nothing of the singer's to hear.
  const step = before && at && mark.kind !== "verse-missing";
  stepButton.hidden = !step;
  whyStep.textContent = step ? `${first === last ? "Written" : "Its first note is written"} ${writtenStep(at.semitones - before.semitones)}.` : "";
  // Measured now, not when the observer next runs, so that a ring brought into view at once
  // keeps clear of it.
  document.documentElement.style.setProperty("--why-h", `${why.getBoundingClientRect().height}px`);
}

function drawResult(): void {
  drawChosen();
  const judged = shown;
  const key = judged?.verdict.key_cents ?? null;
  result.hidden = !judged;
  summaryText.textContent = judged?.summary.join(" ") ?? "";
  summaryText.hidden = !summaryText.textContent;
  // A take stopped is judged to the end of the last phrase finished (the ear's `judge_gabc`).
  const total = score.timeline.notes.length;
  const through = judged?.ribbon.length ?? 0;
  cutText.hidden = !judged || cutAt === null || through >= total;
  if (judged && cutAt !== null)
    cutText.textContent =
      through === 0
        ? `You stopped the take at note ${cutAt + 1} of ${total}, before its first phrase was sung through, so there is nothing to judge yet.`
        : `You stopped the take at note ${cutAt + 1} of ${total}, so it is judged through note ${through}, where the last phrase you sang through ended.`;
  listMarks(key === null ? null : judged);
  if (!judged || key === null) {
    score.showStrips(null);
    why.hidden = true;
    say("");
    readingText.hidden = true;
    recordedText.hidden = true;
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
  score.showStrips(
    (timeline, room) =>
      // The marks first, so that the keyboard reaches them before the bands.
      drawMarks(timeline.notes, judged.verdict.marks, room.shift, open) +
      drawRibbon(timeline.notes, judged.ribbon, room.stripTop, 0, loop, (i) => `Choose the phrase of note ${i + 1}`, underlay),
  );
  drawCard(judged);
  keyText.textContent = keyLine(key, shownPitch);
}
// The guide sings anew from where it is next played.
inKeyBox.addEventListener("change", () => stopPlay());

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
  if (!take || sending) return;
  sendButton.disabled = true;
  sentText.textContent = "Sending…";
  sending = true;
  holdTake(true);
  const audio = listener.audio();
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
      if (toSend === take) {
        sendButton.disabled = false;
        sentText.textContent = "";
      }
      setStatus(`The take could not be sent: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
});

/** Shows a judged take, stopped by the singer at note `cut` if it was and sung with the guide
 * in headphones if `worn`, or clears it. */
function showResult(judged: Judged | null, cut: number | null = null, worn = false): void {
  if (!judged) offerReplay(null);
  // A run chosen before the take, or beside another, is let go: Yours plays the take whole
  // until a phrase of it is chosen.
  shown = judged;
  if (judged && loop) setLoop(null);
  cutAt = judged ? cut : null;
  shownWorn = worn;
  // Pitch cannot change during a take, so it is the take's.
  shownPitch = judged ? Number(pitchSelect.value) : 0;
  open = null;
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
// Tapping a note's band chooses its phrase, as tapping the note does.
function tap(target: EventTarget | null, keyboard: boolean): boolean {
  if (!shown) return false;
  const el = target as Element | null;
  const mark = el?.closest<SVGGElement>("[data-mark]");
  const band = el?.closest<SVGGElement>("[data-band]");
  let again: string;
  if (mark) {
    const k = Number(mark.dataset.mark);
    steadily(() => toggleMark(k));
    again = `[data-mark="${k}"]`;
  } else if (band && !taking) {
    const index = Number(band.dataset.band);
    steadily(() => choose(index));
    again = `[data-band="${index}"]`;
  } else {
    return false;
  }
  // The strips were drawn again; keep a keyboard's place, and the mark in view above its card.
  const now = score.host.querySelector<SVGGElement>(again);
  if (keyboard) now?.focus({ preventScroll: true });
  if (mark && open !== null) bringIntoView(now);
  return true;
}
score.host.addEventListener("click", (e) => {
  if (!tap(e.target, false)) tapScore(e);
});
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

/** Opens mark `k`, choosing the phrase or phrases it is in, so that Compare, Guide and Yours
 * play them; what plays goes on if they were chosen already. */
function chooseMark(k: number): void {
  const mark = shownMarks()[k];
  if (!mark) return;
  if (taking || !guide) {
    open = k;
    return drawResult();
  }
  const run = runOf(mark, score.timeline.pauses, score.timeline.notes.length);
  if (!loop || loop[0] !== run[0] || loop[1] !== run[1]) stopPlay();
  setLoop(run, k);
}

/** Opens mark `k`, or closes it, leaving its phrase chosen. */
function toggleMark(k: number): void {
  if (open !== k) return chooseMark(k);
  open = null;
  drawResult();
}

/** Opens the mark before or after the one open (or the phrase chosen), in the order sung, with
 * its ring brought into view. */
function stepMark(by: 1 | -1): void {
  const k = stepTo(shownMarks(), open, loop, by);
  if (k === null) return;
  chooseMark(k);
  bringIntoView(score.host.querySelector(`[data-mark="${k}"]`));
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
    onError: (message) => setStatus(taking ? "The guide voice failed, so the take was stopped." : message),
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
// phrase it ends, and a tap in the loop, or Whole chant, lets it go. Beside a take the run chosen
// is played once, by Compare, Guide or Yours.
const loopText = byId<HTMLSpanElement>("loop-text");
const unloopButton = byId<HTMLButtonElement>("unloop");
// Beside a take, the bar names the mark open or the run chosen, steps from mark to mark, and
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
/** The pause between times round a loop, and in Compare between the guide and the take, in
 * pulses. */
const BREATH = 2;

/** Chooses the run `next` to play, or none, with mark `mark` open in it, or none. */
function setLoop(next: [number, number] | null, mark: number | null = null): void {
  loop = next;
  open = mark;
  if (status.textContent === NONE_HEARD) setStatus("");
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
  loopText.textContent = next
    ? `Play goes over notes ${a + 1} to ${b + 1} until you stop it.`
    : "Tap a phrase or a bar on the score to play it over and over.";
  // Beside a take, its bands say which are chosen, and the card which mark is open.
  if (shown) drawResult();
  else drawChosen();
}

/** The bar's line beside a take shown: the mark open, as its place among the marks in the order
 * sung, or the run chosen, or the whole chant and how many marks it has, with the steps to the
 * mark before and after. */
function drawChosen(): void {
  const marks = shownMarks();
  chosenLine.hidden = !shown || taking || (!loop && marks.length === 0);
  if (chosenLine.hidden || !shown) return;
  // Kept in its place while there is no run to let go, so that the steps do not move under a
  // finger stepping on.
  unchooseButton.style.visibility = loop ? "" : "hidden";
  prevButton.hidden = nextButton.hidden = marks.length === 0;
  // At either end the step is off but keeps the keyboard.
  prevButton.setAttribute("aria-disabled", String(stepTo(marks, open, loop, -1) === null));
  nextButton.setAttribute("aria-disabled", String(stepTo(marks, open, loop, 1) === null));
  const mark = open === null ? undefined : marks[open];
  const quoted = (a: number, b: number) => {
    const sung = ends(a, b);
    return sung ? ` · ${sung}` : "";
  };
  let text: string;
  if (mark && open !== null) text = `Mark ${sungOrder(marks).indexOf(open) + 1} of ${marks.length}${quoted(mark.first, mark.last)}`;
  else if (loop) {
    const [a, b] = loop;
    // A take stopped short is judged, and heard, only so far.
    text = `${numbered(a, b)}${quoted(a, b)}${a >= shown.ribbon.length ? " · after your take stopped" : ""}`;
  } else text = `Whole chant · ${marks.length} mark${marks.length === 1 ? "" : "s"}`;
  // Announced only when it changes.
  if (chosenText.textContent !== text) chosenText.textContent = text;
}

prevButton.addEventListener("click", () => {
  if (prevButton.getAttribute("aria-disabled") !== "true") stepMark(-1);
});
nextButton.addEventListener("click", () => {
  if (nextButton.getAttribute("aria-disabled") !== "true") stepMark(1);
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
byId<HTMLButtonElement>("unopen").addEventListener("click", () => {
  if (open === null) return;
  const k = open;
  open = null;
  drawResult();
  // The keyboard goes back to the mark's ring.
  score.host.querySelector<SVGGElement>(`[data-mark="${k}"]`)?.focus({ preventScroll: true });
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

/** Chooses the phrase of note `i`, or stretches the run to it, or lets it go (`tapLoop`). */
function choose(i: number): void {
  if (taking || !guide) return;
  stopPlay();
  setLoop(tapLoop(loop, i, score.timeline.pauses, score.timeline.notes.length));
}

// What plays, one thing at a time: the guide (Play, or beside a take Guide), the take (Yours),
// or both in turn (Compare, and a card's Hear the step).
const compareButton = byId<HTMLButtonElement>("compare");
const hearButton = byId<HTMLButtonElement>("hear");
/** Counts plays, so a play stopped while it starts, or waits between its parts, does not go on. */
let plays = 0;
/** The play under way, until it ends or is stopped, and whether the take sounds in it. */
let playing: { run: number; take: boolean } | null = null;
/** The semitones from the score the guide's latest play was sung at, for the tests. */
let sungAt: number | null = null;

function stopPlay(): void {
  plays++;
  playing = null;
  replay.stop();
  guide?.stop();
  for (const button of [playButton, hearButton, compareButton, stepButton]) button.setAttribute("aria-pressed", "false");
  letSleep("play");
}

/** Stops the take sounding, alone or after the guide; the guide alone (and a drone under it)
 * goes on. */
function stopHear(): void {
  if (playing?.take) stopPlay();
}

/** Starts a play, `take` if the take will sound in it, with `button` pressed; its run. */
function begin(button: HTMLButtonElement, take: boolean): number {
  stopPlay();
  stopPitch();
  // A drone under the take would cover it.
  if (take) stopDrone();
  playing = { run: plays, take };
  button.setAttribute("aria-pressed", "true");
  stayAwake("play");
  return plays;
}

/** Whether the play `run` goes on. */
const going = (run: number) => playing?.run === run;

/** Plays the chant, or the loop: beside a take once, in the singer's key if they keep the guide
 * there; else over and over, until it ends or is stopped. */
async function play(): Promise<void> {
  if (!guide) return;
  const run = begin(playButton, false);
  const once = replayable !== null;
  const transpose = once ? reviewTranspose() : undefined;
  sungAt = transpose ?? guide.transpose;
  do {
    const started = await guide.play({ range: loop ?? undefined, transpose });
    if (!going(run)) return;
    // Its onStop has let Play go; while the loop goes round it stays pressed.
    playButton.setAttribute("aria-pressed", "true");
    if (!started || !(await started.ended) || !going(run) || !loop || once) break;
    await wait(BREATH * guide.pulse);
  } while (going(run) && loop);
  if (going(run)) stopPlay();
}

// Yours plays the last take shown back against the score, from the audio the ear keeps for
// sending (decoded once a take), the cursor on each note where it was due; on a phone it takes
// the place of Start note while a take is shown. Compare plays the guide over the same notes
// first.
const replay = new Replay(score, cursor, () => hearButton.setAttribute("aria-pressed", "false"));
/** The take shown, as it may be heard again: when each note judged was due in it, which for a
 * take stopped short is fewer notes than the chant's. */
let replayable: { times: Timed[] } | null = null;
/** The audio of the take shown, decoded, once it is first heard. */
let decoded: Promise<AudioBuffer> | null = null;

/** The take shown's audio, decoded the first time it is heard and kept for the next. */
function takeAudio(ctx: AudioContext): Promise<AudioBuffer> {
  if (!decoded) {
    const pending = listener.audio().then(({ wav }) => ctx.decodeAudioData(wav));
    // One that failed is fetched again the next time.
    pending.catch(() => {
      if (decoded === pending) decoded = null;
    });
    decoded = pending;
  }
  return decoded;
}

/** Offers the take judged as `judged` to be heard again, or none; beside it, Play is Guide and
 * plays once, and Compare plays the guide and the take in turn. */
function offerReplay(take: { judged: Judged } | null): void {
  stopHear();
  decoded = null;
  replayable = take && { times: (take.judged.notes ?? []).map((n) => ({ start: n.start_s, duration: n.dur_s })) };
  hearButton.hidden = compareButton.hidden = !replayable;
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

/** Plays the take over the notes `range` (all of it when undefined) while play `run` goes on,
 * saying why if it cannot; resolves when it has ended or was stopped. */
async function playTake(run: number, take: { times: Timed[] }, range: readonly [number, number] | undefined): Promise<void> {
  try {
    const ctx = await audioContext();
    const buffer = await takeAudio(ctx);
    if (!going(run)) return;
    await replay.play(ctx, buffer, take.times, range);
  } catch (error) {
    if (!going(run)) return;
    stopPlay();
    setStatus(`Your take could not be played: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Plays the take over the run chosen, once. */
async function hear(): Promise<void> {
  const take = replayable;
  if (!take) return;
  const range = heardRun(take, loop);
  if (range === false) return setStatus(NONE_HEARD, true);
  if (status.textContent === NONE_HEARD) setStatus("");
  const run = begin(hearButton, true);
  await playTake(run, take, range);
  if (going(run)) stopPlay();
}

/** Plays the guide over notes `range` (the whole chant when null), where the singer started if
 * they keep it there, then after a breath the take over the same notes, once, with `button`
 * pressed: the model, then what was sung. */
async function compare(range: readonly [number, number] | null, button: HTMLButtonElement): Promise<void> {
  const take = replayable;
  if (!guide || !take) return;
  const heard = heardRun(take, range);
  if (heard === false) return setStatus(NONE_HEARD, true);
  if (status.textContent === NONE_HEARD) setStatus("");
  const run = begin(button, true);
  const transpose = reviewTranspose();
  sungAt = transpose ?? guide.transpose;
  const started = await guide.play({ range: range ?? undefined, transpose });
  if (!going(run)) return;
  if (started && (await started.ended) && going(run)) {
    await wait(BREATH * guide.pulse);
    if (going(run)) await playTake(run, take, heard);
  }
  if (going(run)) stopPlay();
}

/** Presses `button` to start what it plays, or, pressed, to stop it. */
function toggle(button: HTMLButtonElement, start: () => Promise<void>): void {
  button.addEventListener("click", () => {
    if (button.getAttribute("aria-pressed") === "true") return stopPlay();
    void start();
  });
}
toggle(hearButton, hear);
toggle(compareButton, () => compare(loop, compareButton));
// The step into the mark open: the note before it and its first.
toggle(stepButton, async () => {
  const mark = open === null ? undefined : shownMarks()[open];
  if (mark && mark.first > 0) await compare([mark.first - 1, mark.first], stepButton);
});

if (!guide) {
  playButton.title = noteButton.title = droneButton.title = compareButton.title = "The guide voice could not load.";
  setStatus(playButton.title);
} else {
  playButton.disabled = noteButton.disabled = droneButton.disabled = compareButton.disabled = false;
  droneButton.addEventListener("click", () => {
    if (droneButton.getAttribute("aria-pressed") === "true") return stopDrone();
    stopHear();
    void startDrone();
  });
  playButton.addEventListener("click", () => {
    if (playButton.getAttribute("aria-pressed") === "true") return stopPlay();
    setStatus("");
    void play();
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
    ? `A take is scored with the guide in your headphones (${why}). Play sings the chant to you and is never scored.`
    : `A take is scored with the opening notes only, then the cursor leads, since through the speaker the microphone would hear the guide (${why}). Play sings the chant to you and is never scored.`;
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
 * tone if it is another. */
function cueNotes(notes: readonly SungNote[]): SungNote[] {
  const first = notes[0];
  if (!first) return [];
  const recited = notes.find((_, i) => score.timeline.notes[i]?.recitation);
  const cue = [{ ...first, start: 0, duration: 1 }];
  if (recited && recited.midi !== first.midi) cue.push({ ...recited, start: 1.1, duration: 1.4 });
  return cue;
}

const wait = (seconds: number) => new Promise((resolve) => setTimeout(resolve, Math.max(seconds, 0) * 1000));

/** The opening notes, while they sound. */
let cueing: Singing | null = null;
/** Whether the chant of the take under way has begun, so that Stop ends it and judges what
 * was sung; and whether Stop was pressed then. */
let chanting = false;
let stopAsked = false;
/** Ends the wait after the chant at once, while the take listens on for a late singer. */
let hurry: (() => void) | null = null;

async function takeScored(): Promise<void> {
  if (!guide || !table) return;
  const take = ++takes;
  // A take that is no longer going leaves the page alone: whatever stopped it has seen to it.
  const going = () => taking && take === takes;
  taking = true;
  document.body.classList.add("taking");
  stayAwake("take");
  timing = null;
  stopAsked = false;
  let shownNow = false;
  // Nothing else sounds or listens during a take.
  stopPlay();
  stopPitch();
  stopDrone(false);
  listener.stop();
  playButton.disabled = noteButton.disabled = droneButton.disabled = headphonesBox.disabled = true;
  speedSelect.disabled = pitchSelect.disabled = unloopButton.disabled = true;
  holdChant(true);
  takeButton.textContent = "Stop";
  readout.textContent = "–";
  readout.setAttribute("aria-live", "off");
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
      const cue = await sing(ctx, cueNotes(guide.notes()), {
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
      const times = timed(score.timeline.notes, guide.pulse);
      through = -1;
      while (through + 1 < times.length && offset + times[through + 1]!.start + times[through + 1]!.duration <= heard.seconds) through++;
      if (through < 0) {
        setStatus("The take was stopped before its first note was sung through, so there is nothing to judge.", true);
        return;
      }
    }
    const json = await listener.judge(score.source, guide.pulse, offset, through);
    if (!going()) return;
    const judged = JSON.parse(json) as Judged;
    setStatus("");
    showResult(judged, cut, worn);
    offerSend({ gabc: score.source, pulse: guide.pulse, offset, judged });
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

/** Ends the take under way at once, so that nothing of it touches the page again. */
function stopTake(): void {
  takes++;
  // The listener stops first, so its last frames do not reach the readout.
  listener.stop();
  stopPlay();
  endTake();
}

function endTake(): void {
  taking = chanting = false;
  hurry = null;
  document.body.classList.remove("taking");
  letSleep("take");
  cueing?.stop();
  cueing = null;
  playButton.disabled = noteButton.disabled = droneButton.disabled = takeButton.disabled = !guide;
  takeButton.textContent = "Sing a take";
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
    if (!taking) return void takeScored();
    // After the chant, Stop ends the take at once and it is judged whole; once the chant has
    // begun, Stop ends it there and it is judged as far as it went.
    if (hurry) return hurry();
    if (chanting && guide.reached !== null) {
      stopAsked = true;
      return guide.stop();
    }
    stopTake();
    setStatus("The take was stopped before the chant began.", true);
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
    /** The semitones from the score the guide's latest play was sung at. */
    get sungAt() {
      return sungAt;
    },
    /** The notes the cursor has marked in the last take heard back, and whether it plays. */
    get replayed() {
      return { visited: replay.visited, playing: replay.playing };
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
    /** The starting pitch's notes while it sounds, as MIDI. */
    get pitch() {
      return pitching && guide ? cueNotes(guide.notes()).map((n) => n.midi) : [];
    },
    voice: recorded ? "recorded" : table ? "neutral" : "none",
    heard: () => listener.heard,
    listen: () => toggleListening(),
    take: () => timing,
    // Puts `gabc` on the page at `pulse` seconds a pulse, for a take of another chant.
    practise: (gabc: string, pulse: number) => {
      if (gabc !== score.source) {
        stopPlay();
        setLoop(null);
        offerReplay(null);
        score.setChant(new Chant(gabc));
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
      }
      const json = await listener.judge(gabc, pulse, offset, through);
      const judged = JSON.parse(json) as Judged;
      showResult(judged, through);
      offerSend({ gabc, pulse, offset, judged });
      return json;
    },
  };
}
