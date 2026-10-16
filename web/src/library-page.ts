// The library page: the chants the visitor may see (library.ts), searched and browsed by kind,
// each with its opening line in notation; a piece opens at #slug, to be heard in the guide voice
// and practised.
import { Chant, init } from "neuma";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
import { chant as fetchChant, kicker, kindName, library, type FullChant, type LibraryChant } from "./library";
import { SCALE, Score } from "./score";
import { offerSignIn } from "./beam";
import { neutralTable } from "./singer";

void offerSignIn();

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const [, loaded] = await Promise.all([
  init(),
  library().catch((error: unknown) => {
    console.error("library:", error);
    return null;
  }),
]);
const chants = loaded ?? [];

const els = {
  browse: byId("browse"),
  q: byId<HTMLInputElement>("q"),
  kinds: byId("kinds"),
  count: byId("count"),
  results: byId<HTMLOListElement>("results"),
  piece: byId("piece"),
  kicker: byId("piece-kicker"),
  title: byId("piece-title"),
  book: byId("piece-book"),
  score: byId("score"),
  status: byId("status"),
  source: byId("piece-source"),
  bar: byId("bar"),
  play: byId<HTMLButtonElement>("play"),
  practise: byId<HTMLAnchorElement>("practise"),
  more: byId<HTMLButtonElement>("more"),
};

// ---- browsing ----------------------------------------------------------------------------

/** Results drawn at a time; Show more draws as many again. */
const PAGE = 40;
let limit = PAGE;

const ALL = "";
let kind = ALL;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c]};`);
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** `text` with the first match of `q` marked. */
function highlight(text: string, q: string): string {
  const at = q ? fold(text).indexOf(q) : -1;
  if (at < 0) return escape(text);
  return `${escape(text.slice(0, at))}<mark>${escape(text.slice(at, at + q.length))}</mark>${escape(text.slice(at + q.length))}`;
}

const kindOf = (c: LibraryChant) => kindName(c.kind) ?? "Other";
const kinds = [...new Set(chants.map(kindOf))].sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));

function drawKinds(): void {
  const chip = (value: string, label: string, n: number) =>
    `<button type="button" class="kind" data-kind="${escape(value)}" aria-pressed="${kind === value}">${escape(label)}<span class="n">${n}</span></button>`;
  els.kinds.innerHTML = [
    chip(ALL, "All", chants.length),
    ...kinds.map((k) => chip(k, k.endsWith("y") ? `${k.slice(0, -1)}ies` : `${k}s`, chants.filter((c) => kindOf(c) === k).length)),
  ].join("");
}

// Thumbnails are engraved as they come into view.
const thumbs = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      thumbs.unobserve(el);
      const slug = el.dataset.slug;
      if (slug) void drawThumb(el, slug);
    }
  },
  { rootMargin: "400px 0px" },
);

/** Engraves a chant's opening line into `el`, once its GABC has come. */
async function drawThumb(el: HTMLElement, slug: string): Promise<void> {
  const c = await fetchChant(slug).catch(() => null);
  if (!c || !el.isConnected) return;
  const chant = new Chant(c.gabc);
  const view = chant.view({ maxLines: 1, ids: false });
  // Laid out wider than drawn, so the opening line carries more of the chant.
  el.innerHTML = view.layout(el.clientWidth * 1.2).svg ?? "";
  el.querySelector("svg")?.setAttribute("aria-hidden", "true");
  view.free();
  chant.free();
}

function drawResults(): void {
  const q = fold(els.q.value.trim());
  const shown = chants.filter(
    (c) => (kind === ALL || kindOf(c) === kind) && (!q || fold(`${c.title} ${c.name ?? ""} ${c.words}`).includes(q)),
  );
  els.count.textContent = shown.length === 1 ? "1 piece" : `${shown.length} pieces`;
  thumbs.disconnect();
  els.more.hidden = shown.length <= limit;
  els.results.innerHTML = shown.length
    ? shown
        .slice(0, limit)
        .map(
          (c) => `<li><a href="#${escape(c.slug)}">
  <span class="kicker">${escape(kicker(c))}</span>
  <span class="name">${highlight(c.title, q)}${c.name ? ` <span class="latin">${highlight(c.name, q)}</span>` : ""}</span>
  ${c.book ? `<span class="src">${escape(c.book)}</span>` : ""}
  <span class="thumb" data-slug="${escape(c.slug)}"></span></a></li>`,
        )
        .join("")
    : `<li class="empty">Nothing matches “${escape(els.q.value.trim())}”.</li>`;
  for (const el of els.results.querySelectorAll<HTMLElement>(".thumb")) thumbs.observe(el);
}

els.kinds.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("[data-kind]");
  if (!button) return;
  kind = button.dataset.kind ?? ALL;
  // The chips stay, so the one pressed keeps the focus.
  for (const b of els.kinds.querySelectorAll<HTMLButtonElement>("[data-kind]"))
    b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
  limit = PAGE;
  drawResults();
});
els.q.addEventListener("input", () => {
  limit = PAGE;
  drawResults();
});
els.more.addEventListener("click", () => {
  // Focus goes to the first of the new results, where reading goes on.
  const next = limit;
  limit += PAGE;
  drawResults();
  els.results.querySelectorAll<HTMLAnchorElement>("li > a")[next]?.focus();
});

// ---- a piece -----------------------------------------------------------------------------

let score: Score | null = null;
let cursor: Cursor | null = null;
let guide: Guide | null = null;
let scrollBack = 0;
/** Counts pieces opened and closed, so a voice that loads late goes to the piece still open. */
let opens = 0;

function stopGuide(): void {
  guide?.stop();
  els.play.setAttribute("aria-pressed", "false");
  els.play.textContent = "Play";
}

async function open(listed: LibraryChant): Promise<void> {
  stopGuide();
  // Play waits for this piece's guide; the last piece's is never played on this score.
  guide = null;
  els.play.disabled = true;
  const opening = ++opens;
  const c = await fetchChant(listed.slug).catch(() => null);
  if (opening !== opens) return;
  if (!c) {
    close();
    els.count.textContent = "That piece could not be opened.";
    return;
  }
  show(c, opening);
}

async function show(c: FullChant, opening: number): Promise<void> {
  els.browse.hidden = true;
  els.piece.hidden = false;
  els.bar.hidden = false;
  document.title = `${c.title} · Library · Cantor`;
  els.kicker.textContent = kicker(c);
  els.title.innerHTML = `${escape(c.title)}${c.name ? ` <span class="incipit">${escape(c.name)}</span>` : ""}`;
  els.book.textContent = c.book ?? "";
  els.book.hidden = !c.book;
  // Only a web address from the score's header becomes a link.
  const url = c.url && /^https:\/\//.test(c.url) ? c.url : null;
  const source = c.source ?? "an unknown source";
  els.source.innerHTML =
    c.source === "GregoBase"
      ? `Score from ${url ? `<a href="${escape(url)}" rel="noopener">GregoBase</a>` : "GregoBase"}, in the public domain (CC0).`
      : `Score from ${escape(source)}; shown only to those signed in.`;
  els.practise.href = `/sing?chant=${encodeURIComponent(c.slug)}`;
  els.status.textContent = "";
  window.scrollTo(0, 0);
  els.title.focus({ preventScroll: true });
  if (score) score.setChant(new Chant(c.gabc));
  else {
    score = new Score(els.score, new Chant(c.gabc), SCALE);
    cursor = new Cursor(score);
  }
  const table = await neutralTable().catch(() => undefined);
  if (opening !== opens) return;
  if (!table) {
    els.status.textContent = "The guide voice could not load.";
    els.play.disabled = true;
    return;
  }
  guide = new Guide(score, cursor!, {
    table,
    gabc: c.gabc,
    onStop: () => {
      els.play.setAttribute("aria-pressed", "false");
      els.play.textContent = "Play";
    },
    onError: (message) => (els.status.textContent = message),
  });
  els.play.disabled = false;
}

function close(): void {
  stopGuide();
  opens++;
  els.piece.hidden = true;
  els.bar.hidden = true;
  els.browse.hidden = false;
  document.title = "Library · Cantor";
  window.scrollTo(0, scrollBack);
}

els.play.addEventListener("click", () => {
  if (!guide) return;
  if (guide.playing) return stopGuide();
  els.status.textContent = "";
  els.play.setAttribute("aria-pressed", "true");
  els.play.textContent = "Stop";
  void guide.play();
});

function route(): void {
  let slug = "";
  try {
    slug = decodeURIComponent(location.hash.slice(1));
  } catch {
    // A malformed address names no piece.
  }
  const c = chants.find((x) => x.slug === slug);
  if (c) {
    if (els.piece.hidden) scrollBack = window.scrollY;
    void open(c);
  } else {
    close();
    // A piece the visitor may not see (or that is gone) is simply not in their library.
    if (slug) els.count.textContent = "That piece is not in the library.";
  }
}
byId("back").addEventListener("click", (e) => {
  e.preventDefault();
  if (history.state?.fromList) history.back();
  else {
    history.pushState(null, "", location.pathname);
    route();
  }
});
els.results.addEventListener("click", (e) => {
  const a = (e.target as Element).closest<HTMLAnchorElement>("a[href^='#']");
  if (!a) return;
  e.preventDefault();
  history.pushState({ fromList: true }, "", a.getAttribute("href"));
  route();
});
if (loaded) {
  window.addEventListener("popstate", route);
  drawKinds();
  drawResults();
  route();
} else els.count.textContent = "The library could not be reached. Reload the page to try again.";
