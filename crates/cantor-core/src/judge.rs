//! From a scored take to what the singer is told: the key they sang in, whether the
//! reciting tone held steady, and marks for faults a teacher would hear across the room.
//!
//! The rules are conservative by design. A take that was mostly not heard gets no marks and
//! no notes in tune, only an outcome saying so. Otherwise a note is marked only when it is
//! at least [`MARK_CENTS`] from the singer's key, lasts at least [`MARK_MIN_S`] and is past
//! the first phrase; a verse is marked when most of it is off together (a verse a tone high)
//! or none of it was sung. Smaller errors are left to the trace.

use serde::{Deserialize, Serialize};

use crate::score::{NoteResult, Report, fold};
use crate::synth::Note;

/// A note this far from the key, in cents, is marked.
pub const MARK_CENTS: f32 = 150.0;
/// Notes shorter than this are never marked on their own.
pub const MARK_MIN_S: f32 = 0.4;
/// Notes at least this long count towards the heard fraction.
pub const HEARD_MIN_S: f32 = 0.3;
/// A note within this many cents of the key is in tune.
pub const IN_TUNE_CENTS: f32 = 50.0;
/// Below this heard fraction the take gets an outcome and nothing else.
pub const TAKE_HEARD_FLOOR: f32 = 0.5;
/// The reciting tone moving this many cents over the take is unsteady.
pub const DRIFT_CENTS: f32 = 60.0;
/// The half-width of the window the key is chosen by.
const KEY_WINDOW_CENTS: f32 = 50.0;
/// The share of a verse's heard notes that must be off together for a verse mark.
const VERSE_AGREE: f32 = 0.6;
/// Notes this far off in a marked verse's direction count as agreeing.
const VERSE_NOTE_CENTS: f32 = 100.0;
/// A verse with less than this share of its notes heard (and not masked) was not sung.
const VERSE_MISSING: f32 = 0.2;
/// Notes further than this from the key are left out of the drift.
const DRIFT_OUTLIER_CENTS: f32 = 100.0;

/// What became of the take as a whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    /// Enough was heard to judge.
    Heard,
    /// Too little was heard: the singer was silent or too quiet.
    NotHeard,
    /// Too little was heard because the guide's bleed covered the singer.
    Masked,
}

/// What a mark says.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MarkKind {
    /// One note off.
    Note,
    /// A verse off together.
    Verse,
    /// A verse not sung.
    VerseMissing,
}

/// One mark, over the notes `first..=last`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mark {
    pub kind: MarkKind,
    pub first: usize,
    pub last: usize,
    /// How far off, in cents from the key, for [`MarkKind::Note`] and [`MarkKind::Verse`].
    pub cents: Option<f32>,
}

impl Mark {
    pub fn covers(&self, index: usize) -> bool {
        (self.first..=self.last).contains(&index)
    }
}

/// What the singer is told about a take.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Verdict {
    pub outcome: Outcome,
    /// The key sung, in cents from the score's (do at middle C), when heard.
    pub key_cents: Option<f32>,
    /// How far the reciting tone moved from the first note to the last, in cents.
    pub drift_cents: f32,
    /// The drift is under [`DRIFT_CENTS`].
    pub steady: bool,
    pub marks: Vec<Mark>,
    /// Each note's error from the key, in cents, when heard.
    pub relative: Vec<Option<f32>>,
    /// How many notes were heard in tune.
    pub in_tune: usize,
}

impl Verdict {
    /// The take has no fault to report: heard, steady and unmarked.
    pub fn clean(&self) -> bool {
        self.outcome == Outcome::Heard && self.steady && self.marks.is_empty()
    }
}

/// Judges a scored take of `notes`.
pub fn judge(notes: &[Note], report: &Report) -> Verdict {
    let silent = |outcome| Verdict {
        outcome,
        key_cents: None,
        drift_cents: 0.0,
        steady: true,
        marks: Vec::new(),
        relative: vec![None; notes.len()],
        in_tune: 0,
    };
    let results = &report.notes;
    let counted: Vec<usize> = (0..notes.len()).filter(|&i| notes[i].dur_s >= HEARD_MIN_S).collect();
    let counted = if counted.is_empty() { (0..notes.len()).collect() } else { counted };
    let heard = counted.iter().filter(|&&i| results[i].cents.is_some()).count();
    if counted.is_empty() || (heard as f32) < TAKE_HEARD_FLOOR * counted.len() as f32 {
        let unheard: Vec<&NoteResult> = counted.iter().map(|&i| &results[i]).filter(|r| r.cents.is_none()).collect();
        let masked = unheard.iter().filter(|r| is_masked(r)).count();
        return silent(if 2 * masked > unheard.len() {
            Outcome::Masked
        } else {
            Outcome::NotHeard
        });
    }

    let key = key_cents(notes, results);
    let relative: Vec<Option<f32>> = results.iter().map(|r| r.cents.map(|c| fold(c - key))).collect();

    let mut marks = verse_marks(notes, results, &relative);
    for i in 0..notes.len() {
        if marks.iter().any(|m| m.covers(i)) {
            continue;
        }
        let Some(rel) = relative[i] else { continue };
        if notes[i].phrase > 0 && notes[i].dur_s >= MARK_MIN_S && rel.abs() >= MARK_CENTS {
            marks.push(Mark {
                kind: MarkKind::Note,
                first: i,
                last: i,
                cents: Some(rel),
            });
        }
    }
    marks.sort_by_key(|m| (m.first, m.last));

    let drift_cents = drift(notes, &relative, &marks);
    let in_tune = relative.iter().flatten().filter(|c| c.abs() < IN_TUNE_CENTS).count();
    Verdict {
        outcome: Outcome::Heard,
        key_cents: Some(key),
        drift_cents,
        steady: drift_cents.abs() < DRIFT_CENTS,
        marks,
        relative,
        in_tune,
    }
}

/// A note not heard whose sustained part was mostly masked.
fn is_masked(r: &NoteResult) -> bool {
    r.cents.is_none() && r.masked_frames > r.voiced_frames
}

/// The key: the offset agreed by the most sung time. Each heard note's error is a candidate;
/// the one with the most note duration within [`KEY_WINDOW_CENTS`] of it wins (the earliest
/// on a tie), and the key is the median of the errors in its window. A verse sung a tone high
/// is then a verse off the key, not a key between the two. Distances are octave-agnostic, as
/// the errors are, and the key is folded into `-600.0..600.0`.
fn key_cents(notes: &[Note], results: &[NoteResult]) -> f32 {
    let heard: Vec<(f32, f32)> = results.iter().filter_map(|r| r.cents.map(|c| (c, notes[r.index].dur_s))).collect();
    let support = |c: f32| -> f32 {
        heard
            .iter()
            .filter(|(x, _)| fold(x - c).abs() <= KEY_WINDOW_CENTS)
            .map(|(_, d)| d)
            .sum()
    };
    let mut best = (heard[0].0, f32::NEG_INFINITY);
    for &(c, _) in &heard {
        let s = support(c);
        if s > best.1 {
            best = (c, s);
        }
    }
    let mut window: Vec<f32> = heard
        .iter()
        .map(|(x, _)| fold(x - best.0))
        .filter(|d| d.abs() <= KEY_WINDOW_CENTS)
        .collect();
    fold(best.0 + median(&mut window))
}

/// Marks for verses off together and verses not sung.
fn verse_marks(notes: &[Note], results: &[NoteResult], relative: &[Option<f32>]) -> Vec<Mark> {
    let mut marks = Vec::new();
    let mut start = 0;
    while start < notes.len() {
        let verse = notes[start].verse;
        let mut end = start;
        while end + 1 < notes.len() && notes[end + 1].verse == verse {
            end += 1;
        }
        let count = end - start + 1;
        let mut heard: Vec<f32> = relative[start..=end].iter().flatten().copied().collect();
        let masked = results[start..=end].iter().filter(|r| is_masked(r)).count();
        if count >= 3 && (heard.len() as f32) < VERSE_MISSING * count as f32 && 2 * masked < count {
            marks.push(Mark {
                kind: MarkKind::VerseMissing,
                first: start,
                last: end,
                cents: None,
            });
        } else if heard.len() >= 3 {
            let m = median(&mut heard);
            let agree = heard
                .iter()
                .filter(|c| c.signum() == m.signum() && c.abs() >= VERSE_NOTE_CENTS)
                .count();
            if m.abs() >= MARK_CENTS && agree as f32 >= VERSE_AGREE * heard.len() as f32 {
                marks.push(Mark {
                    kind: MarkKind::Verse,
                    first: start,
                    last: end,
                    cents: Some(m),
                });
            }
        }
        start = end + 1;
    }
    marks
}

/// The reciting tone's movement over the take: a least-squares line through the heard notes'
/// errors against time, weighted by duration, leaving out marked notes and outliers; its rise
/// from the first such note to the last.
fn drift(notes: &[Note], relative: &[Option<f32>], marks: &[Mark]) -> f32 {
    let points: Vec<(f32, f32, f32)> = relative
        .iter()
        .enumerate()
        .filter(|(i, _)| !marks.iter().any(|m| m.covers(*i)))
        .filter_map(|(i, r)| r.map(|c| (notes[i].start_s + notes[i].dur_s / 2.0, c, notes[i].dur_s)))
        .filter(|(_, c, _)| c.abs() < DRIFT_OUTLIER_CENTS)
        .collect();
    if points.len() < 2 {
        return 0.0;
    }
    let w: f32 = points.iter().map(|p| p.2).sum();
    let mt = points.iter().map(|p| p.0 * p.2).sum::<f32>() / w;
    let mc = points.iter().map(|p| p.1 * p.2).sum::<f32>() / w;
    let sxx: f32 = points.iter().map(|p| p.2 * (p.0 - mt).powi(2)).sum();
    if sxx <= 0.0 {
        return 0.0;
    }
    let sxy: f32 = points.iter().map(|p| p.2 * (p.0 - mt) * (p.1 - mc)).sum();
    let span = points.last().map_or(0.0, |p| p.0) - points[0].0;
    sxy / sxx * span
}

/// The median of a non-empty slice, sorting it in place.
fn median(values: &mut [f32]) -> f32 {
    values.sort_by(f32::total_cmp);
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two verses of five half-second notes, each verse two phrases.
    fn notes() -> Vec<Note> {
        (0..10)
            .map(|i| Note {
                verse: (i / 5) as u32,
                phrase: (i / 3) as u32,
                ..Note::new(60.0, 0.6 * i as f32, 0.5)
            })
            .collect()
    }

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
                    cents: c,
                })
                .collect(),
            heard_fraction: 0.0,
            gross_error_rate: 0.0,
            mean_abs_cents: 0.0,
        }
    }

    #[test]
    fn a_clean_take_in_any_key_is_clean() {
        let v = judge(&notes(), &report(&[Some(-370.0); 10]));
        assert!(v.clean(), "{v:?}");
        assert_eq!(v.key_cents, Some(-370.0));
        assert_eq!(v.in_tune, 10);
    }

    #[test]
    fn a_flagrant_note_is_marked_and_a_small_one_is_not() {
        let mut c = [Some(20.0); 10];
        c[4] = Some(220.0);
        c[7] = Some(-80.0);
        let v = judge(&notes(), &report(&c));
        assert_eq!(v.marks.len(), 1, "{v:?}");
        assert_eq!((v.marks[0].kind, v.marks[0].first), (MarkKind::Note, 4));
    }

    #[test]
    fn nothing_is_marked_in_the_first_phrase() {
        let mut c = [Some(0.0); 10];
        c[1] = Some(300.0);
        assert!(judge(&notes(), &report(&c)).marks.is_empty());
    }

    #[test]
    fn a_verse_a_tone_high_is_one_mark() {
        let mut c = [Some(0.0); 10];
        for x in &mut c[5..] {
            *x = Some(200.0);
        }
        let v = judge(&notes(), &report(&c));
        assert_eq!(v.key_cents, Some(0.0));
        assert_eq!(
            v.marks,
            [Mark {
                kind: MarkKind::Verse,
                first: 5,
                last: 9,
                cents: Some(200.0)
            }]
        );
    }

    #[test]
    fn a_verse_not_sung_is_marked() {
        let mut c = [Some(0.0); 10];
        for x in &mut c[5..] {
            *x = None;
        }
        let v = judge(&notes(), &report(&c));
        assert_eq!(v.marks.len(), 1);
        assert_eq!(v.marks[0].kind, MarkKind::VerseMissing);
    }

    #[test]
    fn a_take_mostly_unheard_gets_only_an_outcome() {
        let mut c = [None; 10];
        c[0] = Some(0.0);
        c[3] = Some(400.0);
        let v = judge(&notes(), &report(&c));
        assert_eq!(v.outcome, Outcome::NotHeard);
        assert!(v.marks.is_empty());
        assert_eq!(v.in_tune, 0);
    }

    #[test]
    fn the_key_wraps_at_the_tritone() {
        let mut c = [Some(590.0); 10];
        c[3] = Some(-590.0);
        c[4] = Some(380.0);
        let v = judge(&notes(), &report(&c));
        assert_eq!(v.key_cents, Some(590.0));
        assert!((v.relative[3].unwrap() - 20.0).abs() < 1e-3);
        assert_eq!(v.marks.len(), 1, "{v:?}");
        assert!((v.marks[0].cents.unwrap() + 210.0).abs() < 1e-3);
    }

    #[test]
    fn a_sinking_tenor_is_unsteady_but_not_marked() {
        let c: Vec<Option<f32>> = (0..10).map(|i| Some(-12.0 * i as f32)).collect();
        let v = judge(&notes(), &report(&c));
        assert!(v.marks.is_empty(), "{v:?}");
        assert!(!v.steady);
        assert!((v.drift_cents + 108.0).abs() < 1.0, "{}", v.drift_cents);
    }
}
