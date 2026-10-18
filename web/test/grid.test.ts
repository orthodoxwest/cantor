import { describe, expect, it } from "vitest";
import { viewOf } from "../src/again";
import { gridWith, opening, stepCell } from "../src/grid";
import type { Grid, GridCell, Judged } from "../src/ribbon";

const cell = (part: GridCell["part"], first: number, last: number, called: GridCell["called"] = "on-pitch", words = "On pitch"): GridCell => ({
  part,
  first,
  last,
  called,
  ending: called === "no-ending" ? null : [last - 1, last],
  note: called === "on-pitch" || called === "off-pitch" ? last : null,
  cents: called === "off-pitch" ? -200 : called === "on-pitch" ? 10 : null,
  words,
});
const columns: Grid["columns"] = [
  { part: "flex", name: "Flex" },
  { part: "mediant", name: "Mediant" },
  { part: "termination", name: "Termination" },
];
/** Three verses of six notes: the second with a flex, each mediant a whole tone below. */
const take: Grid = {
  columns,
  rows: [
    { verse: 0, number: 1, first: 0, last: 5, cells: [null, cell("mediant", 0, 2, "off-pitch", "A whole tone below"), cell("termination", 3, 5)] },
    {
      verse: 1,
      number: 2,
      first: 6,
      last: 13,
      cells: [cell("flex", 6, 7), cell("mediant", 8, 10, "off-pitch", "A whole tone below"), cell("termination", 11, 13, "no-ending", "No ending to judge")],
    },
    { verse: 2, number: 3, first: 14, last: 19, cells: [null, cell("mediant", 14, 16, "off-pitch", "A whole tone below"), cell("termination", 17, 19)] },
  ],
};

describe("gridWith", () => {
  it("puts the parts a run called where the take's were, the take's beside them", () => {
    // The second verse's mediant sung again on pitch: its grid has that verse, the rest unsung.
    const sung: Grid = {
      columns,
      rows: [
        {
          verse: 1,
          number: 2,
          first: 6,
          last: 13,
          cells: [cell("flex", 6, 7, "unsung", "Not sung"), cell("mediant", 8, 10), cell("termination", 11, 13, "unsung", "Not sung")],
        },
      ],
    };
    const grid = gridWith(take, sung)!;
    expect(grid.columns).toBe(take.columns);
    expect(grid.rows[0]).toBe(take.rows[0]);
    expect(grid.rows[2]).toBe(take.rows[2]);
    expect(grid.rows[1]!.cells).toEqual([take.rows[1]!.cells[0], { ...cell("mediant", 8, 10), was: take.rows[1]!.cells[1] }, take.rows[1]!.cells[2]]);
  });

  it("keeps the take's grid when the run has none, and none when the take has none", () => {
    expect(gridWith(take, null)).toBe(take);
    expect(gridWith(null, take)).toBeNull();
    expect(gridWith(undefined, undefined)).toBeNull();
  });

  it("keeps a part with no ending to judge as the take had it, sung again with none", () => {
    const sung: Grid = {
      columns,
      rows: [{ ...take.rows[1]!, cells: [cell("flex", 6, 7, "unsung", "Not sung"), cell("mediant", 8, 10), cell("termination", 11, 13, "no-ending", "No ending to judge")] }],
    };
    const cells = gridWith(take, sung)!.rows[1]!.cells;
    expect(cells[2]).toBe(take.rows[1]!.cells[2]);
    expect(cells[1]!.was).toBe(take.rows[1]!.cells[1]);
  });

  it("has only the take's verses", () => {
    // A run is sung only within what the take judged; were one past it, it is not drawn.
    const stopped: Grid = { columns, rows: take.rows.slice(0, 1) };
    const sung: Grid = { columns, rows: take.rows.slice(2) };
    expect(gridWith(stopped, sung)!.rows).toEqual(stopped.rows);
  });

  it("is the view's grid of a take with a run sung again", () => {
    const judged = (grid: Grid): Judged => ({ verdict: { outcome: "heard", key_cents: 0, marks: [] }, told: [], summary: [], endings: [], ribbon: [], grid });
    const sung: Grid = { columns, rows: [{ ...take.rows[0]!, cells: [null, cell("mediant", 0, 2), cell("termination", 3, 5, "unsung", "Not sung")] }] };
    const view = viewOf(judged(take), [0, 2], judged(sung));
    expect(view.grid).toEqual(gridWith(take, sung));
    expect(view.grid!.rows[0]!.cells[1]!.was).toBe(take.rows[0]!.cells[1]);
  });
});

describe("stepCell", () => {
  it("moves along a row, past a verse's missing flex, and to its ends", () => {
    expect(stepCell(take.rows, [0, 1], "ArrowRight")).toEqual([0, 2]);
    expect(stepCell(take.rows, [0, 2], "ArrowRight")).toBeNull();
    expect(stepCell(take.rows, [0, 1], "ArrowLeft")).toBeNull();
    expect(stepCell(take.rows, [1, 2], "ArrowLeft")).toEqual([1, 1]);
    expect(stepCell(take.rows, [1, 2], "Home")).toEqual([1, 0]);
    expect(stepCell(take.rows, [0, 2], "Home")).toEqual([0, 1]);
    expect(stepCell(take.rows, [1, 0], "End")).toEqual([1, 2]);
  });

  it("moves down a column, past the verses with no such part", () => {
    expect(stepCell(take.rows, [0, 1], "ArrowDown")).toEqual([1, 1]);
    expect(stepCell(take.rows, [2, 1], "ArrowDown")).toBeNull();
    expect(stepCell(take.rows, [2, 1], "ArrowUp")).toEqual([1, 1]);
    expect(stepCell(take.rows, [1, 0], "ArrowDown")).toBeNull();
    expect(stepCell(take.rows, [1, 0], "ArrowUp")).toBeNull();
    const flexes = [...take.rows, { cells: [cell("flex", 20, 21), null, null] }];
    expect(stepCell(flexes, [1, 0], "ArrowDown")).toEqual([3, 0]);
  });

  it("goes nowhere for another key", () => {
    expect(stepCell(take.rows, [0, 1], "Enter")).toBeNull();
    expect(stepCell(take.rows, [0, 1], "a")).toBeNull();
  });
});

describe("opening", () => {
  it("heads a verse with its first words, the ellipsis kept with the last of them", () => {
    expect(opening("Have mercy upon me, O God")).toBe("Have mercy upon\u00a0…");
    expect(opening("Wash me throughly")).toBe("Wash me throughly");
    expect(opening("  Lo,  I was ", 2)).toBe("Lo, I\u00a0…");
    expect(opening("")).toBe("");
  });
});
