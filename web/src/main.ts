import { Chant, init } from "neuma";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
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
