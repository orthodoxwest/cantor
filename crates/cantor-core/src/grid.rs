//! A psalm sung to a tone, verse by verse: a row for each verse and a column for each part of the
//! tone (its flex, mediant and termination), each cell that part of the verse with its phrase
//! ending as the judge called it. So a fault sung at every mediant reads down a column. The grid
//! tells nothing the judge did not: its cells are the verdict's cadences, placed by where they
//! fall in each verse, and their words are of them.

use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::judge::{Outcome, Verdict, recited};
use crate::synth::Note;
use crate::tell::{capitalise, interval};

/// A chant has a grid when at least this many of its verses are psalm verses: one verse is no
/// column to read down.
pub const GRID_VERSES: usize = 2;

/// Where a note falls in a psalm verse sung to a tone ([`crate::timeline::notes_from_gabc`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Part {
    /// Not in a psalm verse: an antiphon, a hymn, any chant sung through.
    #[default]
    Whole,
    /// Before the flex `†`.
    Flex,
    /// To the mediant `*`, after the flex if there is one.
    Mediant,
    /// After the mediant, to the verse's end.
    Termination,
}

impl Part {
    /// Its name, as the grid's column of it is headed.
    pub fn name(self) -> &'static str {
        match self {
            Part::Whole => "Verse",
            Part::Flex => "Flex",
            Part::Mediant => "Mediant",
            Part::Termination => "Termination",
        }
    }
}

/// How the judge called a cell's phrase ending.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Called {
    /// On pitch ([`crate::judge::Cadence::on_pitch`]).
    OnPitch,
    /// Off pitch.
    OffPitch,
    /// Not heard clearly enough to call either way.
    Unclear,
    /// Not sung in what was judged: a take stopped before it, or a run sung again that does not
    /// hold it.
    Unsung,
    /// It ends on the reciting tone, so it has no ending to call ([`crate::judge::cadences`]).
    Recited,
}

/// One part of one verse.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cell {
    pub part: Part,
    /// The part's notes, `first..=last`: what the singer goes to from the cell.
    pub first: usize,
    pub last: usize,
    pub called: Called,
    /// Its ending's notes, `ending.0..=ending.1`, as the judge placed them, when it has one.
    pub ending: Option<(usize, usize)>,
    /// The note of its ending furthest off, and how far, in cents from the key, when called.
    pub note: Option<usize>,
    pub cents: Option<f32>,
    /// How it was called, in words: "On pitch", "A semitone below".
    pub words: String,
}

/// One psalm verse.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Row {
    /// The verse, as the chant's notes count verses.
    pub verse: u32,
    /// Its place among the chant's psalm verses, from 1, as a singer counts them.
    pub number: usize,
    /// Its notes, `first..=last`.
    pub first: usize,
    pub last: usize,
    /// One for each of the grid's columns, in order: none where the verse has no such part, as a
    /// verse with no flex.
    pub cells: Vec<Option<Cell>>,
}

/// A column of the grid: a part of the tone, and its name.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Column {
    pub part: Part,
    pub name: String,
}

/// A psalm, verse by verse.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Grid {
    /// The parts the chant's verses have, in the order they are sung: a flex only where a verse
    /// has one.
    pub columns: Vec<Column>,
    /// The verses any of `judged` falls in, in order.
    pub rows: Vec<Row>,
}

/// The grid of `chant`'s psalm verses as `verdict` judged its notes `judged` (a take of the whole
/// chant, a take stopped short, or a run sung again: the verdict's notes are the chant's, by
/// index). A cell is called as its phrase ending is, the judge's cadence that closes the part;
/// one whose ending the verdict does not hold was not sung in what was judged. None unless the
/// verdict was heard and the chant is a recited one with at least [`GRID_VERSES`] psalm verses.
pub fn grid(chant: &[Note], verdict: &Verdict, judged: Range<usize>) -> Option<Grid> {
    if verdict.outcome != Outcome::Heard || !recited(chant) {
        return None;
    }
    // Each psalm verse's notes, in order: a verse's notes run together, so its first and last
    // hold it.
    let mut verses: Vec<(u32, usize, usize)> = Vec::new();
    for (i, n) in chant.iter().enumerate().filter(|(_, n)| n.part != Part::Whole) {
        match verses.last_mut() {
            Some((verse, _, last)) if *verse == n.verse => *last = i,
            _ => verses.push((n.verse, i, i)),
        }
    }
    if verses.len() < GRID_VERSES {
        return None;
    }
    let mut parts: Vec<Part> = chant.iter().map(|n| n.part).filter(|&p| p != Part::Whole).collect();
    parts.sort();
    parts.dedup();
    let cadences = crate::judge::cadences(chant);
    let rows = verses
        .iter()
        .enumerate()
        .filter(|&(_, &(_, first, last))| first < judged.end && judged.start <= last)
        .map(|(k, &(verse, first, last))| Row {
            verse,
            number: k + 1,
            first,
            last,
            cells: parts
                .iter()
                .map(|&part| {
                    let first = (first..=last).find(|&i| chant[i].part == part)?;
                    let last = (first..=last).rev().find(|&i| chant[i].part == part)?;
                    Some(cell(part, first, last, verdict, &cadences, &judged))
                })
                .collect(),
        })
        .collect();
    Some(Grid {
        columns: parts
            .into_iter()
            .map(|part| Column {
                part,
                name: part.name().to_string(),
            })
            .collect(),
        rows,
    })
}

/// The cell of `part` over the notes `first..=last`, as `verdict` called the cadence of the
/// chant's `cadences` that closes it; with none, ending on the reciting tone if sung in the notes
/// `judged`.
fn cell(part: Part, first: usize, last: usize, verdict: &Verdict, cadences: &[(usize, usize)], judged: &Range<usize>) -> Cell {
    let ending = cadences.iter().copied().find(|&(from, to)| to == last && first <= from);
    let sung = judged.start <= first && last < judged.end;
    let judged = verdict.cadences.iter().find(|c| c.last == last && first <= c.first);
    let called = match (ending, judged.map(|c| c.on_pitch())) {
        (None, _) if sung => Called::Recited,
        (None, _) => Called::Unsung,
        (Some(_), None) => Called::Unsung,
        (Some(_), Some(None)) => Called::Unclear,
        (Some(_), Some(Some(true))) => Called::OnPitch,
        (Some(_), Some(Some(false))) => Called::OffPitch,
    };
    let cents = judged.and_then(|c| c.cents);
    Cell {
        part,
        first,
        last,
        called,
        ending,
        note: judged.and_then(|c| c.note),
        cents,
        words: match called {
            Called::OnPitch => "On pitch".to_string(),
            Called::OffPitch => capitalise(&interval(cents.unwrap_or(0.0))),
            Called::Unclear => "Not heard clearly".to_string(),
            Called::Unsung => "Not sung".to_string(),
            Called::Recited => "Ends on the reciting tone".to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::judge::{judge, judge_again, judge_part};
    use crate::score::{NoteResult, Report};

    /// Three verses on the tenor la: the second with a flex, the third's termination never leaving
    /// the tenor. Notes 0–7 and 8–13; 14–18, 19–25 and 26–31; 32–36 and 37–42.
    const PSALM: &str = "(c4) a(f) b(g) c(h) d(h) e(h) f(h) g(i) h(h) *(:) i(h) j(h) k(h) l(h) m(g) n(f) (:) \
        a(h) b(h) c(h) d(h) e(g) †(,) f(h) g(h) h(h) i(h) j(h) k(i) l(h) *(:) m(h) n(h) o(h) p(h) q(g) r(f) (:) \
        a(h) b(h) c(h) d(i) e(h) *(:) f(h) g(h) h(h) i(h) j(h) k(h) (::)";

    fn report(cents: &[Option<f32>]) -> Report {
        Report {
            notes: cents
                .iter()
                .enumerate()
                .map(|(index, &c)| NoteResult {
                    index,
                    expected_midi: 60.0,
                    voiced_frames: if c.is_some() { 10 } else { 0 },
                    masked_frames: 0,
                    quiet_frames: if c.is_some() { 0 } else { 10 },
                    frames: 10,
                    spread_cents: c.map(|_| 20.0),
                    cents: c,
                })
                .collect(),
            heard_fraction: 0.0,
            gross_error_rate: 0.0,
            mean_abs_cents: 0.0,
        }
    }

    /// A cell as the tests compare it: its part, notes, how it was called and its words.
    type Seen = (Part, usize, usize, Called, String);

    /// Each cell of `grid`, row by row.
    fn cells(grid: &Grid) -> Vec<Vec<Option<Seen>>> {
        grid.rows
            .iter()
            .map(|r| {
                r.cells
                    .iter()
                    .map(|c| c.as_ref().map(|c| (c.part, c.first, c.last, c.called, c.words.clone())))
                    .collect()
            })
            .collect()
    }

    /// A take of the psalm in tune but a whole tone flat into every mediant.
    fn flat_mediants() -> Vec<Option<f32>> {
        let mut cents = vec![Some(0.0); 43];
        for i in [6, 24, 35] {
            cents[i] = Some(-200.0);
        }
        cents
    }

    #[test]
    fn a_psalm_is_laid_out_verse_by_verse_each_part_its_ending_as_called() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        assert_eq!(notes.len(), 43);
        let v = judge(&notes, &report(&flat_mediants()));
        let grid = grid(&notes, &v, 0..notes.len()).unwrap();
        assert_eq!(
            grid.columns.iter().map(|c| (c.part, c.name.as_str())).collect::<Vec<_>>(),
            [(Part::Flex, "Flex"), (Part::Mediant, "Mediant"), (Part::Termination, "Termination")]
        );
        assert_eq!(
            grid.rows.iter().map(|r| (r.verse, r.first, r.last)).collect::<Vec<_>>(),
            [(0, 0, 13), (1, 14, 31), (2, 32, 42)]
        );
        let below = || "A whole tone below".to_string();
        let on = || "On pitch".to_string();
        // Down the mediants, a whole tone below each time: the first verse's too, though a note of
        // the first phrase is never marked, as its cadence is called.
        assert_eq!(
            cells(&grid),
            [
                vec![
                    None,
                    Some((Part::Mediant, 0, 7, Called::OffPitch, below())),
                    Some((Part::Termination, 8, 13, Called::OnPitch, on())),
                ],
                vec![
                    Some((Part::Flex, 14, 18, Called::OnPitch, on())),
                    Some((Part::Mediant, 19, 25, Called::OffPitch, below())),
                    Some((Part::Termination, 26, 31, Called::OnPitch, on())),
                ],
                vec![
                    None,
                    Some((Part::Mediant, 32, 36, Called::OffPitch, below())),
                    Some((Part::Termination, 37, 42, Called::Recited, "Ends on the reciting tone".to_string())),
                ],
            ]
        );
        assert!(!v.marks.iter().any(|m| m.covers(6)), "{v:?}");
        // Each cell's ending is the judge's cadence closing it, its note the one called.
        let mediant = grid.rows[1].cells[1].as_ref().unwrap();
        assert_eq!(
            (mediant.ending, mediant.note, mediant.cents),
            (Some((24, 25)), Some(24), Some(-200.0))
        );
        let flex = grid.rows[1].cells[0].as_ref().unwrap();
        assert_eq!((flex.ending, flex.note), (Some((18, 18)), Some(18)));
        let last = grid.rows[2].cells[2].as_ref().unwrap();
        assert_eq!((last.ending, last.note, last.cents), (None, None, None));
    }

    #[test]
    fn an_ending_not_heard_clearly_is_said_so() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        let mut cents = flat_mediants();
        cents[30] = None;
        let v = judge(&notes, &report(&cents));
        let grid = grid(&notes, &v, 0..notes.len()).unwrap();
        let cell = grid.rows[1].cells[2].as_ref().unwrap();
        assert_eq!(
            (cell.called, cell.words.as_str(), cell.cents),
            (Called::Unclear, "Not heard clearly", None)
        );
    }

    #[test]
    fn a_take_stopped_short_has_the_verses_it_reached_and_its_parts_not_sung_said_so() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        // Stopped after the second verse's mediant.
        let v = judge_part(&notes, 26, &report(&flat_mediants()[..26]));
        let reached = grid(&notes, &v, 0..26).unwrap();
        assert_eq!(
            reached.rows.iter().map(|r| (r.verse, r.number)).collect::<Vec<_>>(),
            [(0, 1), (1, 2)]
        );
        let row = &cells(&reached)[1];
        assert_eq!(row[1].as_ref().map(|c| c.3), Some(Called::OffPitch));
        assert_eq!(row[2], Some((Part::Termination, 26, 31, Called::Unsung, "Not sung".to_string())));
        // Stopped before a part that ends on the reciting tone, it is not sung either.
        let v = judge_part(&notes, 37, &report(&flat_mediants()[..37]));
        let short = grid(&notes, &v, 0..37).unwrap();
        assert_eq!(short.rows[2].cells[2].as_ref().map(|c| c.called), Some(Called::Unsung));
    }

    #[test]
    fn a_run_sung_again_has_the_verse_it_falls_in_and_its_own_parts_called() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        let take = judge(&notes, &report(&flat_mediants()));
        // The second verse's mediant sung again in tune.
        let v = judge_again(&notes, 19..26, &report(&[Some(0.0); 7]), 0.0, &take);
        let grid = grid(&notes, &v, 19..26).unwrap();
        assert_eq!(
            cells(&grid),
            [vec![
                Some((Part::Flex, 14, 18, Called::Unsung, "Not sung".to_string())),
                Some((Part::Mediant, 19, 25, Called::OnPitch, "On pitch".to_string())),
                Some((Part::Termination, 26, 31, Called::Unsung, "Not sung".to_string())),
            ]]
        );
        // Numbered as the chant's second psalm verse, not as the grid's first row.
        assert_eq!((grid.rows[0].verse, grid.rows[0].number), (1, 2));
    }

    #[test]
    fn only_a_heard_psalm_of_two_verses_or_more_has_one() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        assert!(grid(&notes, &judge(&notes, &report(&[None; 43])), 0..43).is_none());
        // A hymn is not recited; an introit's one psalm verse is no column to read down.
        let hymn = crate::notes_from_gabc(
            "(c4) Lu(f)cis(g) cre(h)a(g)tor(f) (;) op(g)ti(h)me(g) (:) qui(h) lu(i)cem(h) (::)",
            0.5,
        );
        assert!(grid(&hymn, &judge(&hymn, &report(&vec![Some(0.0); hymn.len()])), 0..hymn.len()).is_none());
        let introit = crate::notes_from_gabc(
            "(c4) Ad(f) te(g) le(h)va(g)vi(f) (::) Vi(h)as(h) tu(h)as(h) Do(h)mi(i)ne(h) *(:) de(h)mon(h)stra(h) mi(h)hi(g) (::)",
            0.5,
        );
        let v = judge(&introit, &report(&vec![Some(0.0); introit.len()]));
        assert!(crate::judge::recited(&introit), "{introit:?}");
        assert!(grid(&introit, &v, 0..introit.len()).is_none());
    }
}
