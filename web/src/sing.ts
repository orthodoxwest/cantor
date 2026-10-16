import { Chant, init } from "neuma";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
import { Listener } from "./listen";
import { describePitch } from "./notes";
import { SAMPLE } from "./sample";
import { Score } from "./score";
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

const listenButton = byId<HTMLButtonElement>("listen");
const readout = byId<HTMLOutputElement>("readout");
const listener = new Listener((frame) => {
  const text = frame.midi === null ? "–" : describePitch(frame.midi);
  if (readout.textContent !== text) readout.textContent = text;
});
listenButton.addEventListener("click", async () => {
  if (listener.listening) {
    listener.stop();
    listenButton.setAttribute("aria-pressed", "false");
    listener.heard?.then(
      (h) => (status.textContent = `Heard ${h.seconds.toFixed(1)} s.`),
      (error: unknown) => (status.textContent = `Listening failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    return;
  }
  listenButton.setAttribute("aria-pressed", "true");
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
const status = byId<HTMLParagraphElement>("status");
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
    playButton.setAttribute("aria-pressed", "true");
    void guide.play();
  });
}

if (test) {
  (window as Window & { __cantor?: unknown }).__cantor = {
    frames: listener.frames,
    timeline: score.timeline,
    visited: guide?.visited ?? [],
    get chunks() {
      return guide?.chunks ?? [];
    },
    voice: recorded ? "recorded" : table ? "neutral" : "none",
    heard: () => listener.heard,
    judge: (gabc: string, pulse: number, offset: number) => listener.judge(gabc, pulse, offset),
  };
}
