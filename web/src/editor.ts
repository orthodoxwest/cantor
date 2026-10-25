// The editor page: GABC typed into the source, engraved as it changes (coalesced to frames),
// with neuma's diagnostics listed under it and their fixes a tap away; a note tapped in the score
// is marked and its source selected, and Play sings the score in the guide voice. Under it, a
// short guide to GABC whose examples are engraved as written and can be put in the editor.
import { Chant, type Diagnostic, init } from "neuma";
import { offerSignIn } from "./beam";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
import { escape } from "./library";
import { SCALE, Score } from "./score";
import { neutralTable } from "./singer";

void offerSignIn();

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  source: byId<HTMLTextAreaElement>("source"),
  problems: byId<HTMLUListElement>("problems"),
  heard: byId("heard"),
  again: byId<HTMLButtonElement>("again"),
  score: byId("score"),
  status: byId("status"),
  play: byId<HTMLButtonElement>("play"),
  copy: byId<HTMLButtonElement>("copy"),
};

/** What the editor holds, kept in this browser between visits. */
const KEPT = "editor-gabc";
const START = `name:Ubi caritas;
mode:6;
%%
(c4) WHere(f) cha(gh)ri(hg)ty(h) and(ixi) love(hg) are,(hg) (,) there(f) is(fg) God.(g) (::)`;

function kept(): string | null {
  try {
    return localStorage.getItem(KEPT);
  } catch {
    return null;
  }
}
function keep(gabc: string): void {
  try {
    localStorage.setItem(KEPT, gabc);
  } catch {
    // A browser that keeps nothing starts from the example next time.
  }
}

await init();

// Anything typed while the engine loaded stays.
const early = els.source.value !== "";
if (!early) els.source.value = kept() ?? START;
const score = new Score(els.score, new Chant(els.source.value), SCALE);
const cursor = new Cursor(score);

// ---- the source and its problems ---------------------------------------------------------

/** The source grows with what it holds, from a few lines to most of a phone's screen. */
function fit(): void {
  els.source.style.height = "auto";
  els.source.style.height = `${Math.min(els.source.scrollHeight + 2, Math.max(window.innerHeight * 0.4, 160))}px`;
}

const SEVERITY = { error: "Error", warning: "Warning", info: "Note" } as const;

let problems: Diagnostic[] = [];
/** The problems as last drawn, so the list is drawn again only when they change. */
let drawn = "";

/** neuma's messages set code in backticks; it is shown as code. */
const words = (s: string) => escape(s).replace(/`([^`]+)`/g, "<code>$1</code>");

function drawProblems(): void {
  problems = score.diagnostics;
  const key = JSON.stringify(problems.map((d) => [d.code, d.utf16Start, d.message]));
  if (key === drawn) return;
  const before = drawn ? (JSON.parse(drawn) as unknown[]).length : 0;
  drawn = key;
  els.problems.innerHTML = problems
    .map(
      (d, i) => `<li class="${d.severity}">
  <button type="button" class="where" data-at="${i}">${SEVERITY[d.severity]}, line ${line(d.utf16Start)}:</button>
  <span>${words(d.message)}</span>${d.fix ? ` <button type="button" class="btn fix" data-fix="${i}">${words(d.fix.title)}</button>` : ""}</li>`,
    )
    .join("");
  // Only a change in how many problems there are is said aloud, not each keystroke's list.
  if (problems.length !== before)
    els.heard.textContent = problems.length === 0 ? "No problems." : problems.length === 1 ? "1 problem." : `${problems.length} problems.`;
}

/** The line of the source a position is on, counting from 1. */
function line(at: number): number {
  return els.source.value.slice(0, at).split("\n").length;
}

/** Replaces part of the source as an edit the browser can undo, where it can. */
function replace(start: number, end: number, text: string): void {
  els.source.focus();
  els.source.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, text)) {
    els.source.setRangeText(text, start, end, "end");
    els.source.dispatchEvent(new Event("input"));
  }
}

els.problems.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("button");
  if (!button) return;
  // The problems answer for the source as last engraved; after a keystroke not yet engraved,
  // the list is drawn again for what is there now rather than acting on the old one.
  if (score.source !== els.source.value) {
    cancelAnimationFrame(frame);
    engrave();
    return;
  }
  const at = problems[Number(button.dataset.at)];
  if (at) {
    els.source.focus();
    els.source.setSelectionRange(at.utf16Start, at.utf16End);
    return;
  }
  const fix = problems[Number(button.dataset.fix)]?.fix;
  if (fix) replace(fix.utf16Start, fix.utf16End, fix.replacement);
});

/** Whether the source is the visitor's own, to be kept; a guide's example put in is not, until
 * it is edited. */
let own = early;
/** Set while an example is put in. */
let putting = false;

let frame = 0;
function engrave(): void {
  frame = 0;
  stopGuide();
  mark(null);
  els.status.textContent = "";
  score.update(els.source.value);
  drawProblems();
  if (own) keep(els.source.value);
}
els.source.addEventListener("input", () => {
  if (!putting) own = true;
  fit();
  frame ||= requestAnimationFrame(engrave);
});
fit();
drawProblems();

/** Puts `gabc` in the editor as an edit undo takes back, without keeping it as the visitor's. */
function put(gabc: string): void {
  putting = true;
  replace(0, els.source.value.length, gabc);
  putting = false;
  own = false;
}
els.again.addEventListener("click", () => put(START));

// A note tapped in the score is marked, and its source (or a bar's or syllable's) selected.
let marked: number | null = null;
function mark(id: number | null): void {
  if (marked !== null) for (const el of score.ink(marked)) el.classList.remove("cantor-current");
  marked = id;
  if (id !== null) for (const el of score.ink(id)) el.classList.add("cantor-current");
}
// The score drawn afresh (the page grew a scrollbar, a phone turned) keeps the tapped note marked.
score.onRender = () => {
  if (marked !== null) for (const el of score.ink(marked)) el.classList.add("cantor-current");
};
els.score.addEventListener("click", (e) => {
  if (guide?.playing) return;
  const box = els.score.getBoundingClientRect();
  const hit = score.sourceAt(e.clientX - box.left, e.clientY - box.top);
  if (!hit) return;
  mark(hit.kind === "note" ? hit.index : null);
  // The browser scrolls the source to the selection; the page then brings the source into view.
  els.source.focus({ preventScroll: true });
  els.source.setSelectionRange(hit.utf16Start, hit.utf16End);
  els.source.scrollIntoView({ block: "nearest", behavior: "smooth" });
});

window.addEventListener("resize", fit);

// ---- playing and copying -----------------------------------------------------------------

let guide: Guide | null = null;

function stopGuide(): void {
  guide?.stop();
  els.play.setAttribute("aria-pressed", "false");
  els.play.textContent = "Play";
}

void neutralTable().then(
  (table) => {
    guide = new Guide(score, cursor, {
      table,
      gabc: els.source.value,
      onStop: () => {
        els.play.setAttribute("aria-pressed", "false");
        els.play.textContent = "Play";
      },
      onError: (message) => (els.status.textContent = message),
    });
    els.play.disabled = false;
  },
  () => (els.status.textContent = "The guide voice could not load."),
);

els.play.addEventListener("click", () => {
  if (!guide) return;
  if (guide.playing) return stopGuide();
  if (!score.timeline.notes.length) {
    els.status.textContent = "There are no notes to sing yet.";
    return;
  }
  els.status.textContent = "";
  mark(null);
  guide.gabc = els.source.value;
  els.play.setAttribute("aria-pressed", "true");
  els.play.textContent = "Stop";
  void guide.play();
});

let copied = 0;
els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.source.value);
    els.copy.textContent = "Copied";
  } catch {
    els.source.focus();
    els.source.select();
    els.copy.textContent = "Select and copy";
  }
  clearTimeout(copied);
  copied = window.setTimeout(() => (els.copy.textContent = "Copy GABC"), 2000);
});

// ---- the guide's examples ----------------------------------------------------------------

/** An example on one line is drawn only as wide as its music, not across the column. */
function trimmed(view: ReturnType<Chant["view"]>, width: number): string {
  const page = view.layout(width);
  const svg = page.svg ?? "";
  const { notes, pauses, lines } = page.timeline();
  if (lines.length !== 1) return svg;
  const ends = [...notes.map((n) => n.cx + n.w / 2), ...pauses.map((p) => (p.bar ? p.bar.x + p.bar.w : 0))];
  const right = Math.ceil(Math.max(...ends) + SCALE * 1.5);
  if (!(right < page.width)) return svg;
  return svg
    .replace(/ width="[\d.]+"/, ` width="${right}"`)
    .replace(/viewBox="([\d.]+) ([\d.]+) [\d.]+ ([\d.]+)"/, `viewBox="$1 $2 ${right} $3"`);
}

for (const el of document.querySelectorAll<HTMLElement>(".example[data-gabc]")) {
  const gabc = el.dataset.gabc ?? "";
  el.innerHTML = `<pre class="code"><code>${escape(gabc)}</code></pre><div class="engraved" aria-hidden="true"></div>
<button type="button" class="btn try">Try it</button>`;
  const engraved = el.querySelector<HTMLElement>(".engraved")!;
  // Engraved as the editor engraves it, initial and all, but where the words are sol-fa names.
  const view = new Chant(gabc, { initial: el.dataset.initial === "0" ? 0 : 1 }).view({ ids: false, scale: SCALE });
  let width = 0;
  const draw = () => {
    if (engraved.clientWidth === width) return;
    width = engraved.clientWidth;
    engraved.innerHTML = trimmed(view, width);
  };
  draw();
  new ResizeObserver(draw).observe(engraved);
  el.querySelector(".try")!.addEventListener("click", () => {
    put(gabc);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}
