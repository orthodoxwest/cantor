// The library page: the chants the visitor may see (library.ts), searched and browsed by kind,
// narrowed if wished to those approved for the AWRV, each with its opening line in notation; a piece opens at #slug, to be heard in the guide voice
// and practised.
import { Chant, init } from "neuma";
import { Cursor } from "./cursor";
import { Guide } from "./guide";
import { byMass, chant as fetchChant, escape, finds, highlight, isOrdinary, kindName, library, marked, terms, type FullChant, type LibraryChant } from "./library";
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
  pickKind: byId<HTMLSelectElement>("pick-kind"),
  approvedOnly: byId("awrv-only"),
  approved: byId<HTMLInputElement>("approved"),
  approvedN: byId("approved-n"),
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
/** The kind the visitor chose, which comes back when the pieces browsed have it again. */
let chosenKind = ALL;

/** The movements of the Mass are browsed together, a Mass's in the order they are sung. */
const MASS = "Mass";
const kindOf = (c: LibraryChant) => (isOrdinary(c.kind) ? MASS : (kindName(c.kind) ?? "Other"));
const plural = (k: string) => (k === MASS ? "Mass settings" : k.endsWith("y") ? `${k.slice(0, -1)}ies` : `${k}s`);

// The pieces approved for the AWRV, whose services keep to a subset of the tones and translations.
// The choice to see only those is offered once any piece is marked, and kept in the address
// (?awrv) so that a link to the library shares it.
const approved = chants.filter((c) => c.awrv === true);
/** Whether the address asks for only the approved pieces: ?awrv, but not ?awrv=0 or ?awrv=no. */
const askedApproved = () => {
  const v = new URLSearchParams(location.search).get("awrv");
  return approved.length > 0 && v !== null && v !== "0" && v.toLowerCase() !== "no";
};
let approvedOnly = askedApproved();
/** The pieces browsed: all, or only those approved. */
const browsed = () => (approvedOnly ? approved : chants);

function drawKinds(): void {
  const pieces = browsed();
  const kinds = [...new Set(pieces.map(kindOf))].sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));
  // A kind none of the pieces browsed is of shows them all, until it is among them again.
  kind = kinds.includes(chosenKind) ? chosenKind : ALL;
  const chip = (value: string, label: string, n: number) =>
    `<button type="button" class="kind" data-kind="${escape(value)}" aria-pressed="${kind === value}">${escape(label)}<span class="n">${n}</span></button>`;
  const all: [string, string, number][] = [
    [ALL, "All", pieces.length],
    ...kinds.map((k): [string, string, number] => [k, plural(k), pieces.filter((c) => kindOf(c) === k).length]),
  ];
  els.kinds.innerHTML = all.map(([value, label, n]) => chip(value, label, n)).join("");
  // A phone is shown the same kinds as a list to pick from, which takes one row and needs no
  // sideways scrolling to find.
  els.pickKind.innerHTML = all
    .map(([value, label, n]) => `<option value="${escape(value)}"${kind === value ? " selected" : ""}>${escape(label)} (${n})</option>`)
    .join("");
}

/** Shows `k`'s pieces, the chips and the list agreeing. */
function chooseKind(k: string): void {
  kind = chosenKind = k;
  for (const b of els.kinds.querySelectorAll<HTMLButtonElement>("[data-kind]"))
    b.setAttribute("aria-pressed", String(b.dataset.kind === kind));
  els.pickKind.value = kind;
  limit = PAGE;
  drawResults();
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

/** Sees only the pieces approved for the AWRV, or all of them again. */
function chooseApproved(only: boolean): void {
  approvedOnly = only;
  els.approved.checked = only;
  const url = new URL(location.href);
  if (only) url.searchParams.set("awrv", "");
  else url.searchParams.delete("awrv");
  history.replaceState(history.state, "", url.href.replace(/([?&]awrv)=(?=&|#|$)/, "$1"));
  limit = PAGE;
  drawKinds();
  drawResults();
}

function drawResults(): void {
  const q = terms(els.q.value);
  const shown = browsed().filter((c) => (kind === ALL || kindOf(c) === kind) && finds(c, q));
  if (kind === MASS) shown.sort(byMass);
  els.count.textContent = shown.length === 1 ? "1 piece" : `${shown.length} pieces`;
  thumbs.disconnect();
  els.more.hidden = shown.length <= limit;
  els.results.innerHTML = shown.length
    ? shown
        .slice(0, limit)
        .map(
          (c) => `<li><a href="#${escape(c.slug)}">
  <span class="kicker">${escape(marked(c))}</span>
  <span class="name">${highlight(c.title, q)}${c.name ? ` <span class="latin">${highlight(c.name, q)}</span>` : ""}</span>
  ${c.book ? `<span class="src">${escape(c.book)}</span>` : ""}
  <span class="thumb" data-slug="${escape(c.slug)}"></span></a></li>`,
        )
        .join("")
    : `<li class="empty">${approvedOnly ? "No piece approved for the AWRV" : "Nothing"} matches “${escape(els.q.value.trim())}”.</li>`;
  for (const el of els.results.querySelectorAll<HTMLElement>(".thumb")) thumbs.observe(el);
}

els.kinds.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("[data-kind]");
  if (!button) return;
  // The chips stay, so the one pressed keeps the focus.
  chooseKind(button.dataset.kind ?? ALL);
});
els.pickKind.addEventListener("change", () => chooseKind(els.pickKind.value));
els.approved.addEventListener("change", () => chooseApproved(els.approved.checked));
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
  els.kicker.textContent = marked(c);
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
  // Going back or forward may come to an address that chose otherwise.
  const only = askedApproved();
  if (only !== approvedOnly) {
    approvedOnly = els.approved.checked = only;
    drawKinds();
    drawResults();
  }
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
    history.pushState(null, "", location.pathname + location.search);
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
  els.approvedOnly.hidden = approved.length === 0;
  els.approved.checked = approvedOnly;
  els.approvedN.textContent = `(${approved.length})`;
  drawKinds();
  drawResults();
  route();
} else els.count.textContent = "The library could not be reached. Reload the page to try again.";
