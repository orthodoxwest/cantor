//! A psalm sung to a tone, verse by verse: a row for each verse and a column for each part of the
//! tone (its flex, mediant and termination), each cell that part of the verse with its phrase
//! ending as the judge called it. So a fault sung at every mediant reads down a column. The grid
//! tells nothing the judge did not: its cells are the verdict's cadences, placed by where they
//! fall in each verse, and their words are of them.

use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::judge::{Cadence, Outcome, Verdict, recited};
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
    /// Too little of it heard to call either way: its notes too short, or their frames at odds
    /// ([`crate::judge::Cadence::cents`]).
    Unclear,
    /// Sung in part, a take stopped in it before its ending: not judged.
    Stopped,
    /// Not sung: a take stopped before it, or a run sung again that does not hold its ending
    /// (one that holds it only in part, ended before it, does not sing it).
    Unsung,
    /// Sung, but the judge places no ending in it to call ([`crate::judge::cadences`]): one that
    /// stays on the reciting tone, or whose syllables leave no recited note before its formula.
    NoEnding,
}

/// An ending inside a part, at a pause before the one closing it (a breath, or the first of two flexes),
/// that the judge heard off pitch: over the notes `first..=last`, its note furthest off and how
/// far, in cents from the key, and in words.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Inner {
    pub first: usize,
    pub last: usize,
    pub note: Option<usize>,
    pub cents: Option<f32>,
    pub words: String,
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
    /// The endings off pitch inside it, before the one closing it, in order: so a part whose own
    /// ending was on pitch does not read as wholly on pitch while one of its earlier phrases
    /// went off. None in a part not sung.
    #[serde(default)]
    pub inner: Vec<Inner>,
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
    /// The verses any of what was sung falls in, in order.
    pub rows: Vec<Row>,
}

/// The grid of `chant`'s psalm verses as `verdict` judged its notes `judged` (a take of the whole
/// chant, all its notes; a take stopped short, to the end of the last phrase finished; a run sung
/// again, the run's: the verdict's notes are the chant's, by index), where a take stopped short
/// was `cut`: the end of the notes it sang, through the last sung whole. A row for each verse any
/// of what was sung falls in. A cell is called as its phrase ending is, the judge's cadence that
/// closes the part, with the endings inside it heard off pitch; one whose ending the verdict does
/// not hold was stopped in if the take was cut in it, else not sung. None unless the verdict was
/// heard and the chant is a recited one with at least [`GRID_VERSES`] psalm verses.
pub fn grid(chant: &[Note], verdict: &Verdict, judged: Range<usize>, cut: Option<usize>) -> Option<Grid> {
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
        .filter(|&(_, &(_, first, last))| first < cut.unwrap_or(0).max(judged.end) && judged.start <= last)
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
                    Some(cell(part, first, last, verdict, &cadences, &judged, cut))
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
/// chant's `cadences` that closes it, with those inside it it called off pitch; with none, one
/// with no ending if it was all judged in the notes `judged`. One the verdict did not call was
/// stopped in if a take was `cut` in it or past its start, else not sung.
fn cell(
    part: Part,
    first: usize,
    last: usize,
    verdict: &Verdict,
    cadences: &[(usize, usize)],
    judged: &Range<usize>,
    cut: Option<usize>,
) -> Cell {
    let ending = cadences.iter().copied().find(|&(from, to)| to == last && first <= from);
    let all_judged = judged.start <= first && last < judged.end;
    let cut_in = cut.is_some_and(|cut| first < cut);
    let called_as = verdict.cadences.iter().find(|c| c.last == last && first <= c.first);
    let called = match (ending, called_as.map(|c| c.on_pitch())) {
        (None, _) if all_judged => Called::NoEnding,
        (Some(_), Some(None)) => Called::Unclear,
        (Some(_), Some(Some(true))) => Called::OnPitch,
        (Some(_), Some(Some(false))) => Called::OffPitch,
        _ if cut_in && !all_judged => Called::Stopped,
        _ => Called::Unsung,
    };
    // A part not sung, as a run's that holds only some of it, tells nothing of what it holds.
    let inside = |c: &&Cadence| called != Called::Unsung && first <= c.first && c.last < last;
    let inner = verdict
        .cadences
        .iter()
        .filter(|c| inside(c) && c.on_pitch() == Some(false))
        .map(|c| Inner {
            first: c.first,
            last: c.last,
            note: c.note,
            cents: c.cents,
            words: format!("At a pause in it, {}", interval(c.cents.unwrap_or(0.0))),
        })
        .collect();
    let cents = called_as.and_then(|c| c.cents);
    Cell {
        part,
        first,
        last,
        called,
        ending,
        note: called_as.and_then(|c| c.note),
        cents,
        words: match called {
            Called::OnPitch => "On pitch".to_string(),
            Called::OffPitch => capitalise(&interval(cents.unwrap_or(0.0))),
            Called::Unclear => "Too little heard to judge".to_string(),
            Called::Stopped => "Stopped before its end".to_string(),
            Called::Unsung => "Not sung".to_string(),
            Called::NoEnding => "No ending to judge".to_string(),
        },
        inner,
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
        let grid = grid(&notes, &v, 0..notes.len(), None).unwrap();
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
                    Some((Part::Termination, 37, 42, Called::NoEnding, "No ending to judge".to_string())),
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
        let grid = grid(&notes, &v, 0..notes.len(), None).unwrap();
        let cell = grid.rows[1].cells[2].as_ref().unwrap();
        assert_eq!(
            (cell.called, cell.words.as_str(), cell.cents),
            (Called::Unclear, "Too little heard to judge", None)
        );
    }

    #[test]
    fn a_take_stopped_short_has_the_verses_it_reached_and_says_which_parts_it_stopped_in() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        let stopped = || ("Stopped before its end".to_string(), Called::Stopped);
        let unsung = || ("Not sung".to_string(), Called::Unsung);
        let said = |grid: &Grid| -> Vec<Vec<Option<(String, Called)>>> {
            cells(grid)
                .into_iter()
                .map(|r| r.into_iter().map(|c| c.map(|c| (c.4, c.3))).collect())
                .collect()
        };
        // Stopped after the second verse's mediant: judged and sung to there.
        let v = judge_part(&notes, 26, &report(&flat_mediants()[..26]));
        let reached = grid(&notes, &v, 0..26, Some(26)).unwrap();
        assert_eq!(
            reached.rows.iter().map(|r| (r.verse, r.number)).collect::<Vec<_>>(),
            [(0, 1), (1, 2)]
        );
        let row = &cells(&reached)[1];
        assert_eq!(row[1].as_ref().map(|c| c.3), Some(Called::OffPitch));
        assert_eq!(row[2], Some((Part::Termination, 26, 31, Called::Unsung, "Not sung".to_string())));
        // Stopped partway through the second verse's termination, sung whole through note 28: it
        // was stopped in, not left unsung.
        let v = judge_part(&notes, 26, &report(&flat_mediants()[..26]));
        assert_eq!(said(&grid(&notes, &v, 0..26, Some(29)).unwrap())[1][2], Some(stopped()));
        // Stopped in the third verse's mediant, which is judged not at all: the verse has a row,
        // its mediant stopped in and its termination not sung.
        let v = judge_part(&notes, 32, &report(&flat_mediants()[..32]));
        let third = grid(&notes, &v, 0..32, Some(35)).unwrap();
        assert_eq!(third.rows.iter().map(|r| r.number).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(said(&third)[2], [None, Some(stopped()), Some(unsung())]);
        // Stopped before a part with no ending, it is not sung either; stopped in it, stopped in.
        let v = judge_part(&notes, 37, &report(&flat_mediants()[..37]));
        assert_eq!(said(&grid(&notes, &v, 0..37, Some(37)).unwrap())[2][2], Some(unsung()));
        assert_eq!(said(&grid(&notes, &v, 0..37, Some(40)).unwrap())[2][2], Some(stopped()));
    }

    #[test]
    fn an_ending_off_pitch_inside_a_part_is_told_with_it() {
        // A breath inside the first verse's mediant, and two flexes in the second verse: each
        // part's earlier ending is its own phrase, closed before the part's.
        let gabc = "(c4) a(h) b(h) c(h) d(g) (,) e(h) f(h) g(h) h(i) i(h) *(:) j(h) k(h) l(h) m(g) n(f) (:) \
            a(h) b(h) c(h) d(g) †(,) e(h) f(h) g(h) h(g) †(,) i(h) j(h) k(h) l(i) m(h) *(:) n(h) o(h) p(h) q(g) r(f) (::)";
        let notes = crate::notes_from_gabc(gabc, 0.5);
        let cadences = crate::judge::cadences(&notes);
        let mediant = (0..notes.len())
            .filter(|&i| notes[i].verse == 0 && notes[i].part == Part::Mediant)
            .max()
            .unwrap();
        let flex = (0..notes.len()).filter(|&i| notes[i].part == Part::Flex).max().unwrap();
        // The ending at the breath, and at the first flex.
        let breath = *cadences.iter().find(|&&(_, to)| to < mediant).unwrap();
        let first_flex = *cadences
            .iter()
            .rev()
            .find(|&&(from, to)| to < flex && notes[from].part == Part::Flex)
            .unwrap();
        let mut cents = vec![Some(0.0); notes.len()];
        cents[breath.1] = Some(-200.0);
        cents[first_flex.1] = Some(-200.0);
        let v = judge(&notes, &report(&cents));
        let grid = grid(&notes, &v, 0..notes.len(), None).unwrap();
        let inner = |r: usize, c: usize| -> (Called, Vec<(usize, usize, String)>) {
            let cell = grid.rows[r].cells[c].as_ref().unwrap();
            (cell.called, cell.inner.iter().map(|i| (i.first, i.last, i.words.clone())).collect())
        };
        let earlier = |(from, to): (usize, usize)| vec![(from, to, "At a pause in it, a whole tone below".to_string())];
        // The part's own ending on pitch, its earlier one off and told with it.
        assert_eq!(
            grid.columns.iter().map(|c| c.part).collect::<Vec<_>>(),
            [Part::Flex, Part::Mediant, Part::Termination]
        );
        assert_eq!(inner(0, 1), (Called::OnPitch, earlier(breath)));
        assert_eq!(inner(1, 0), (Called::OnPitch, earlier(first_flex)));
        assert_eq!(inner(1, 1), (Called::OnPitch, vec![]));
        let noted = &grid.rows[0].cells[1].as_ref().unwrap().inner[0];
        assert_eq!((noted.note, noted.cents), (Some(breath.1), Some(-200.0)));
        // Every ending the verdict called off pitch is in a cell, its own or one inside it.
        let off: Vec<(usize, usize)> = v
            .cadences
            .iter()
            .filter(|c| c.on_pitch() == Some(false))
            .map(|c| (c.first, c.last))
            .collect();
        let told: Vec<(usize, usize)> = grid
            .rows
            .iter()
            .flat_map(|r| r.cells.iter().flatten())
            .flat_map(|c| {
                c.inner
                    .iter()
                    .map(|i| (i.first, i.last))
                    .chain((c.called == Called::OffPitch).then(|| c.ending.unwrap()))
            })
            .collect();
        assert_eq!(off, told);
        assert_eq!(off.len(), 2, "{v:?}");
    }

    #[test]
    fn a_run_sung_again_has_the_verse_it_falls_in_and_its_own_parts_called() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        let take = judge(&notes, &report(&flat_mediants()));
        // The second verse's mediant sung again in tune.
        let v = judge_again(&notes, 19..26, &report(&[Some(0.0); 7]), 0.0, &take);
        let grid = grid(&notes, &v, 19..26, None).unwrap();
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
    fn a_run_sung_again_over_part_of_a_part_leaves_its_ending_unsung() {
        // A breath inside the first verse's mediant, notes 0–3 before it: sung again alone, off
        // at the breath, the mediant's ending is not sung, and the run was not stopped in it. The
        // part not sung tells nothing of its breath, which the run tells of on the score.
        let gabc = "(c4) a(h) b(h) c(h) d(g) (,) e(h) f(h) g(h) h(i) i(h) *(:) j(h) k(h) l(h) m(g) n(f) (:) \
            a(h) b(h) c(h) d(h) e(i) f(h) *(:) g(h) h(h) i(h) j(g) k(f) (::)";
        let notes = crate::notes_from_gabc(gabc, 0.5);
        let take = judge(&notes, &report(&vec![Some(0.0); notes.len()]));
        let v = judge_again(&notes, 0..4, &report(&[Some(0.0), Some(0.0), Some(0.0), Some(-200.0)]), 0.0, &take);
        let grid = grid(&notes, &v, 0..4, None).unwrap();
        assert_eq!(grid.rows.iter().map(|r| r.number).collect::<Vec<_>>(), [1]);
        // No verse has a flex: the mediant is the first column.
        let mediant = grid.rows[0].cells[0].as_ref().unwrap();
        assert_eq!(
            (mediant.part, mediant.called, mediant.words.as_str()),
            (Part::Mediant, Called::Unsung, "Not sung")
        );
        assert!(mediant.inner.is_empty(), "{mediant:?}");
        assert!(v.cadences.iter().any(|c| c.last == 3 && c.on_pitch() == Some(false)), "{v:?}");
    }

    #[test]
    fn only_a_heard_psalm_of_two_verses_or_more_has_one() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        assert!(grid(&notes, &judge(&notes, &report(&[None; 43])), 0..43, None).is_none());
        // A hymn is not recited; an introit's one psalm verse is no column to read down.
        let hymn = crate::notes_from_gabc(
            "(c4) Lu(f)cis(g) cre(h)a(g)tor(f) (;) op(g)ti(h)me(g) (:) qui(h) lu(i)cem(h) (::)",
            0.5,
        );
        assert!(grid(&hymn, &judge(&hymn, &report(&vec![Some(0.0); hymn.len()])), 0..hymn.len(), None).is_none());
        let introit = crate::notes_from_gabc(
            "(c4) Ad(f) te(g) le(h)va(g)vi(f) (::) Vi(h)as(h) tu(h)as(h) Do(h)mi(i)ne(h) *(:) de(h)mon(h)stra(h) mi(h)hi(g) (::)",
            0.5,
        );
        let v = judge(&introit, &report(&vec![Some(0.0); introit.len()]));
        assert!(crate::judge::recited(&introit), "{introit:?}");
        assert!(grid(&introit, &v, 0..introit.len(), None).is_none());
    }
}
