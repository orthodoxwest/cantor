import { Chant, init, summarize } from "neuma";
import { Cursor } from "./cursor";
import { Guide, PULSE } from "./guide";
import { type Entry, Listener } from "./listen";
import DEFAULT_GABC from "../../content/chants/lumen-gentium.gabc?raw";
import { escape, finds, highlight, kicker, library, chant as findChant, terms, type LibraryChant } from "./library";
import { describePitch, noteName } from "./notes";
import { drawMarks } from "./marks";
import { SCALE, Score } from "./score";
import { describeKey, drawRibbon, type Judged } from "./ribbon";
import { offerSignIn } from "./beam";
import { copyWhenReady, sendTake, signedIn } from "./send";
import { audioContext } from "./audio";
import { Drone, droneNote, modeNumber } from "./drone";
import { tapLoop } from "./loop";
import { Replay } from "./replay";
import { neutralTable, sing, type Singing, type SungNote, VoiceTable } from "./singer";
import { headphonesIn, ONSET_WINDOW, timed } from "./timing";

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
byId("kicker").textContent = ["Practice", kicker({ kind: piece.kind, mode: piece.mode })].filter(Boolean).join(" · ");
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
// and the note the ribbon is re-based on; on the score, the ribbon under the staff and the core's
// marks on the notes; below it, the words of the mark tapped. Where the chant has an aligned
// recording of the same notes, the ribbon draws its trace under the singer's.
const result = byId<HTMLElement>("result");
const summaryText = byId<HTMLParagraphElement>("summary");
const keyText = byId<HTMLParagraphElement>("key");
const recordedText = byId<HTMLParagraphElement>("recorded");
const recording = found?.recording ?? [];
const baseLine = byId<HTMLParagraphElement>("base");
const baseText = byId<HTMLSpanElement>("base-text");
const why = byId<HTMLParagraphElement>("why");
const cutText = byId<HTMLParagraphElement>("cut");
let shown: Judged | null = null;
/** The note the singer stopped the take shown at, or null when it ran to the end; and whether
 * the guide was in their headphones. */
let cutAt: number | null = null;
let shownWorn = false;
let base: number | null = null;
let open: number | null = null;

/** What the core found of a take it could not judge, and what to try. */
function unheard(judged: Judged): string {
  if (judged.verdict.outcome === "masked")
    return "The guide was louder than your voice, so too little of it was heard to judge the take. Use headphones, or untick Headphones so the guide gives only the opening notes.";
  const begin = shownWorn ? "with the guide" : "when the cursor appears";
  return `Too little of your voice was heard to judge the take. Sing nearer the microphone and a little louder, beginning ${begin}.`;
}

/** Shows `text` as the words of the mark open, announcing it only when it changes. */
function say(text: string): void {
  if (why.textContent !== text) why.textContent = text;
}

function drawResult(): void {
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
  if (!judged || key === null) {
    score.showStrips(null);
    say("");
    baseLine.hidden = true;
    recordedText.hidden = true;
    keyText.hidden = judged?.ribbon.length === 0;
    if (judged) keyText.textContent = unheard(judged);
    return;
  }
  keyText.hidden = false;
  const from = base === null ? 0 : (judged.ribbon[base]?.cents ?? 0);
  // The recording is of the chant as the library gave it, so not of another put on the page.
  const underlay = score.source === piece.gabc && recording.length === judged.ribbon.length ? recording : [];
  // Re-based on a note the recording has no value for, the ribbon draws no recording.
  recordedText.hidden = !underlay.some((b) => b.trace.length > 0) || (base !== null && (underlay[base]?.cents ?? null) === null);
  score.showStrips(
    (timeline, room) =>
      // The marks first, so that the keyboard reaches them before the bands.
      drawMarks(timeline.notes, judged.verdict.marks, room.shift, open) +
      drawRibbon(timeline.notes, judged.ribbon, room.stripTop, from, base, undefined, underlay),
  );
  say(open === null ? "" : (judged.told[open] ?? ""));
  keyText.textContent = `Your key: ${describeKey(key)}.`;
  baseLine.hidden = base === null;
  if (base !== null) baseText.textContent = `Measured from note ${base + 1}: ${describeKey(key + from)}.`;
}

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
  shown = judged;
  cutAt = judged ? cut : null;
  shownWorn = worn;
  base = null;
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

// Tapping a heard note's band re-bases the ribbon on it, and tapping a mark shows its words;
// tapping either again goes back.
function tap(target: EventTarget | null, keyboard: boolean): boolean {
  if (!shown) return false;
  const el = target as Element | null;
  const mark = el?.closest<SVGGElement>("[data-mark]");
  const band = el?.closest<SVGGElement>("[data-band]");
  let again: string;
  if (mark) {
    const k = Number(mark.dataset.mark);
    open = open === k ? null : k;
    again = `[data-mark="${k}"]`;
  } else if (band && !band.classList.contains("unheard")) {
    const index = Number(band.dataset.band);
    base = base === index ? null : index;
    again = `[data-band="${index}"]`;
  } else {
    return false;
  }
  steadily(drawResult);
  // The strips were drawn again; keep a keyboard's place, and the mark in view above its words.
  const now = score.host.querySelector<SVGGElement>(again);
  if (keyboard) now?.focus();
  if (mark && open !== null) now?.scrollIntoView({ block: "nearest" });
  return true;
}
score.host.addEventListener("click", (e) => {
  if (!tap(e.target, false)) tapScore(e);
});
score.host.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && tap(e.target, true)) e.preventDefault();
});
byId<HTMLButtonElement>("rebase").addEventListener("click", () => {
  base = null;
  steadily(drawResult);
});

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
}

async function startDrone(): Promise<void> {
  if (!guide) return;
  const press = ++drones;
  droneButton.setAttribute("aria-pressed", "true");
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
// phrase it ends, and a tap in the loop, or Whole chant, lets it go.
const loopText = byId<HTMLSpanElement>("loop-text");
const unloopButton = byId<HTMLButtonElement>("unloop");
const loopStyle = document.head.appendChild(document.createElement("style"));
let loop: [number, number] | null = null;
/** Counts plays, so a loop stopped while it waits between times round does not go on. */
let plays = 0;
/** The play under way, looped or not, until Play stops it or it ends. */
let playing: number | null = null;
/** The pause between times round a loop, in pulses. */
const BREATH = 2;

function setLoop(next: [number, number] | null): void {
  loop = next;
  const [a, b] = next ?? [0, -1];
  const ids = score.timeline.notes.slice(a, b + 1).map((n) => n.id);
  // A rule rather than classes on the ink, so the run stays marked when the score is drawn again.
  // Tinted lighter than the cursor's note, so it stands out within it, and only while the score
  // is free: not in a take, nor beside a take's result.
  const free = "body:not(.taking) main:not(:has(#result:not([hidden]))) #score";
  loopStyle.textContent = ids.length
    ? `${free} :is(${ids.map((id) => `[data-note~="${id}"]`).join(",")}):not(.cantor-current){fill:color-mix(in srgb, var(--rubric) 50%, var(--bg))}`
    : "";
  unloopButton.hidden = !next;
  loopText.textContent = next
    ? `Play goes over notes ${a + 1} to ${b + 1} until you stop it.`
    : "Tap a phrase or a bar on the score to play it over and over.";
}
unloopButton.addEventListener("click", () => {
  if (taking) return;
  stopPlay();
  setLoop(null);
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
  if (shown || taking || !guide) return;
  const i = tappedNote(e);
  if (i < 0) return;
  stopPlay();
  setLoop(tapLoop(loop, i, score.timeline.pauses, score.timeline.notes.length));
}

function stopPlay(): void {
  plays++;
  playing = null;
  stopHear();
  guide?.stop();
  playButton.setAttribute("aria-pressed", "false");
}

/** Plays the chant, or the loop over and over, until it ends or is stopped. */
async function play(): Promise<void> {
  if (!guide) return;
  const run = ++plays;
  playing = run;
  playButton.setAttribute("aria-pressed", "true");
  do {
    const started = await guide.play(loop ? { range: loop } : {});
    if (playing !== run) return;
    // Its onStop has let Play go; while the loop goes round it stays pressed.
    playButton.setAttribute("aria-pressed", "true");
    if (!started || !(await started.ended) || playing !== run || !loop) break;
    await wait(BREATH * guide.pulse);
  } while (playing === run && loop);
  if (playing === run) stopPlay();
}

// Your take plays the last take shown back against the score, from the audio the ear keeps
// for sending, the cursor on each note where it was due; on a phone it takes the place of
// Start note and Drone while a take is shown.
const hearButton = byId<HTMLButtonElement>("hear");
const replay = new Replay(score, cursor, () => hearButton.setAttribute("aria-pressed", "false"));
/** The take shown, as it may be heard again: its pulse and where its pulse 0 fell. */
let replayable: { pulse: number; offset: number } | null = null;
/** Counts presses of Your take and stops, so one stopped while its audio is fetched does not go on. */
let hears = 0;

function stopHear(): void {
  hears++;
  replay.stop();
  hearButton.setAttribute("aria-pressed", "false");
}

function offerReplay(take: { pulse: number; offset: number } | null): void {
  stopHear();
  replayable = take && { pulse: take.pulse, offset: take.offset };
  hearButton.hidden = !replayable;
}

async function hear(): Promise<void> {
  const take = replayable;
  if (!take) return;
  stopPlay();
  stopPitch();
  stopDrone();
  const press = ++hears;
  hearButton.setAttribute("aria-pressed", "true");
  try {
    const ctx = await audioContext();
    const { wav } = await listener.audio();
    if (press !== hears) return;
    await replay.play(ctx, wav, take.pulse, take.offset);
  } catch (error) {
    if (press !== hears) return;
    stopHear();
    setStatus(`Your take could not be played: ${error instanceof Error ? error.message : String(error)}`);
  }
}
hearButton.addEventListener("click", () => {
  if (hearButton.getAttribute("aria-pressed") === "true") return stopHear();
  void hear();
});

if (!guide) {
  playButton.title = noteButton.title = droneButton.title = "The guide voice could not load.";
  setStatus(playButton.title);
} else {
  playButton.disabled = noteButton.disabled = droneButton.disabled = false;
  droneButton.addEventListener("click", () => {
    if (droneButton.getAttribute("aria-pressed") === "true") return stopDrone();
    stopHear();
    void startDrone();
  });
  playButton.addEventListener("click", () => {
    if (guide.playing || playing !== null) return stopPlay();
    stopPitch();
    setStatus("");
    showResult(null);
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
  cueing?.stop();
  cueing = null;
  playButton.disabled = noteButton.disabled = droneButton.disabled = takeButton.disabled = !guide;
  takeButton.textContent = "Sing a take";
  readout.textContent = "–";
  readout.setAttribute("aria-live", "polite");
  headphonesBox.disabled = speedSelect.disabled = pitchSelect.disabled = unloopButton.disabled = false;
  holdChant(false);
  modeLine.hidden = !guide;
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
    // Shows the last take judged against `gabc` (put on the page if it is not there);
    // returns the JSON.
    show: async (gabc: string, pulse: number, offset: number) => {
      if (gabc !== score.source) {
        stopPlay();
        setLoop(null);
        offerReplay(null);
        score.setChant(new Chant(gabc));
      }
      const json = await listener.judge(gabc, pulse, offset);
      const judged = JSON.parse(json) as Judged;
      showResult(judged);
      offerSend({ gabc, pulse, offset, judged });
      return json;
    },
  };
}
