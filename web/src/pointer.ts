// The psalm pointer: a psalm (or typed text) pointed for a tone, its accents moved by hand,
// sung in the guide voice, and exported as text, GABC or SVG.
import { Chant, type PsalmDisplay, type TimelineNote, init, psalm, psalmDisplay, toneLabel, toneNames } from "neuma";
import { GLORIA, type Half, type HalfKey, halfKey, moveAccents, pointText, psalmText } from "./pointing";
import { Player } from "./player";
import { decode, encode } from "./share";

interface PsalterEntry {
  id: string;
  number: number;
  part?: string;
  first: number;
  incipit: string;
  verses: string[];
}

/** A psalm as a parish booklet points it, from /api/pointing/:psalm when the visitor may see it. */
interface Booklet {
  id: string;
  /** The tone as the booklet prints it ("viii.1"). */
  label: string;
  /** The built-in tone it is sung to: one whose ending matches, or is a note away; else null. */
  tone: string | null;
  /** The closest built-in tone, however far. */
  nearest: string | null;
  match: "exact" | "close" | "none";
  section: string | null;
  verses: Array<{ n: number; pointed: string; gloria?: boolean }>;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// ?test=1 pins the follower to the page's clock, which tests can fake.
const test = new URLSearchParams(location.search).get("test") === "1";

const [{ psalms }] = await Promise.all([
  import("../../content/psalter.json") as Promise<{ psalms: PsalterEntry[] }>,
  init(),
]);
const psalter = new Map(psalms.map((p) => [p.id, p]));

const els = {
  psalm: byId<HTMLSelectElement>("psalm"),
  source: byId<HTMLSelectElement>("source"),
  sourceLabel: byId<HTMLLabelElement>("source-label"),
  tone: byId<HTMLSelectElement>("tone"),
  gloria: byId<HTMLInputElement>("gloria"),
  ownLabel: byId<HTMLLabelElement>("own-label"),
  range: byId<HTMLElement>("range"),
  from: byId<HTMLInputElement>("from"),
  to: byId<HTMLInputElement>("to"),
  own: byId<HTMLTextAreaElement>("own"),
  toneLabel: byId<HTMLElement>("tone-label"),
  toneScore: byId<HTMLDivElement>("tone-score"),
  play: byId<HTMLButtonElement>("play"),
  speed: byId<HTMLSelectElement>("speed"),
  pitch: byId<HTMLSelectElement>("pitch"),
  undo: byId<HTMLButtonElement>("undo"),
  check: byId<HTMLButtonElement>("check"),
  status: byId<HTMLParagraphElement>("status"),
  verses: byId<HTMLDivElement>("verses"),
  notation: byId<HTMLDetailsElement>("notation"),
  score: byId<HTMLDivElement>("score"),
};

const OWN = "own";
const DEFAULT = { psalm: "23", tone: "8.G" };

// ---- state -------------------------------------------------------------------------------

interface Snapshot {
  setting: string | null;
  tone: string;
  gloria: boolean;
  verses: [number, number] | null;
  own: string;
  text: string;
  unsure: Set<HalfKey>;
}

const state = {
  psalm: DEFAULT.psalm,
  /** The booklet setting shown, or null for the pointer's own suggestion. */
  setting: null as string | null,
  tone: DEFAULT.tone,
  gloria: true,
  transpose: 0,
  /** The verses sung, by number, or null for the whole psalm. */
  verses: null as [number, number] | null,
  /** Typed text, for the "own" psalm. */
  own: "",
  /** The pointed text as shown. */
  text: "",
  /** What pointing the source gives, to tell an edited text from it. */
  auto: "",
  /** Halves the pointer was unsure of, not since edited. */
  unsure: new Set<HalfKey>(),
  display: undefined as PsalmDisplay | undefined,
};
const undoStack: Snapshot[] = [];
/** The booklet settings of the psalm shown, when the visitor may see them. */
let booklets: Booklet[] = [];
const booklet = () => booklets.find((b) => b.id === state.setting);

/** Text as the pointer reads it: precomposed accents, plain spaces. */
const clean = (text: string) =>
  text
    .normalize("NFC")
    .replace(/\u2060/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n");

function sourceText(): string {
  if (state.psalm === OWN) {
    // Without blank lines, so that a line of the text is a verse of the pointing.
    const own = clean(state.own).split("\n").filter((l) => l.trim()).join("\n");
    return state.gloria ? [own, ...psalmText([], 1, true).split("\n")].filter(Boolean).join("\n") : own;
  }
  const entry = psalter.get(state.psalm) ?? psalter.get(DEFAULT.psalm)!;
  const [from, to] = range(entry);
  const b = booklet();
  if (b) {
    // The booklet's own pointing, verbatim, for the verses it has.
    const lines = b.verses.filter((v) => !v.gloria && v.n >= from && v.n <= to).map((v) => `${v.n} ${clean(v.pointed)}`);
    return [...lines, ...(state.gloria ? [gloriaText().text] : [])].join("\n");
  }
  return psalmText(entry.verses.slice(from - entry.first, to - entry.first + 1), from, state.gloria);
}

/** The Gloria pointed for the tone: the booklet's, when one is shown and has it. */
function gloriaText(): { text: string; unsure: HalfKey[] } {
  const gloria = booklet()?.verses.filter((v) => v.gloria) ?? [];
  if (gloria.length === GLORIA.length) return { text: gloria.map((v) => clean(v.pointed)).join("\n"), unsure: [] };
  return pointText(GLORIA.join("\n"), state.tone);
}

/** The tone a booklet setting is sung to here: the one it matches, or else the tone shown. */
const bookletTone = (b: Booklet) => b.tone ?? state.tone;

/** Fetches the booklet settings of a psalm; none when the visitor may not see them. */
async function fetchBooklets(entry: PsalterEntry | undefined): Promise<Booklet[]> {
  if (!entry) return [];
  try {
    const res = await fetch(`/api/pointing/${entry.number}`, { credentials: "same-origin" });
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return [];
    const all = (await res.json()) as Booklet[];
    const last = entry.first + entry.verses.length - 1;
    // A setting of part of the psalm (Psalm 119's parts, the Vulgate's halves of 116 and 147)
    // belongs to the parts it shares verses with.
    return all.filter((b) => b.verses.some((v) => !v.gloria && v.n >= entry.first && v.n <= last));
  } catch {
    return [];
  }
}

/** Fetches the settings of the psalm shown, then offers them. */
async function offerBooklets(): Promise<void> {
  const psalm = state.psalm;
  const found = await fetchBooklets(psalter.get(psalm));
  if (state.psalm !== psalm) return;
  booklets = found;
  syncControls();
}

/** The verses sung, clamped to the psalm. */
function range(entry: PsalterEntry): [number, number] {
  const last = entry.first + entry.verses.length - 1;
  const [from, to] = state.verses ?? [entry.first, last];
  const a = Math.min(Math.max(from, entry.first), last);
  return [a, Math.min(Math.max(to, a), last)];
}

/** Points the source afresh for the tone, dropping hand edits. */
function repoint(): void {
  const { text, unsure } = pointText(sourceText(), state.tone);
  state.auto = state.text = text;
  state.unsure = new Set(unsure);
}

/** A line's place that outlasts a change of range: its verse number, or its line of the Gloria. */
function lineKey(line: string, i: number, count: number): string {
  const number = line.match(/^(\d+) /)?.[1];
  if (number) return `v${number}`;
  return state.gloria && i >= count - GLORIA.length ? `g${count - i}` : `l${i}`;
}

/** Points the source afresh for the tone, keeping the hand edits of lines still in it. */
function repointKeepingEdits(): void {
  const old = state.text.split("\n");
  const auto = state.auto.split("\n");
  const edited = new Map<string, { line: string; unsure: Half[] }>();
  old.forEach((line, i) => {
    if (line === auto[i]) return;
    const unsure = (["mediant", "termination"] as const).filter((part) => state.unsure.has(halfKey(i, part)));
    edited.set(lineKey(line, i, old.length), { line, unsure });
  });
  repoint();
  if (!edited.size) return;
  const lines = state.text.split("\n");
  lines.forEach((line, i) => {
    const edit = edited.get(lineKey(line, i, lines.length));
    if (!edit) return;
    lines[i] = edit.line;
    for (const part of ["mediant", "termination"] as const) {
      if (edit.unsure.includes(part)) state.unsure.add(halfKey(i, part));
      else state.unsure.delete(halfKey(i, part));
    }
  });
  state.text = lines.join("\n");
}

function snapshot(): Snapshot {
  return { setting: state.setting, tone: state.tone, gloria: state.gloria, verses: state.verses, own: state.own, text: state.text, unsure: new Set(state.unsure) };
}

/** Counts the visitor's changes, so a load that waited on the network knows it was overtaken. */
let changes = 0;

function pushUndo(): void {
  changes++;
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  els.undo.disabled = false;
}

// ---- controls ------------------------------------------------------------------------------

function title(entry: PsalterEntry): string {
  const range = entry.part ? ` (${entry.part}: ${entry.first}–${entry.first + entry.verses.length - 1})` : "";
  return `Psalm ${entry.number}${range}`;
}

for (const entry of psalms) els.psalm.add(new Option(`${title(entry)} · ${entry.incipit}`, entry.id));
els.psalm.add(new Option("Your own text…", OWN));
for (const name of toneNames()) els.tone.add(new Option(toneLabel(name), name));
for (let s = -7; s <= 7; s++) {
  const label = s === 0 ? "As written" : `${s > 0 ? "+" : "−"}${Math.abs(s)} semitone${Math.abs(s) === 1 ? "" : "s"}`;
  els.pitch.add(new Option(label, String(s)));
}

function syncControls(): void {
  els.psalm.value = state.psalm;
  const options = [new Option("Suggested", ""), ...booklets.map((b) => new Option(`Booklet, ${b.label}${b.section ? ` (${b.section})` : ""}`, b.id))];
  if (els.source.options.length !== options.length || [...els.source.options].some((o, i) => o.value !== options[i]!.value)) {
    els.source.replaceChildren(...options);
  }
  els.source.value = state.setting ?? "";
  els.sourceLabel.hidden = booklets.length === 0;
  els.tone.value = state.tone;
  els.gloria.checked = state.gloria;
  els.pitch.value = String(state.transpose);
  els.ownLabel.hidden = state.psalm !== OWN;
  els.range.hidden = state.psalm === OWN;
  const entry = psalter.get(state.psalm);
  if (entry) {
    const [from, to] = range(entry);
    for (const input of [els.from, els.to]) {
      input.min = String(entry.first);
      input.max = String(entry.first + entry.verses.length - 1);
    }
    els.from.value = String(from);
    els.to.value = String(to);
  }
  if (state.psalm === OWN && els.own.value !== state.own) els.own.value = state.own;
}

els.psalm.addEventListener("change", () => {
  flushOwn();
  const previous = state.psalm;
  state.psalm = els.psalm.value;
  if (state.psalm === OWN && !state.own) {
    const entry = psalter.get(previous);
    if (entry) state.own = psalmText(entry.verses, entry.first, false);
  }
  state.verses = null;
  state.setting = null;
  booklets = [];
  changes++;
  undoStack.length = 0;
  els.undo.disabled = true;
  repoint();
  refresh({ tone: false });
  void offerBooklets();
});

els.source.addEventListener("change", () => {
  pushUndo();
  state.setting = els.source.value || null;
  const b = booklet();
  const tone = b ? bookletTone(b) : state.tone;
  const toneChanged = tone !== state.tone;
  state.tone = tone;
  repoint();
  refresh({ tone: toneChanged });
});

els.tone.addEventListener("change", () => {
  flushOwn();
  pushUndo();
  state.tone = els.tone.value;
  // A booklet's pointing is for its own tone.
  state.setting = null;
  repoint();
  refresh({ tone: true });
});

els.gloria.addEventListener("change", () => {
  flushOwn();
  pushUndo();
  state.gloria = els.gloria.checked;
  // The Gloria comes and goes at the end, so hand edits to the verses stay.
  const lines = state.text ? state.text.split("\n") : [];
  if (state.gloria) {
    const gloria = gloriaText();
    state.text = [...lines, gloria.text].join("\n");
    state.auto = [...(state.auto ? [state.auto] : []), gloria.text].join("\n");
    for (const key of gloria.unsure) {
      const [v, part] = key.split(":") as [string, Half];
      state.unsure.add(halfKey(Number(v) + lines.length, part));
    }
  } else {
    const keep = lines.length - GLORIA.length;
    state.text = lines.slice(0, keep).join("\n");
    state.auto = state.auto.split("\n").slice(0, keep).join("\n");
    for (const key of [...state.unsure]) if (Number(key.split(":")[0]) >= keep) state.unsure.delete(key);
  }
  refresh({ tone: false });
});

for (const input of [els.from, els.to]) {
  input.addEventListener("change", () => {
    flushOwn();
    const entry = psalter.get(state.psalm);
    if (!entry) return;
    const from = Number(els.from.value);
    const to = Number(els.to.value);
    if (!Number.isInteger(from) || !Number.isInteger(to)) return syncControls();
    const before = state.verses;
    state.verses = input === els.from ? [from, Math.max(from, to)] : [Math.min(from, to), to];
    const next = range(entry);
    const whole = [entry.first, entry.first + entry.verses.length - 1].join();
    state.verses = next.join() === whole ? null : next;
    if (String(state.verses) === String(before)) return syncControls();
    changes++;
    undoStack.push({ ...snapshot(), verses: before });
    els.undo.disabled = false;
    repointKeepingEdits();
    refresh({ tone: false });
  });
}

els.pitch.addEventListener("change", () => {
  state.transpose = Number(els.pitch.value);
  saveHash();
});

let ownTimer = 0;
els.own.addEventListener("input", () => {
  clearTimeout(ownTimer);
  ownTimer = window.setTimeout(() => {
    ownTimer = 0;
    if (els.own.value === state.own) return;
    pushUndo();
    state.own = els.own.value;
    repoint();
    refresh({ tone: false });
  }, 300);
});

/** Takes in typing still waiting on its pause; true when there was some. */
function flushOwn(): boolean {
  if (!ownTimer) return false;
  clearTimeout(ownTimer);
  ownTimer = 0;
  if (els.own.value === state.own) return false;
  pushUndo();
  state.own = els.own.value;
  repoint();
  return true;
}

els.undo.addEventListener("click", undo);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z" && !(e.target instanceof Element && e.target.closest("input, textarea, [contenteditable]"))) {
    e.preventDefault();
    undo();
  }
});

function undo(): void {
  flushOwn();
  const last = undoStack.pop();
  els.undo.disabled = undoStack.length === 0;
  if (!last) return;
  const toneChanged = last.tone !== state.tone;
  state.setting = last.setting;
  state.tone = last.tone;
  state.gloria = last.gloria;
  state.verses = last.verses;
  state.own = last.own;
  state.text = last.text;
  state.unsure = last.unsure;
  state.auto = pointText(sourceText(), state.tone).text;
  refresh({ tone: toneChanged });
}

// ---- the tone line and the verses ---------------------------------------------------------

let toneChant: Chant | undefined;
function drawTone(): void {
  toneChant?.free();
  toneChant = Chant.fromTone(state.tone, { initial: 0 });
  els.toneLabel.textContent = toneLabel(state.tone);
  const width = Math.min(els.toneScore.clientWidth || 600, 720);
  els.toneScore.innerHTML = toneChant.layout(width, { scale: 6, prefix: "tone" }).svg;
}

/** Each syllable's element by its start in the text. */
let syllables = new Map<number, HTMLElement>();

const CADENCE = new Set(["preparatory", "accent", "ending"]);

function drawVerses(): void {
  const display = psalmDisplay(state.text, state.tone);
  state.display = display;
  syllables = new Map();
  const frag = document.createDocumentFragment();
  display.verses.forEach((verse, v) => {
    const p = document.createElement("p");
    p.className = "verse";
    p.dataset.verse = String(v);
    const num = document.createElement("button");
    num.type = "button";
    num.className = "num";
    num.textContent = verse.number === null ? "" : String(verse.number);
    num.title = "Sing this verse";
    num.setAttribute("aria-label", `Sing verse ${verse.number ?? v + 1}`);
    p.append(num);
    const line = document.createElement("span");
    line.className = "line";
    p.append(line);
    const runs = verse.runs;
    const inCadence = (i: number) => {
      const r = runs[i];
      return r?.kind === "syllable" && r.part !== "flex" && CADENCE.has(r.role) ? r.part : null;
    };
    runs.forEach((run, i) => {
      if (run.kind === "syllable") {
        const span = document.createElement("span");
        span.className = "syl";
        span.textContent = run.text;
        span.dataset.start = String(run.sourceUtf16Start);
        span.dataset.end = String(run.sourceUtf16End);
        span.dataset.part = run.part;
        if (run.flexDrop) span.classList.add("drop");
        const part = inCadence(i);
        if (part) {
          span.classList.add("cad");
          if (state.unsure.has(halfKey(v, part as Half))) span.classList.add("unsure");
          if (run.accent) {
            span.classList.add("acc");
            span.tabIndex = 0;
            span.setAttribute("role", "slider");
            span.setAttribute("aria-label", `Accent on “${run.text}”, verse ${verse.number ?? v + 1}`);
            span.setAttribute("aria-valuetext", run.text);
            span.title = "Drag, or use the arrow keys, to move this accent";
          }
        }
        syllables.set(run.sourceUtf16Start, span);
        line.append(span);
        return;
      }
      if (run.kind === "text") {
        // A space inside a cadence carries its underline.
        const before = inCadence(i - 1);
        if (before && before === inCadence(i + 1)) {
          const gap = document.createElement("span");
          gap.className = "cad gap";
          if (state.unsure.has(halfKey(v, before as Half))) gap.classList.add("unsure");
          gap.textContent = run.text;
          line.append(gap);
        } else line.append(run.text);
        return;
      }
      const mark = document.createElement("span");
      mark.className = `mark ${run.kind}`;
      mark.textContent = run.text;
      line.append(mark);
    });
    frag.append(p);
  });
  els.verses.replaceChildren(frag);
}

function updateStatus(): void {
  const display = state.display!;
  const errors = display.diagnostics.filter((d) => d.severity === "error");
  const verses = display.verses.filter((v) => v.number !== null).length;
  const b = booklet();
  const source = b
    ? `Booklet pointing, ${b.label}${b.match === "exact" ? "" : b.match === "close" ? ", sung to the nearest tone" : ", sung to another tone"}`
    : "Suggested pointing";
  const parts = [source, toneLabel(state.tone), `${verses} verse${verses === 1 ? "" : "s"}${state.gloria ? " and the Gloria" : ""}`];
  if (state.text !== state.auto) parts.push("pointing edited");
  els.status.textContent = parts.join(" · ") + (errors.length ? ` · ${errors[0]!.message}` : "");
  els.status.classList.toggle("error", errors.length > 0);
  const n = state.unsure.size;
  els.check.hidden = n === 0;
  els.check.textContent = `${n} to check`;
  els.check.title = "Half-verses the pointer was less sure of: go to the next";
  byId("print-title").textContent = `${heading()} · ${toneLabel(state.tone)}`;
}

function refresh({ tone }: { tone: boolean }): void {
  player.stop();
  syncControls();
  if (tone || !toneChant) drawTone();
  drawVerses();
  updateStatus();
  invalidateScore();
  saveHash();
}

// ---- moving accents -----------------------------------------------------------------------

interface Drag {
  from: HTMLElement;
  pointer: number;
  target: HTMLElement | null;
}
let drag: Drag | null = null;

const halfOf = (el: HTMLElement) => ({
  verse: Number(el.closest<HTMLElement>(".verse")!.dataset.verse),
  part: el.dataset.part as Half,
});

/** The syllables of one half, in order. */
function halfSyllables(verse: number, part: Half): HTMLElement[] {
  return [...els.verses.querySelectorAll<HTMLElement>(`.verse[data-verse="${verse}"] .syl[data-part="${part}"]`)];
}

const span = (el: HTMLElement) => ({ start: Number(el.dataset.start), end: Number(el.dataset.end) });

/** Moves the accent on `from` to `to`, a syllable of the same half. Returns the accent's new index. */
function move(from: HTMLElement, to: HTMLElement): number | null {
  if (flushOwn()) {
    // The text changed under the drag: show it, and leave the accent where it was.
    refresh({ tone: false });
    return null;
  }
  if (from === to || to.classList.contains("acc")) return null;
  const { verse, part } = halfOf(from);
  const accents = halfSyllables(verse, part)
    .filter((el) => el.classList.contains("acc"))
    .map((el) => (el === from ? to : el))
    .map(span)
    .sort((a, b) => a.start - b.start);
  const moved = accents.findIndex((a) => a.start === span(to).start);
  let text: string;
  try {
    text = moveAccents(state.text, state.tone, verse, part, accents);
  } catch (error) {
    els.status.textContent = error instanceof Error ? error.message : String(error);
    return null;
  }
  pushUndo();
  state.text = text;
  state.unsure.delete(halfKey(verse, part));
  refresh({ tone: false });
  return moved;
}

function focusAccent(verse: number, part: Half, index: number): void {
  halfSyllables(verse, part)
    .filter((el) => el.classList.contains("acc"))
    [index]?.focus();
}

els.verses.addEventListener("pointerdown", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".acc");
  if (!el || e.button !== 0) return;
  e.preventDefault();
  el.focus();
  el.setPointerCapture(e.pointerId);
  el.classList.add("dragging");
  drag = { from: el, pointer: e.pointerId, target: null };
});

els.verses.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointer) return;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const to = under instanceof HTMLElement ? under.closest<HTMLElement>(".syl") : null;
  const { verse, part } = halfOf(drag.from);
  const ok = to && !to.classList.contains("acc") && halfOf(to).verse === verse && halfOf(to).part === part;
  const target = ok ? to : null;
  if (target === drag.target) return;
  drag.target?.classList.remove("target");
  target?.classList.add("target");
  drag.target = target;
});

function endDrag(commit: boolean): void {
  if (!drag) return;
  const { from, target } = drag;
  drag = null;
  from.classList.remove("dragging");
  target?.classList.remove("target");
  if (!commit || !target) return;
  const { verse, part } = halfOf(from);
  const index = move(from, target);
  if (index !== null) focusAccent(verse, part, index);
}

els.verses.addEventListener("pointerup", () => endDrag(true));
els.verses.addEventListener("pointercancel", () => endDrag(false));

els.verses.addEventListener("keydown", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".acc");
  if (!el || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  e.preventDefault();
  const { verse, part } = halfOf(el);
  const half = halfSyllables(verse, part);
  const step = e.key === "ArrowLeft" ? -1 : 1;
  let i = half.indexOf(el) + step;
  while (half[i]?.classList.contains("acc")) i += step;
  const to = half[i];
  if (!to) return;
  const index = move(el, to);
  if (index !== null) focusAccent(verse, part, index);
});

/** The half last taken to by the check button, as its place in the psalm. */
let checked = -1;
els.check.addEventListener("click", () => {
  // One stop a half, the first after the last (in the psalm's order), so a half fixed since
  // takes nothing from the rest.
  const order = (el: HTMLElement) => {
    const { verse, part } = halfOf(el);
    return verse * 2 + (part === "termination" ? 1 : 0);
  };
  const all = [...els.verses.querySelectorAll<HTMLElement>(".acc.unsure")];
  if (!all.length) return;
  const next = all.find((el) => order(el) > checked) ?? all[0]!;
  checked = order(next);
  next.scrollIntoView({ block: "center", behavior: "smooth" });
  next.focus({ preventScroll: true });
});

// ---- the engraved psalm, for singing and export -------------------------------------------

let scoreChant: { chant: Chant; tone: string; text: string } | undefined;

function engraved(): Chant {
  if (scoreChant && scoreChant.tone === state.tone && scoreChant.text === state.text) return scoreChant.chant;
  if (scoreChant && scoreChant.tone === state.tone) scoreChant.chant.update(state.text);
  else {
    scoreChant?.chant.free();
    scoreChant = { chant: Chant.fromPsalm(state.text, state.tone, { initial: 0 }), tone: state.tone, text: "" };
  }
  scoreChant.text = state.text;
  return scoreChant.chant;
}

function invalidateScore(): void {
  if (els.notation.open) drawScore();
}

function drawScore(): void {
  els.score.innerHTML = engraved().layout(els.score.clientWidth || 800).svg;
}

els.notation.addEventListener("toggle", () => {
  if (els.notation.open) drawScore();
});

// ---- singing ------------------------------------------------------------------------------

const player = new Player();
let sounding: HTMLElement | null = null;

function sing(verse: number | null): void {
  const chant = engraved();
  const setting = chant.psalm!;
  const notes = chant.layout(800).timeline().notes;
  const run = verse === null ? notes : notes.filter((n) => setting.notes[n.id]?.verse === verse);
  // Stopping what plays first, so its onStop doesn't undo the labels below.
  player.stop();
  els.play.setAttribute("aria-pressed", "true");
  els.play.textContent = "Stop";
  void player.play(run, {
    pulse: Number(els.speed.value),
    transpose: state.transpose,
    clock: test ? () => performance.now() / 1000 : undefined,
    onNote: follow,
    onError: (message) => {
      els.status.textContent = message;
      els.status.classList.add("error");
    },
    onStop: () => {
      els.play.setAttribute("aria-pressed", "false");
      els.play.textContent = "Play";
    },
  });
}

function follow(note: TimelineNote | null): void {
  const el = note ? (syllables.get(note.sourceUtf16Start) ?? null) : null;
  if (el === sounding) return;
  sounding?.classList.remove("sounding");
  el?.classList.add("sounding");
  sounding = el;
  if (el) {
    const box = el.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  if (test && el) visited.push(Number(el.dataset.start));
}
const visited: number[] = [];

els.play.addEventListener("click", () => {
  if (player.playing) return player.stop();
  visited.length = 0;
  sing(null);
});

els.verses.addEventListener("click", (e) => {
  const num = (e.target as HTMLElement).closest<HTMLElement>(".num");
  if (!num) return;
  visited.length = 0;
  sing(Number(num.closest<HTMLElement>(".verse")!.dataset.verse));
});

// ---- export -------------------------------------------------------------------------------

function heading(): string {
  if (state.psalm === OWN) return "Psalm";
  const entry = psalter.get(state.psalm)!;
  return `${title(entry)} · ${entry.incipit}`;
}

function filename(ext: string): string {
  const base = state.psalm === OWN ? "psalm" : `psalm-${state.psalm}`;
  return `${base}-tone-${state.tone.replace(/[^\w]+/g, "")}.${ext}`;
}

function download(name: string, type: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The verses as a pointed psalter prints them, for a word processor: marks in red. */
function richText(): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const red = "color:#a3211c";
  const verses = state.display!.verses.map((v) => {
    const runs = v.runs.map((r) => {
      const text = esc(r.text.replace(/\u2060/g, ""));
      if (r.kind === "syllable") return r.flexDrop ? `<i>${text}</i>` : text;
      if (r.kind === "text") return text;
      if (r.kind === "rubric") return `<i style="${red}">${text}</i>`;
      const bold = r.kind === "point" || r.kind === "held" ? ";font-weight:bold" : "";
      return `<span style="${red}${bold}">${text}</span>`;
    });
    const num = v.number === null ? "" : `<span style="${red};font-size:smaller">${v.number}</span>&nbsp;`;
    return `<p style="margin:0 0 6pt">${num}${runs.join("")}</p>`;
  });
  return (
    `<div style="font-family:'EB Garamond',Garamond,Georgia,serif;font-size:12pt">` +
    `<p style="margin:0 0 3pt"><b>${esc(heading())}</b></p>` +
    `<p style="margin:0 0 9pt;${red}"><i>${esc(toneLabel(state.tone))}</i></p>${verses.join("")}</div>`
  );
}

byId("copy").addEventListener("click", async () => {
  const plainText = `${heading()}\n${toneLabel(state.tone)}\n\n${state.text}\n`;
  try {
    if (typeof ClipboardItem === "function" && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([richText()], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
    } else await navigator.clipboard.writeText(plainText);
    els.status.textContent = "Copied: paste into Word or another editor.";
  } catch {
    els.status.textContent = "The browser would not copy; use the Text download instead.";
  }
});

byId("download-text").addEventListener("click", () =>
  download(filename("txt"), "text/plain;charset=utf-8", `${heading()}\n${toneLabel(state.tone)}\n\n${state.text}\n`),
);

byId("download-gabc").addEventListener("click", () => {
  const { gabc } = psalm(state.text, state.tone);
  // Gregorio's headers: the mode's number (or name) and its ending apart.
  const [mode, ending] = state.tone.split(".");
  const header = `name:${heading().replace(/;/g, ",")};\nmode:${mode};\n${ending ? `mode-differentia:${ending};\n` : ""}`;
  download(filename("gabc"), "text/plain;charset=utf-8", header + gabc.replace(/^\s*/, ""));
});

byId("download-svg").addEventListener("click", () => {
  const svg = engraved().layout(900).svg;
  download(filename("svg"), "image/svg+xml", `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`);
});

byId("print").addEventListener("click", () => window.print());

// ---- the address --------------------------------------------------------------------------

let hashTimer = 0;
let lastHash = "";
function saveHash(): void {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(async () => {
    const hash = await encode({
      psalm: state.psalm,
      tone: state.tone,
      gloria: state.gloria,
      transpose: state.transpose,
      verses: state.psalm === OWN ? null : state.verses,
      setting: state.setting ?? undefined,
      own: state.psalm === OWN ? state.own : undefined,
      // A booklet's text stays out of the address, which may reach anyone: its edits aren't kept.
      text: state.text !== state.auto && !state.setting ? state.text : undefined,
    });
    if (hash === location.hash) return;
    lastHash = hash;
    history.replaceState(null, "", hash);
  }, 200);
}

let loading = 0;
async function load(hash: string): Promise<void> {
  const token = ++loading;
  const shared = await decode(hash);
  if (token !== loading) return;
  const tones = new Set(toneNames());
  const known = shared && (shared.psalm === OWN || psalter.has(shared.psalm));
  state.psalm = known ? shared.psalm : DEFAULT.psalm;
  state.tone = shared && tones.has(shared.tone) ? shared.tone : DEFAULT.tone;
  state.gloria = shared?.gloria ?? true;
  state.transpose = shared?.transpose ?? 0;
  state.verses = shared?.verses ?? null;
  state.setting = null;
  booklets = [];
  // A shared booklet setting needs the settings first; otherwise they come when they come.
  if (shared?.setting && state.psalm !== OWN) {
    const seen = changes;
    const found = await fetchBooklets(psalter.get(state.psalm));
    // Another load, or the visitor's own change meanwhile, has the page now.
    if (token !== loading || changes !== seen) return;
    booklets = found;
    if (booklets.some((b) => b.id === shared.setting)) state.setting = shared.setting;
  } else if (state.psalm !== OWN) void offerBooklets();
  undoStack.length = 0;
  els.undo.disabled = true;
  if (state.psalm === OWN) state.own = shared?.own ?? "";
  repoint();
  // Edits made for another psalm, or another tone, don't belong to this one.
  if (known && shared.tone === state.tone && shared.text !== undefined && !shared.setting) {
    const auto = state.text;
    state.text = clean(shared.text);
    // A half still as the pointer left it stays flagged.
    const lines = state.text.split("\n");
    const autoLines = auto.split("\n");
    for (const key of [...state.unsure]) {
      const [v, part] = key.split(":") as [string, Half];
      const side = (line: string | undefined) => line?.split("*")[part === "mediant" ? 0 : 1];
      if (side(lines[Number(v)]) !== side(autoLines[Number(v)])) state.unsure.delete(key);
    }
  }
  refresh({ tone: true });
}

window.addEventListener("hashchange", () => {
  if (location.hash !== lastHash) void load(location.hash);
});

await load(location.hash);

if (test) {
  (window as Window & { __pointer?: unknown }).__pointer = {
    state,
    visited,
    player,
    shared: () => decode(location.hash),
  };
}
