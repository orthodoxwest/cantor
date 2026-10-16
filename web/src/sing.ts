import { Chant, init } from "neuma";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
import { Listener } from "./listen";
import { describePitch } from "./notes";
import { SAMPLE } from "./sample";
import { Score } from "./score";
import { drawMarks } from "./marks";
import { describeKey, drawRibbon, type Judged } from "./ribbon";
import { neutralTable, VoiceTable } from "./singer";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
// ?test=1 pins the cursor to the page's clock, which tests can fake.
const test = params.get("test") === "1";
// ?voice=URL sings the guide with a recorded voice file; without it, or if it fails to load,
// the guide sings the neutral vowel.
const voiceUrl = params.get("voice");

await init();
const score = new Score(byId("score"), new Chant(SAMPLE));
const cursor = new Cursor(score);

// After a take (for now only through `__cantor.show`, until a take is timed against the
// chant): the ribbon under the staff, the core's marks on the notes, the singer's key, the
// note the ribbon is re-based on, and the words of the mark tapped.
const result = byId<HTMLElement>("result");
const keyText = byId<HTMLParagraphElement>("key");
const baseLine = byId<HTMLParagraphElement>("base");
const baseText = byId<HTMLSpanElement>("base-text");
const why = byId<HTMLParagraphElement>("why");
let shown: Judged | null = null;
let base: number | null = null;
let open: number | null = null;

function drawResult(): void {
  if (!shown) {
    score.showStrips(null);
    result.hidden = true;
    return;
  }
  const judged = shown;
  const key = judged.verdict.key_cents;
  result.hidden = false;
  if (key === null) {
    score.showStrips(null);
    keyText.textContent = "Too little was heard to show.";
    baseLine.hidden = true;
    why.hidden = true;
    return;
  }
  const from = base === null ? 0 : (judged.ribbon[base]?.cents ?? 0);
  score.showStrips(
    (timeline, room) =>
      // The marks first, so that the keyboard reaches them before the bands.
      drawMarks(timeline.notes, judged.verdict.marks, room.shift, open) +
      drawRibbon(timeline.notes, judged.ribbon, room.stripTop, from, base),
  );
  why.hidden = open === null;
  why.textContent = open === null ? "" : (judged.told[open] ?? "");
  keyText.textContent = `Your key: ${describeKey(key)}.`;
  baseLine.hidden = base === null;
  if (base !== null) baseText.textContent = `Measured from note ${base + 1}: ${describeKey(key + from)}.`;
}

/** Shows a judged take, or clears it. */
function showResult(judged: Judged | null): void {
  shown = judged;
  base = null;
  open = null;
  // The ribbon says what was heard; the length of the take is no longer news.
  if (judged) status.textContent = "";
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
  // The strips were drawn again; keep a keyboard's place.
  if (keyboard) score.host.querySelector<SVGGElement>(again)?.focus();
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
const failedListening = (error: unknown) =>
  (status.textContent = `Listening failed: ${error instanceof Error ? error.message : String(error)}`);
const listener = new Listener(
  (frame) => {
    const text = frame.midi === null ? "–" : describePitch(frame.midi);
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
      (h) => (status.textContent = `Heard ${h.seconds.toFixed(1)} s.`),
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
    gabc: SAMPLE,
    clock: test ? () => performance.now() / 1000 : undefined,
    onStop: () => playButton.setAttribute("aria-pressed", "false"),
    onError: (message) => (status.textContent = message),
  });
if (!guide) {
  playButton.title = "The guide voice could not load.";
  status.textContent = playButton.title;
} else {
  playButton.disabled = false;
  playButton.addEventListener("click", () => {
    if (guide.playing) return guide.stop();
    status.textContent = "";
    showResult(null);
    playButton.setAttribute("aria-pressed", "true");
    void guide.play();
  });
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
    // Shows the last take judged against `gabc` (put on the page if it is not there), as
    // the after-take view will once a take is timed against the chant; returns the JSON.
    show: async (gabc: string, pulse: number, offset: number) => {
      if (gabc !== score.source) score.setChant(new Chant(gabc));
      const json = await listener.judge(gabc, pulse, offset);
      showResult(JSON.parse(json) as Judged);
      return json;
    },
  };
}
