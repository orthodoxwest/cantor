// The library page: the public chants, searched and browsed by kind, each with its opening
// line in notation; a piece opens at #slug, to be heard in the guide voice and practised.
import { Chant, init } from "neuma";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
import { kicker, kindName, library, type LibraryChant } from "./library";
import { SCALE, Score } from "./score";
import { neutralTable } from "./singer";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

await init();
const chants = library();

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
};

// ---- browsing ----------------------------------------------------------------------------

const ALL = "";
let kind = ALL;

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);
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
      const c = chants.find((x) => x.slug === el.dataset.slug);
      if (!c) continue;
      const chant = new Chant(c.gabc);
      const view = chant.view({ maxLines: 1, ids: false });
      // Laid out wider than drawn, so the opening line carries more of the chant.
      el.innerHTML = view.layout(el.clientWidth * 1.2).svg;
      el.querySelector("svg")?.setAttribute("aria-hidden", "true");
      view.free();
      chant.free();
    }
  },
  { rootMargin: "400px 0px" },
);

function drawResults(): void {
  const q = fold(els.q.value.trim());
  const shown = chants.filter(
    (c) => (kind === ALL || kindOf(c) === kind) && (!q || fold(`${c.title} ${c.name ?? ""} ${c.text}`).includes(q)),
  );
  els.count.textContent = shown.length === 1 ? "1 piece" : `${shown.length} pieces`;
  thumbs.disconnect();
  els.results.innerHTML = shown.length
    ? shown
        .map(
          (c) => `<li><a href="#${c.slug}">
  <span class="kicker">${escape(kicker(c))}</span>
  <span class="name">${highlight(c.title, q)}${c.name ? ` <span class="latin">${highlight(c.name, q)}</span>` : ""}</span>
  ${c.book ? `<span class="src">${escape(c.book)}</span>` : ""}
  <span class="thumb" data-slug="${c.slug}"></span></a></li>`,
        )
        .join("")
    : `<li class="empty">Nothing matches “${escape(els.q.value.trim())}”.</li>`;
  for (const el of els.results.querySelectorAll<HTMLElement>(".thumb")) thumbs.observe(el);
}

els.kinds.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("[data-kind]");
  if (!button) return;
  kind = button.dataset.kind ?? ALL;
  drawKinds();
  drawResults();
});
els.q.addEventListener("input", drawResults);

// ---- a piece -----------------------------------------------------------------------------

let score: Score | null = null;
let cursor: Cursor | null = null;
let guide: Guide | null = null;
let scrollBack = 0;

function stopGuide(): void {
  guide?.stop();
  els.play.setAttribute("aria-pressed", "false");
  els.play.textContent = "Play";
}

async function open(c: LibraryChant): Promise<void> {
  stopGuide();
  els.browse.hidden = true;
  els.piece.hidden = false;
  els.bar.hidden = false;
  document.title = `${c.title} · Library · Cantor`;
  els.kicker.textContent = kicker(c);
  els.title.innerHTML = `${escape(c.title)}${c.name ? ` <span class="incipit">${escape(c.name)}</span>` : ""}`;
  els.book.textContent = c.book ?? "";
  els.book.hidden = !c.book;
  els.source.innerHTML = `Score from ${c.url ? `<a href="${escape(c.url)}" rel="noopener">GregoBase</a>` : "GregoBase"}, in the public domain (CC0).`;
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
  const c = chants.find((x) => x.slug === decodeURIComponent(location.hash.slice(1)));
  if (c) {
    if (els.piece.hidden) scrollBack = window.scrollY;
    void open(c);
  } else close();
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
window.addEventListener("popstate", route);

drawKinds();
drawResults();
route();
