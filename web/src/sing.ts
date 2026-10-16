import { Chant, init } from "neuma";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
import { Listener } from "./listen";
import { describePitch } from "./notes";
import { SAMPLE } from "./sample";
import { Score } from "./score";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// ?test=1 pins the cursor to the page's clock, which tests can fake.
const test = new URLSearchParams(location.search).get("test") === "1";

await init();
const score = new Score(byId("score"), new Chant(SAMPLE));
const cursor = new Cursor(score);

const playButton = byId<HTMLButtonElement>("play");
const guide = new Guide(score, cursor, {
  clock: test ? () => performance.now() / 1000 : undefined,
  onStop: () => playButton.setAttribute("aria-pressed", "false"),
});
playButton.addEventListener("click", () => {
  if (guide.playing) return guide.stop();
  playButton.setAttribute("aria-pressed", "true");
  void guide.play();
});

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

if (test) {
  (window as Window & { __cantor?: unknown }).__cantor = {
    frames: listener.frames,
    timeline: score.timeline,
    visited: guide.visited,
  };
}
