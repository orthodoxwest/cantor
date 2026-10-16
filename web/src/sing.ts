import { Chant, init } from "neuma";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
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

// After a scored take: the ribbon under the staff, the core's marks on the notes, the core's
// two sentences on the take, the singer's key, the note the ribbon is re-based on, and the words
// of the mark tapped. Where the chant has an aligned recording of the same notes, the ribbon
// draws its trace under the singer's.
const result = byId<HTMLElement>("result");
const summaryText = byId<HTMLParagraphElement>("summary");
const keyText = byId<HTMLParagraphElement>("key");
const recordedText = byId<HTMLParagraphElement>("recorded");
const recording = found?.recording ?? [];
const baseLine = byId<HTMLParagraphElement>("base");
const baseText = byId<HTMLSpanElement>("base-text");
const why = byId<HTMLParagraphElement>("why");
let shown: Judged | null = null;
let base: number | null = null;
let open: number | null = null;

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
  if (!judged || key === null) {
    score.showStrips(null);
    say("");
    baseLine.hidden = true;
    recordedText.hidden = true;
    if (judged) keyText.textContent = "Too little was heard to show.";
    return;
  }
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

/** Shows a judged take, or clears it. */
function showResult(judged: Judged | null): void {
  shown = judged;
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
  drawResult();
  // The strips were drawn again; keep a keyboard's place, and the mark in view above its words.
  const now = score.host.querySelector<SVGGElement>(again);
  if (keyboard) now?.focus();
  if (mark && open !== null) now?.scrollIntoView({ block: "nearest" });
  return true;
}
score.host.addEventListener("click", (e) => tap(e.target, false));
score.host.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && tap(e.target, true)) e.preventDefault();
});
byId<HTMLButtonElement>("rebase").addEventListener("click", () => {
  base = null;
  drawResult();
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
    onStop: () => playButton.setAttribute("aria-pressed", "false"),
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
  guide.stop();
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

if (!guide) {
  playButton.title = noteButton.title = "The guide voice could not load.";
  setStatus(playButton.title);
} else {
  playButton.disabled = noteButton.disabled = false;
  playButton.addEventListener("click", () => {
    if (guide.playing) return guide.stop();
    stopPitch();
    setStatus("");
    showResult(null);
    playButton.setAttribute("aria-pressed", "true");
    void guide.play();
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

async function takeScored(): Promise<void> {
  if (!guide || !table) return;
  const take = ++takes;
  // A take that is no longer going leaves the page alone: whatever stopped it has seen to it.
  const going = () => taking && take === takes;
  taking = true;
  timing = null;
  // Nothing else sounds or listens during a take.
  guide.stop();
  stopPitch();
  listener.stop();
  playButton.disabled = noteButton.disabled = headphonesBox.disabled = true;
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
    const finished = await started.ended;
    if (finished) await wait(TAIL);
    if (!going()) return;
    listener.stop();
    if (!finished) return;
    setStatus("");
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
    const json = await listener.judge(score.source, guide.pulse, offset);
    if (!going()) return;
    const judged = JSON.parse(json) as Judged;
    showResult(judged);
    offerSend({ gabc: score.source, pulse: guide.pulse, offset, judged });
  } catch (error) {
    if (going()) setStatus(`The take failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (take === takes) endTake();
  }
}

/** Ends the take under way at once, so that nothing of it touches the page again. */
function stopTake(): void {
  takes++;
  // The listener stops first, so its last frames do not reach the readout.
  listener.stop();
  guide?.stop();
  endTake();
}

function endTake(): void {
  taking = false;
  cueing?.stop();
  cueing = null;
  playButton.disabled = noteButton.disabled = !guide;
  takeButton.textContent = "Sing a take";
  readout.setAttribute("aria-live", "polite");
  headphonesBox.disabled = false;
  holdChant(false);
  modeLine.hidden = !guide;
  void detect();
}

if (guide) {
  takeButton.disabled = false;
  takeButton.addEventListener("click", () => {
    if (!taking) return void takeScored();
    stopTake();
    setStatus("The take was stopped.", true);
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
    get chunks() {
      return guide?.chunks ?? [];
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
      if (gabc !== score.source) score.setChant(new Chant(gabc));
      if (guide) {
        guide.gabc = gabc;
        guide.pulse = pulse;
      }
    },
    /** The page's times for the notes on it, at `pulse` seconds a pulse. */
    timed: (pulse: number) => timed(score.timeline.notes, pulse),
    // Shows the last take judged against `gabc` (put on the page if it is not there);
    // returns the JSON.
    show: async (gabc: string, pulse: number, offset: number) => {
      if (gabc !== score.source) score.setChant(new Chant(gabc));
      const json = await listener.judge(gabc, pulse, offset);
      const judged = JSON.parse(json) as Judged;
      showResult(judged);
      offerSend({ gabc, pulse, offset, judged });
      return json;
    },
  };
}
