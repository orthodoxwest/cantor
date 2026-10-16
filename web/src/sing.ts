import { Chant, init } from "neuma";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
import { Listener } from "./listen";
import { kicker, library, chant as findChant } from "./library";
import { describePitch, noteName } from "./notes";
import { drawMarks } from "./marks";
import { SCALE, Score } from "./score";
import { describeKey, drawRibbon, type Judged } from "./ribbon";
import { audioContext } from "./audio";
import { neutralTable, sing, type Singing, type SungNote, VoiceTable } from "./singer";
import { firstNoteAt, firstSound, headphonesIn, ONSET_EARLY, ONSET_WINDOW, timed } from "./timing";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
// ?test=1 pins the cursor to the page's clock, which tests can fake.
const test = params.get("test") === "1";
// ?voice=URL sings the guide with a recorded voice file; without it, or if it fails to load,
// the guide sings the neutral vowel.
const voiceUrl = params.get("voice");

await init();
// ?chant=SLUG picks a chant from the library; the first route's chant otherwise.
const DEFAULT = "lumen-gentium";
const piece = findChant(params.get("chant") ?? DEFAULT) ?? findChant(DEFAULT)!;
byId("kicker").textContent = ["Practice", kicker(piece)].filter(Boolean).join(" · ");
byId("title").textContent = piece.title;
document.title = `${piece.title} · Practice · Cantor`;
const picker = byId<HTMLSelectElement>("chant");
for (const c of library()) picker.add(new Option(`${c.title}${c.name ? ` (${c.name})` : ""}`, c.slug, false, c === piece));
picker.addEventListener("change", () => {
  params.set("chant", picker.value);
  location.search = params.toString();
});
const score = new Score(byId("score"), new Chant(piece.gabc), SCALE);
const cursor = new Cursor(score);

// After a scored take: the ribbon under the staff, the core's marks on the notes, the singer's key, the
// note the ribbon is re-based on, and the words of the mark tapped.
const result = byId<HTMLElement>("result");
const keyText = byId<HTMLParagraphElement>("key");
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
  if (!judged || key === null) {
    score.showStrips(null);
    say("");
    baseLine.hidden = true;
    if (judged) keyText.textContent = "Too little was heard to show.";
    return;
  }
  const from = base === null ? 0 : (judged.ribbon[base]?.cents ?? 0);
  score.showStrips(
    (timeline, room) =>
      // The marks first, so that the keyboard reaches them before the bands.
      drawMarks(timeline.notes, judged.verdict.marks, room.shift, open) +
      drawRibbon(timeline.notes, judged.ribbon, room.stripTop, from, base),
  );
  say(open === null ? "" : (judged.told[open] ?? ""));
  keyText.textContent = `Your key: ${describeKey(key)}.`;
  baseLine.hidden = base === null;
  if (base !== null) baseText.textContent = `Measured from note ${base + 1}: ${describeKey(key + from)}.`;
}

/** Shows a judged take, or clears it. */
function showResult(judged: Judged | null): void {
  shown = judged;
  base = null;
  open = null;
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

const listenButton = byId<HTMLButtonElement>("listen");
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
const listener = new Listener(
  (frame) => {
    // During a take the readout says only the note, quietly: the cents from concert pitch
    // would read as a verdict, and the singer's key is their own.
    const text = frame.midi === null ? "–" : taking ? noteName(frame.midi) : describePitch(frame.midi);
    if (readout.textContent !== text) readout.textContent = text;
  },
  (error) => {
    listenButton.setAttribute("aria-pressed", "false");
    failedListening(error);
  },
);
listenButton.addEventListener("click", async () => {
  if (listener.listening) {
    listener.stop();
    listenButton.setAttribute("aria-pressed", "false");
    listener.heard?.then(
      (h) => setStatus((heardLine = `Heard ${h.seconds.toFixed(1)} s.`), true),
      failedListening,
    );
    return;
  }
  listenButton.setAttribute("aria-pressed", "true");
  showResult(null);
  try {
    await listener.start();
  } catch (error) {
    listenButton.setAttribute("aria-pressed", "false");
    readout.textContent = error instanceof Error ? error.message : String(error);
  }
});

// Play (disabled in the page) waits for the voice; without one the guide stays off and
// listening still works.
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
if (!guide) {
  playButton.title = "The guide voice could not load.";
  setStatus(playButton.title);
} else {
  playButton.disabled = false;
  playButton.addEventListener("click", () => {
    if (guide.playing) return guide.stop();
    setStatus("");
    showResult(null);
    playButton.setAttribute("aria-pressed", "true");
    void guide.play();
  });
}

// A scored take. The guide through the speaker would reach the microphone, so it is never
// scored: with headphones the guide sings the take in the singer's ears; without, it gives
// the opening notes (the first and the reciting tone) and then the cursor alone leads.
const takeButton = byId<HTMLButtonElement>("take");
const modeText = byId<HTMLSpanElement>("mode");
const headphonesBox = byId<HTMLInputElement>("headphones");
/** What the browser says of headphones, until the singer says otherwise. */
let detected: boolean | null = null;
let chosen = false;
/** How long the cursor waits before the chant begins, after listening begins, in seconds. */
const LEAD = 1.5;
/** How long listening goes on after the last note is due, in seconds: past the latest a take
 * timed by the singer's first sound may run ([`ONSET_WINDOW`]). */
const TAIL = ONSET_WINDOW + 0.5;
/** How the last take was timed, in seconds of the take: when its first note was due, when the
 * singer first sounded, and the first note's start it was judged by. */
let timing: { due: number; sound: number | null; at: number } | null = null;

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
}

async function detect(): Promise<void> {
  try {
    detected = headphonesIn(await navigator.mediaDevices.enumerateDevices());
  } catch {
    detected = null;
  }
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

/** Counts takes, so a take stopped while it is starting does not go on. */
let takes = 0;
let taking = false;
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
  if (listener.listening) {
    listener.stop();
    listenButton.setAttribute("aria-pressed", "false");
  }
  playButton.disabled = listenButton.disabled = true;
  takeButton.textContent = "Stop";
  readout.textContent = "–";
  readout.setAttribute("aria-live", "off");
  showResult(null);
  setStatus("");
  try {
    const ctx = await audioContext();
    await allowMicrophone();
    if (!going()) return;
    await detect();
    if (!going()) return;
    const worn = headphonesBox.checked;
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
    const sound = firstSound(listener.frames, heard.startedAt, heard.onset, due - ONSET_EARLY);
    const at = firstNoteAt(due, sound);
    timing = { due, sound, at };
    const json = await listener.judge(score.source, guide.pulse, at - started.first);
    if (going()) showResult(JSON.parse(json) as Judged);
  } catch (error) {
    if (going()) setStatus(`The take failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (take === takes) endTake();
  }
}

function endTake(): void {
  taking = false;
  cueing?.stop();
  cueing = null;
  playButton.disabled = !guide;
  listenButton.disabled = false;
  takeButton.textContent = "Sing a take";
  readout.setAttribute("aria-live", "polite");
}

if (guide) {
  takeButton.disabled = false;
  takeButton.addEventListener("click", () => {
    if (!taking) return void takeScored();
    takes++;
    endTake();
    guide.stop();
    listener.stop();
    setStatus("The take was stopped.", true);
  });
} else {
  takeButton.title = "The guide voice could not load.";
  modeText.parentElement!.hidden = true;
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
    voice: recorded ? "recorded" : table ? "neutral" : "none",
    heard: () => listener.heard,
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
      showResult(JSON.parse(json) as Judged);
      return json;
    },
  };
}
