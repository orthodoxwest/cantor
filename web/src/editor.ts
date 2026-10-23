// The editor page: GABC typed into the source, engraved as it changes (coalesced to frames),
// with neuma's diagnostics listed under it and their fixes a tap away; a note tapped in the score
// selects its source, and Play sings the score in the guide voice. Under it, a short guide to
// GABC whose examples are engraved as written and can be put in the editor.
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

els.source.value = kept() ?? START;
const score = new Score(els.score, new Chant(els.source.value), SCALE);
const cursor = new Cursor(score);

// ---- the source and its problems ---------------------------------------------------------

let problems: Diagnostic[] = [];

function drawProblems(): void {
  problems = score.diagnostics;
  els.problems.innerHTML = problems
    .map(
      (d, i) => `<li class="${d.severity === "error" ? "error" : "warning"}">
  <button type="button" class="where" data-at="${i}">${d.severity === "error" ? "Error" : "Warning"}, at ${line(d.utf16Start)}:</button>
  ${escape(d.message)}${d.fix ? ` <button type="button" class="btn fix" data-fix="${i}">${escape(d.fix.title)}</button>` : ""}</li>`,
    )
    .join("");
}

/** "line 3" for a position in the source. */
function line(at: number): string {
  return `line ${els.source.value.slice(0, at).split("\n").length}`;
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
  const at = problems[Number(button.dataset.at)];
  if (at) {
    els.source.focus();
    els.source.setSelectionRange(at.utf16Start, at.utf16End);
    return;
  }
  const fix = problems[Number(button.dataset.fix)]?.fix;
  if (fix) replace(fix.utf16Start, fix.utf16End, fix.replacement);
});

let frame = 0;
function engrave(): void {
  frame = 0;
  stopGuide();
  score.update(els.source.value);
  drawProblems();
  keep(els.source.value);
}
els.source.addEventListener("input", () => {
  frame ||= requestAnimationFrame(engrave);
});
drawProblems();

// A note, bar or syllable tapped in the score selects its source, scrolled into view.
els.score.addEventListener("click", (e) => {
  const box = els.score.getBoundingClientRect();
  const hit = score.sourceAt(e.clientX - box.left, e.clientY - box.top);
  if (!hit) return;
  els.source.focus({ preventScroll: true });
  els.source.setSelectionRange(hit.utf16Start, hit.utf16End);
  // Scrolls the textarea to the selection's line, and the page to the textarea.
  const lines = els.source.value.slice(0, hit.utf16Start).split("\n").length - 1;
  const height = parseFloat(getComputedStyle(els.source).lineHeight) || 24;
  els.source.scrollTop = Math.max(0, lines * height - els.source.clientHeight / 2);
  els.source.scrollIntoView({ block: "nearest", behavior: "smooth" });
});

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

for (const el of document.querySelectorAll<HTMLElement>(".example[data-gabc]")) {
  const gabc = el.dataset.gabc ?? "";
  el.innerHTML = `<pre class="code"><code>${escape(gabc)}</code></pre><div class="engraved" aria-hidden="true"></div>
<button type="button" class="btn try">Try it</button>`;
  const engraved = el.querySelector<HTMLElement>(".engraved")!;
  // Only an example about the header shows the initial, where its mode is printed.
  const chant = new Chant(gabc, { initial: el.hasAttribute("data-initial") ? 1 : 0 });
  const view = chant.view({ ids: false });
  const draw = () => (engraved.innerHTML = view.layout(engraved.clientWidth).svg ?? "");
  draw();
  new ResizeObserver(draw).observe(engraved);
  el.querySelector(".try")!.addEventListener("click", () => {
    replace(0, els.source.value.length, gabc);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}
