// A sent take, as its link opens it (/take/ID): the take on its score with the ribbon and the
// core's marks as they were judged when it was sung, the take to play with the cursor following
// it, and comments, each on one note. Anyone holding the link may read and comment; the Worker
// says which comments the singer wrote.
import { Chant, init, type TimelineNote } from "neuma";
import { offerSignIn } from "./beam";
import { Cursor } from "./cursor";
import { drawMarks } from "./marks";
import { describeKey, drawRibbon, type Judged } from "./ribbon";
import { SCALE, Score } from "./score";
import { noteAt, timed, type Timed } from "./timing";

void offerSignIn();

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Comment {
  id: number;
  /** The note's index in the score's timeline. */
  note: number;
  body: string;
  /** The singer, someone signed in, or a reader the site did not know. */
  by: "singer" | "known" | "reader";
  /** The name a signed-in writer gave, if any. */
  name: string | null;
  created_at: string;
}

/** A take as /api/takes/ID serves it. A reader not signed in is given no slug, title or score
 * for a take of a private chant. */
interface Take {
  id: string;
  slug: string | null;
  title: string | null;
  gabc: string | null;
  pulse: number;
  offset: number;
  seconds: number;
  judged: Judged;
  created_at: string;
  mine: boolean;
  comments: Comment[];
}

const status = byId<HTMLParagraphElement>("status");
const say = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle("error", error);
};

const id = /^\/take\/([A-Za-z0-9_-]{32})\/?$/.exec(location.pathname)?.[1];

async function load(): Promise<Take | null> {
  if (!id) return null;
  const res = await fetch(`/api/takes/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the site answered ${res.status}`);
  return (await res.json()) as Take;
}

/** Who is reading, when signed in, with the name they gave. */
interface Me {
  id: string;
  name: string | null;
}

async function whoAmI(): Promise<Me | null> {
  try {
    const res = await fetch("/api/me", { redirect: "manual" });
    const me = res.ok ? ((await res.json()) as Partial<Me>) : null;
    return typeof me?.id === "string" ? { id: me.id, name: typeof me.name === "string" ? me.name : null } : null;
  } catch {
    return null;
  }
}

const [take, me] = await Promise.all([load().catch((error: unknown) => error as Error), whoAmI(), init()]);
if (take instanceof Error) say(`The take could not be loaded: ${take.message}`, true);
else if (!take) say("There is no take at this link. It may have been copied short.", true);
else show(take, me);

function show(take: Take, me: Me | null): void {
  const sung = new Date(take.created_at).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  byId("kicker").textContent = `${take.mine ? "Your take" : "A take"} · ${sung}`;
  byId("title").textContent = take.title ?? "A take";
  document.title = `${take.title ?? "A take"} · Cantor`;
  if (!take.gabc) byId("lede").textContent = "Listen to the take. Its score is shown to those signed in.";
  byId("take").hidden = false;

  const judged = take.judged;
  const summary = byId<HTMLParagraphElement>("summary");
  summary.textContent = judged.summary.join(" ");
  summary.hidden = !summary.textContent;
  const key = judged.verdict.key_cents;
  byId("key").textContent = key === null ? "Too little was heard to show." : `The singer's key: ${describeKey(key)}.`;

  const audio = byId<HTMLAudioElement>("audio");
  audio.src = `/api/takes/${take.id}/audio`;

  const comments = [...take.comments];
  const noteInput = byId<HTMLInputElement>("note");
  const noteWords = byId<HTMLSpanElement>("note-words");
  const why = byId<HTMLParagraphElement>("why");
  const bodyInput = byId<HTMLTextAreaElement>("body");
  const count = take.gabc ? null : judged.ribbon.length;

  // The score, its strips and the cursor, when the reader may see the score.
  const score = take.gabc ? new Score(byId("score"), new Chant(take.gabc), SCALE) : null;
  if (!score) byId("score").hidden = true;
  const cursor = score && new Cursor(score);
  const notes = (): readonly TimelineNote[] => score?.timeline.notes ?? [];
  let times: Timed[] = score ? timed(notes(), take.pulse) : [];
  /** Where note `i` was due, in seconds of the take: by the score when shown, else where its
   * judged band begins (already in seconds of the take). */
  const startOf = (i: number): number | undefined =>
    score ? (times[i] ? take.offset + times[i].start : undefined) : judged.ribbon.find((b) => b.index === i)?.from_s;
  /** The note chosen to comment on, and the mark whose words are shown. */
  let chosen: number | null = null;
  let open: number | null = null;

  function draw(): void {
    if (!score) return;
    const commented = new Set(comments.map((c) => c.note));
    score.showStrips((timeline, room) => {
      const pins = [...commented].flatMap((i) => {
        const n = timeline.notes[i];
        return n ? [`<circle class="pin" cx="${n.cx.toFixed(1)}" cy="${(room.stripTop(n.line) + 7).toFixed(1)}" r="3.5"/>`] : [];
      });
      return (
        drawMarks(timeline.notes, judged.verdict.marks, room.shift, open) +
        drawRibbon(timeline.notes, judged.ribbon, room.stripTop, 0, chosen, (i) => `Comment on note ${i + 1}`) +
        `<g class="pins">${pins.join("")}</g>`
      );
    });
    times = timed(notes(), take.pulse);
    // The score was laid out afresh: the cursor stands again where the take is.
    cursor?.relaid();
    follow();
    why.textContent = open === null ? "" : (judged.told[open] ?? "");
  }

  const jump = byId<HTMLParagraphElement>("jump");
  const jumpLink = byId<HTMLAnchorElement>("jump-link");
  jumpLink.addEventListener("click", (e) => {
    e.preventDefault();
    bodyInput.focus();
    bodyInput.scrollIntoView({ block: "center" });
  });

  /** Chooses note `i` to comment on, and puts the take there; a note chosen on the score
   * offers the way down to the comment. */
  function choose(i: number, seek = true): void {
    chosen = i;
    jump.hidden = !seek || !score;
    jumpLink.textContent = `Comment on note ${i + 1}`;
    noteInput.value = String(i + 1);
    const words = notes()[i]?.syllableText.trim();
    noteWords.textContent = words ? `“${words}”` : "";
    draw();
    const at = startOf(i);
    if (seek && at !== undefined) {
      const to = Math.max(0, at - 0.2);
      if (audio.readyState >= 1) audio.currentTime = to;
      else audio.addEventListener("loadedmetadata", () => (audio.currentTime = to), { once: true });
    }
  }

  noteInput.max = String(count ?? notes().length);
  noteInput.addEventListener("change", () => {
    const n = Number(noteInput.value);
    const last = count ?? notes().length;
    if (Number.isInteger(n) && n >= 1 && n <= last) choose(n - 1);
  });

  // Tapping a note's band or its ink chooses it; tapping a mark shows its words.
  function tap(target: EventTarget | null, keyboard: boolean): boolean {
    const el = target as Element | null;
    const mark = el?.closest<SVGGElement>("[data-mark]");
    const band = el?.closest<SVGGElement>("[data-band]");
    const ink = el?.closest<SVGElement>("[data-note]");
    let again: string;
    if (mark) {
      const k = Number(mark.dataset.mark);
      open = open === k ? null : k;
      draw();
      again = `[data-mark="${k}"]`;
    } else if (band) {
      choose(Number(band.dataset.band));
      again = `[data-band="${band.dataset.band}"]`;
    } else if (ink) {
      const ids = (ink.dataset.note ?? "").split(" ").map(Number);
      const i = notes().findIndex((n) => n.id === ids[0]);
      if (i < 0) return false;
      choose(i);
      return true;
    } else {
      return false;
    }
    if (keyboard) score?.host.querySelector<SVGElement>(again)?.focus();
    return true;
  }
  if (score) {
    score.host.addEventListener("click", (e) => tap(e.target, false));
    score.host.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && tap(e.target, true)) e.preventDefault();
      // The arrows move the chosen note along the bands, one tab stop among them.
      const band = (e.target as Element | null)?.closest<SVGGElement>("[data-band]");
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!band || !step || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      const to = Math.min(Math.max(Number(band.dataset.band) + step, 0), notes().length - 1);
      choose(to, false);
      score.host.querySelector<SVGElement>(`[data-band="${to}"]`)?.focus();
    });
  }

  // The cursor follows the take as it plays: each note where it was due in the take.
  // Before the first note and after the last it is hidden; in a pause it stands at the bar.
  let frame = 0;
  function follow(): void {
    if (!score || !cursor) return;
    const t = audio.currentTime - take.offset;
    const first = times[0];
    const last = times.at(-1);
    if (!first || !last || t < first.start || t >= last.start + last.duration) return cursor.hide();
    const i = Math.max(noteAt(times, t), 0);
    const at = times[i]!;
    const { timeline } = score;
    const bar = t >= at.start + at.duration ? timeline.pauses.find((p) => p.beforeNote === i + 1 && p.bar)?.bar : undefined;
    if (bar) return cursor.show(bar.cx, score.line(bar.line), null);
    const note = timeline.notes[i]!;
    cursor.show(note.cx, score.line(note.line), note.id);
  }
  const tick = () => {
    follow();
    if (!audio.paused) frame = requestAnimationFrame(tick);
  };
  audio.addEventListener("play", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  });
  audio.addEventListener("seeked", follow);
  audio.addEventListener("ended", () => cursor?.hide());

  // The comments, in the order of the notes.
  const list = byId<HTMLOListElement>("comments");
  /** Who wrote `c`: a name a writer gave is set apart, in its own direction, and marked as given
   * by one signed in, so it cannot pass for the page's own words. */
  const who = (c: Comment): Node => {
    if (c.by === "singer") return document.createTextNode(take.mine ? "You" : "The singer");
    if (c.by !== "known" || !c.name) return document.createTextNode("A reader");
    const span = document.createElement("span");
    span.className = "named";
    const name = document.createElement("bdi");
    name.textContent = c.name;
    span.append(name, " (signed in)");
    return span;
  };
  function drawComments(): void {
    const sorted = [...comments].sort((a, b) => a.note - b.note || a.id - b.id);
    list.replaceChildren(
      ...sorted.map((c) => {
        const li = document.createElement("li");
        li.className = c.by;
        const head = document.createElement("p");
        head.className = "comment-head";
        const note = document.createElement("button");
        note.type = "button";
        note.className = "note-link";
        note.textContent = `Note ${c.note + 1}`;
        note.addEventListener("click", () => choose(c.note));
        const when = new Date(c.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
        head.append(note, " · ", who(c), ` · ${when}`);
        // The singer may take any comment off their take.
        if (take.mine) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "remove";
          remove.textContent = "Remove";
          remove.setAttribute("aria-label", `Remove the comment on note ${c.note + 1}`);
          remove.addEventListener("click", () => void removeComment(c, remove));
          head.append(" ", remove);
        }
        const body = document.createElement("p");
        body.className = "comment-body";
        body.textContent = c.body;
        li.append(head, body);
        return li;
      }),
    );
    if (!comments.length) {
      const li = document.createElement("li");
      li.className = "none";
      li.textContent = "No comments yet.";
      list.append(li);
    }
  }

  async function removeComment(c: Comment, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const res = await fetch(`/api/takes/${take.id}/comments/${c.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`the site answered ${res.status}`);
      const k = comments.indexOf(c);
      if (k >= 0) comments.splice(k, 1);
      say("");
      drawComments();
      draw();
    } catch (error) {
      button.disabled = false;
      say(`The comment could not be removed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  // One signed in, not the singer, puts their name to their comments; one not signed in is
  // offered to sign in, and comes back here.
  const nameInput = byId<HTMLInputElement>("name");
  if (me && !take.mine) {
    byId("name-line").hidden = false;
    nameInput.value = me.name ?? "";
  } else if (!me) {
    byId("sign-line").hidden = false;
    byId<HTMLAnchorElement>("sign-link").href = `/signin?next=${encodeURIComponent(location.pathname)}`;
  }

  /** Keeps the name given, when it changed. */
  async function keepName(): Promise<void> {
    const name = nameInput.value.replace(/\s+/g, " ").trim();
    if (!me || take.mine || name === (me.name ?? "")) return;
    const res = await fetch("/api/me", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!res.ok) throw new Error(res.status === 400 ? "that name cannot be used" : `the site answered ${res.status}`);
    me.name = name || null;
  }

  const form = byId<HTMLFormElement>("comment");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const note = Number(noteInput.value) - 1;
    const body = bodyInput.value.trim();
    if (!body || !Number.isInteger(note) || note < 0) return;
    const post = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
    post.disabled = true;
    try {
      await keepName();
      const res = await fetch(`/api/takes/${take.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, body }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `the site answered ${res.status}`);
      comments.push((await res.json()) as Comment);
      bodyInput.value = "";
      say("");
      drawComments();
      draw();
    } catch (error) {
      say(`The comment could not be posted: ${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      post.disabled = false;
    }
  });

  draw();
  drawComments();
  // The first note marked, or else the first, is where a comment starts.
  choose(judged.verdict.marks[0]?.first ?? 0, false);
}
