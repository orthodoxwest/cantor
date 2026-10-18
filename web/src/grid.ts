// A psalm sung to a tone, verse by verse, as the core lays it out (`cantor_core::grid`): a row a
// verse and a column a part of the tone, each cell its ending as the judge called it, so that a
// fault sung at every mediant reads down a column. The page draws the core's cells and words; it
// calls none.
import type { Grid, GridCell, GridRow } from "./ribbon";

/** The grid of a take with a run of it sung again, the run's grid `sung` in its place: each part
 * the run called (one it sang, not "unsung" in its grid) as the run called it, with the take's
 * cell there beside it as `was`; the rest the take's, and a verse the run reached that the take
 * did not (a take stopped short) as the run has it. */
export function gridWith(take: Grid | null | undefined, sung: Grid | null | undefined): Grid | null {
  if (!take || !sung) return take ?? null;
  const by = new Map(sung.rows.map((row) => [row.verse, row]));
  const columns = take.columns.map(({ part }) => sung.columns.findIndex((c) => c.part === part));
  const rows: GridRow[] = take.rows.map((row) => {
    const again = by.get(row.verse);
    by.delete(row.verse);
    if (!again) return row;
    return {
      ...row,
      cells: row.cells.map((cell, c) => {
        const now = again.cells[columns[c]!] ?? null;
        return now && now.called !== "unsung" ? { ...now, was: cell ?? undefined } : cell;
      }),
    };
  });
  rows.push(...by.values());
  rows.sort((a, b) => a.first - b.first);
  return { ...take, rows };
}

/** The cell `[row, column]` of `rows` that `key` moves the keyboard to from `at`: along the row
 * with the arrows left and right, to its ends with Home and End, down the column with the arrows
 * up and down, past the gaps where a verse has no such part. None for another key, or past an
 * edge. */
export function stepCell(rows: ReadonlyArray<{ cells: ReadonlyArray<GridCell | null> }>, at: readonly [number, number], key: string): [number, number] | null {
  const [r, c] = at;
  const has = (row: number, col: number) => rows[row]?.cells[col] != null;
  const along = (from: number, by: number, to: (i: number) => boolean, end: number) => {
    for (let i = from + by; by > 0 ? i <= end : i >= end; i += by) if (to(i)) return i;
    return null;
  };
  const width = rows[r]?.cells.length ?? 0;
  const across = (from: number, by: 1 | -1) => along(from, by, (i) => has(r, i), by > 0 ? width - 1 : 0);
  const down = (by: 1 | -1) => along(r, by, (i) => has(i, c), by > 0 ? rows.length - 1 : 0);
  const to = (col: number | null) => (col === null ? null : ([r, col] as [number, number]));
  switch (key) {
    case "ArrowRight":
      return to(across(c, 1));
    case "ArrowLeft":
      return to(across(c, -1));
    case "Home":
      return to(across(-1, 1));
    case "End":
      return to(across(width, -1));
    case "ArrowDown":
    case "ArrowUp": {
      const row = down(key === "ArrowDown" ? 1 : -1);
      return row === null ? null : [row, c];
    }
    default:
      return null;
  }
}

/** The opening words of a verse, `words` sung on it, as its row is headed: its first `count`
 * words, and an ellipsis if it has more. */
export function opening(words: string, count = 3): string {
  const all = words.split(/\s+/).filter(Boolean);
  return all.length > count ? `${all.slice(0, count).join(" ")} …` : all.join(" ");
}
