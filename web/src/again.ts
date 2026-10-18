// A run of a take sung again, drawn over the take: the run sung, the take as it is then drawn,
// and where the take's own sentence of endings is among its places.
import type { Judged } from "./ribbon";

/** Notes `first` to `last`. */
type Span = { first: number; last: number };

/** The run `chosen` of the take `take` as it is sung again: with the whole of any mark or ending
 * of the take it holds part of, so that the core judges each place of the take sung again as it
 * judged it there (a verse marked together is marked again only when it is sung whole). */
export function grown(take: Judged, chosen: readonly [number, number]): [number, number] {
  const places: Span[] = [...take.verdict.marks, ...(take.endings ?? [])];
  let [a, b] = chosen;
  for (let grew = true; grew; ) {
    grew = false;
    for (const { first, last } of places) {
      if (last < a || first > b || (first >= a && last <= b)) continue;
      [a, b] = [Math.min(a, first), Math.max(b, last)];
      grew = true;
    }
  }
  return [a, b];
}

/** What of the take `take` the run `chosen` is grown to hold when it is sung again ([`grown`]), in
 * words: "to hold the whole of your take’s mark there". An ending a mark tells of is that mark,
 * where the run is grown to hold the mark too. */
export function grewOver(take: Judged, chosen: readonly [number, number]): string {
  const [a, b] = chosen;
  const [c, d] = grown(take, chosen);
  const swept = ({ first, last }: Span) => last >= c && first <= d && !(first >= a && last <= b);
  const marks = take.verdict.marks.filter(swept);
  const told = (e: { mark: number | null }) => e.mark !== null && marks.includes(take.verdict.marks[e.mark]!);
  const endings = (take.endings ?? []).filter((e) => swept(e) && !told(e)).length;
  const noun = marks.length && endings ? "marks and phrase endings" : marks.length ? (marks.length > 1 ? "marks" : "mark") : endings > 1 ? "phrase endings" : "phrase ending";
  return `to hold the whole of your take’s ${noun} there`;
}

/** The take `take` with notes `run` of it sung again, judged `sung` (its marks, endings and bands
 * of the chant's notes by index), in their place: the run's bands, marks and endings where the
 * take's were (the take's that reach into the run go), each mark with its words and each ending
 * with the mark that tells of it, in the order sung; the rest is the take's. */
export function viewOf(take: Judged, [a, b]: readonly [number, number], sung: Judged): Judged {
  const reaches = ({ first, last }: Span) => last >= a && first <= b;
  const marks = [
    ...take.verdict.marks.flatMap((mark, k) => (reaches(mark) ? [] : [{ mark, words: take.told[k] ?? "", of: take, k }])),
    ...sung.verdict.marks.map((mark, k) => ({ mark, words: sung.told[k] ?? "", of: sung, k })),
  ].sort((x, y) => x.mark.first - y.mark.first || x.mark.last - y.mark.last);
  const markOf = (of: Judged, k: number | null) => {
    const at = k === null ? -1 : marks.findIndex((m) => m.of === of && m.k === k);
    return at < 0 ? null : at;
  };
  const endings = [
    ...(take.endings ?? []).filter((e) => !reaches(e)).map((e) => ({ ...e, mark: markOf(take, e.mark) })),
    ...(sung.endings ?? []).map((e) => ({ ...e, mark: markOf(sung, e.mark) })),
  ].sort((x, y) => x.first - y.first);
  const bands = new Map(sung.ribbon.map((band) => [band.index, band]));
  return {
    ...take,
    verdict: { ...take.verdict, marks: marks.map((m) => m.mark) },
    told: marks.map((m) => m.words),
    endings,
    ribbon: take.ribbon.map((band) => bands.get(band.index) ?? band),
  };
}

/** Where the take `take`'s first ending off pitch, which its sentence of endings opens, is among
 * the places of `view`, it with notes `run` sung again ([`viewOf`]): the mark that tells of it
 * already, or it among the endings that stand alone, after the marks; none when it has none, or
 * the run holds it, as the run's own are told of beside the take. */
export function saidIn(take: Judged, view: Judged, [a, b]: readonly [number, number]): number | null {
  const first = take.endings?.[0];
  if (!first || (first.last >= a && first.first <= b)) return null;
  const told = first.mark === null ? undefined : take.verdict.marks[first.mark];
  const k = told
    ? view.verdict.marks.indexOf(told)
    : (view.endings ?? []).filter((e) => e.mark === null).findIndex((e) => e.first === first.first && e.last === first.last);
  if (k < 0) return null;
  return told ? k : view.verdict.marks.length + k;
}
