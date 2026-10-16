//! From a scored take to what the singer is told: the key they sang in, whether the
//! reciting tone held steady, and marks for faults a teacher would hear across the room.
//!
//! The rules are conservative by design. A take that was mostly not heard gets no marks and
//! no notes in tune, only an outcome saying so. Otherwise the key is set where the singer
//! started (the first verse) and follows the singer's drift, so a sinking tenor is told the
//! tone sank, not that each later note is flat. A note is marked only when it is at least
//! [`MARK_CENTS`] from that line, lasts at least [`MARK_MIN_S`], is past the first phrase
//! and its frames agree; a verse is marked when most of it is off together (a verse a tone
//! high), or when it was silent throughout. A verse that was loud but not pitched (a clash
//! with the guide, a noisy room) is not marked. Smaller errors are left to the trace.

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
/// A note is marked on its own only from at least this many voiced frames...
const MARK_MIN_FRAMES: usize = 5;
/// ...whose errors' interquartile range is under this many cents.
const MARK_MAX_SPREAD: f32 = 100.0;
/// The half-width of the window the key is chosen by.
const KEY_WINDOW_CENTS: f32 = 50.0;
/// The share of a verse's heard notes that must be off together for a verse mark.
const VERSE_AGREE: f32 = 0.6;
/// Notes this far off in a marked verse's direction count as agreeing.
const VERSE_NOTE_CENTS: f32 = 100.0;
/// A verse is silent when at least this share of its notes' frames were below the floor.
const VERSE_SILENT: f32 = 0.8;
/// Notes further than this from the first drift line, the in-tune bound, are left out of its
/// second fit.
const DRIFT_OUTLIER_CENTS: f32 = IN_TUNE_CENTS;
/// Pairs of notes closer in time than this are left out of the drift's slope.
const DRIFT_MIN_DT_S: f32 = 0.5;
/// A cadence is off pitch when one of its notes is this far from the key and the drift.
pub const CADENCE_CENTS: f32 = 100.0;
/// A chant is recited, and has a reciting tone, when at least this share of its notes are.
const RECITED_SHARE: f32 = 1.0 / 3.0;
/// The notes ending a phrase that are its cadence where no reciting tone shows where it starts.
const CADENCE_NOTES: usize = 2;
/// The most notes a cadence found without a recitation before it reaches back over: a psalm
/// tone's longest, accent to final.
const CADENCE_MAX_NOTES: usize = 5;

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
    /// A verse silent throughout.
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

/// A phrase's cadence, over the notes `first..=last`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cadence {
    pub first: usize,
    pub last: usize,
    /// Its note furthest from the key and the drift, in cents, of the notes at least
    /// [`HEARD_MIN_S`] long heard with frames that agree, as a marked note's must. None when
    /// none was, or when one was not and none of the others is off pitch: it could have been.
    pub cents: Option<f32>,
}

impl Cadence {
    /// Whether it was sung on pitch: every note within [`CADENCE_CENTS`]. None when it was
    /// not judged.
    pub fn on_pitch(&self) -> Option<bool> {
        self.cents.map(|c| c.abs() < CADENCE_CENTS)
    }
}

/// What the singer is told about a take.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Verdict {
    pub outcome: Outcome,
    /// The key the singer started in, in cents from the score's (do at middle C), folded
    /// into `-600.0..600.0`, when heard.
    pub key_cents: Option<f32>,
    /// How far the reciting tone moved from the first heard note to the last, in cents: a
    /// robust line through the notes' errors.
    pub drift_cents: f32,
    /// The drift is under [`DRIFT_CENTS`].
    pub steady: bool,
    pub marks: Vec<Mark>,
    /// Each note's error from the key and the drift line, in cents, when heard.
    pub relative: Vec<Option<f32>>,
    /// How many notes were heard in tune and not under a mark.
    pub in_tune: usize,
    /// Each phrase's cadence.
    #[serde(default)]
    pub cadences: Vec<Cadence>,
}

impl Verdict {
    /// The take has no fault to report: heard, steady and unmarked.
    pub fn clean(&self) -> bool {
        self.outcome == Outcome::Heard && self.steady && self.marks.is_empty()
    }
}

/// Judges a scored take of `notes`. A report that does not match the notes is not heard.
pub fn judge(notes: &[Note], report: &Report) -> Verdict {
    let silent = |outcome| Verdict {
        outcome,
        key_cents: None,
        drift_cents: 0.0,
        steady: true,
        marks: Vec::new(),
        relative: vec![None; notes.len()],
        in_tune: 0,
        cadences: Vec::new(),
    };
    let results = &report.notes;
    if results.len() != notes.len() || results.iter().enumerate().any(|(i, r)| r.index != i) {
        return silent(Outcome::NotHeard);
    }
    let counted: Vec<usize> = (0..notes.len()).filter(|&i| notes[i].dur_s >= HEARD_MIN_S).collect();
    let counted = if counted.is_empty() { (0..notes.len()).collect() } else { counted };
    let heard = counted.iter().filter(|&&i| results[i].cents.is_some()).count();
    let any_heard = results.iter().any(|r| r.cents.is_some());
    if counted.is_empty() || !any_heard || (heard as f32) < TAKE_HEARD_FLOOR * counted.len() as f32 {
        let unheard: Vec<&NoteResult> = counted.iter().map(|&i| &results[i]).filter(|r| r.cents.is_none()).collect();
        let masked = unheard.iter().filter(|r| is_masked(r)).count();
        return silent(if 2 * masked > unheard.len() {
            Outcome::Masked
        } else {
            Outcome::NotHeard
        });
    }

    let (key, t0) = key_cents(notes, results);
    let errors: Vec<Option<f32>> = results.iter().map(|r| r.cents.map(|c| fold(c - key))).collect();
    let slope = drift_slope(notes, &errors, t0);
    let relative: Vec<Option<f32>> = errors
        .iter()
        .enumerate()
        .map(|(i, e)| e.map(|e| fold(e - slope * (mid(&notes[i]) - t0))))
        .collect();

    let mut marks = verse_marks(notes, results, &relative);
    for i in 0..notes.len() {
        if marks.iter().any(|m| m.covers(i)) {
            continue;
        }
        let (Some(rel), r) = (relative[i], &results[i]) else { continue };
        if notes[i].phrase > 0 && notes[i].dur_s >= MARK_MIN_S && rel.abs() >= MARK_CENTS && agreed(r) {
            marks.push(Mark {
                kind: MarkKind::Note,
                first: i,
                last: i,
                cents: Some(rel),
            });
        }
    }
    marks.sort_by_key(|m| (m.first, m.last));

    let times: Vec<f32> = (0..notes.len()).filter(|&i| errors[i].is_some()).map(|i| mid(&notes[i])).collect();
    let span = times.last().copied().unwrap_or(0.0) - times.first().copied().unwrap_or(0.0);
    let drift_cents = slope * span;
    let in_tune = relative
        .iter()
        .enumerate()
        .filter(|(i, r)| r.is_some_and(|c| c.abs() < IN_TUNE_CENTS) && !marks.iter().any(|m| m.covers(*i)))
        .count();
    let cadences = cadences(notes)
        .into_iter()
        .map(|(first, last)| Cadence {
            first,
            last,
            cents: cadence_cents(
                (first..=last)
                    .filter(|&i| notes[i].dur_s >= HEARD_MIN_S)
                    .map(|i| relative[i].filter(|_| agreed(&results[i]))),
            ),
        })
        .collect();
    Verdict {
        outcome: Outcome::Heard,
        key_cents: Some(key),
        drift_cents,
        steady: drift_cents.abs() < DRIFT_CENTS,
        marks,
        relative,
        in_tune,
        cadences,
    }
}

/// Whether the chant is recited: at least [`RECITED_SHARE`] of its notes are recitation.
pub fn recited(notes: &[Note]) -> bool {
    !notes.is_empty() && notes.iter().filter(|n| n.recitation).count() as f32 >= RECITED_SHARE * notes.len() as f32
}

/// Each phrase's cadence, as the notes `first..=last`.
///
/// In a recited chant the reciting tone is the pitch most recited notes are on, and a cadence
/// runs to the phrase's end from after the last note recited on the tone before the phrase's
/// last note off it, or, with none, after the last two notes in a row on the tone: a psalm
/// tone's mediant or termination, accent and all. A phrase that never leaves the tone has none.
/// One that neither recites nor holds the tone before leaving it runs from its first note off
/// the tone after its first note, but at most its last [`CADENCE_MAX_NOTES`] and always its last
/// note off the tone; it has none when it ends on two or more notes back on the tone.
///
/// In a chant not recited a cadence is each phrase's last [`CADENCE_NOTES`].
pub fn cadences(notes: &[Note]) -> Vec<(usize, usize)> {
    let pitch = |n: &Note| (n.midi * 100.0).round() as i32;
    let tenor = recited(notes)
        .then(|| {
            let mut count = std::collections::BTreeMap::new();
            for n in notes.iter().filter(|n| n.recitation) {
                *count.entry(pitch(n)).or_insert(0usize) += 1;
            }
            count.into_iter().max_by_key(|&(p, c)| (c, std::cmp::Reverse(p))).map(|(p, _)| p)
        })
        .flatten();
    let mut out = Vec::new();
    let mut first = 0;
    while first < notes.len() {
        let mut last = first;
        while last + 1 < notes.len() && notes[last + 1].phrase == notes[first].phrase {
            last += 1;
        }
        let ends = (last + 1).saturating_sub(CADENCE_NOTES).max(first);
        let from = match tenor {
            // The cadence reaches back from the phrase's last note off the tone to its last
            // recited note before that, else to the last two on the tone. A phrase that never
            // leaves the tone, or comes back to it for good, has none.
            Some(t) => (first..=last).rev().find(|&i| pitch(&notes[i]) != t).and_then(|off| {
                // Recited on the tone: a run on the final inside a termination is cadence.
                let recited = (first..off).rev().find(|&i| notes[i].recitation && pitch(&notes[i]) == t);
                let held = || (first + 1..off).rev().find(|&i| pitch(&notes[i]) == t && pitch(&notes[i - 1]) == t);
                match recited.or_else(held) {
                    Some(i) => Some(i + 1),
                    None => (last - off < CADENCE_NOTES).then(|| {
                        let left = (first + 1..=off).find(|&i| pitch(&notes[i]) != t).unwrap_or(off);
                        left.max((last + 1).saturating_sub(CADENCE_MAX_NOTES)).min(off)
                    }),
                }
            }),
            None => Some(ends),
        };
        if let Some(from) = from {
            out.push((from, last));
        }
        first = last + 1;
    }
    out
}

/// A cadence's note furthest from the line, of its notes' errors when clearly heard. A note
/// clearly heard off pitch puts it off whatever else was heard; otherwise a note not clearly
/// heard could be the one off, and it is not judged.
fn cadence_cents(errors: impl Iterator<Item = Option<f32>>) -> Option<f32> {
    let errors: Vec<Option<f32>> = errors.collect();
    let worst = errors.iter().flatten().copied().max_by(|a, b| a.abs().total_cmp(&b.abs()))?;
    (worst.abs() >= CADENCE_CENTS || errors.iter().all(Option::is_some)).then_some(worst)
}

/// Whether a note's frames agree on its pitch: enough of them, close together.
fn agreed(r: &NoteResult) -> bool {
    r.voiced_frames >= MARK_MIN_FRAMES && r.spread_cents.is_some_and(|s| s < MARK_MAX_SPREAD)
}

fn mid(n: &Note) -> f32 {
    n.start_s + n.dur_s / 2.0
}

/// A note not heard whose sustained part was mostly masked.
fn is_masked(r: &NoteResult) -> bool {
    r.cents.is_none() && r.masked_frames > r.voiced_frames
}

/// The key the singer started in, and the time it holds at. Over the first verse with at
/// least three heard notes (the whole take if none has), each heard note's error is a
/// candidate; the one with the most note duration within [`KEY_WINDOW_CENTS`] of it wins (the
/// earliest on a tie), and the key is the median of the errors in its window, at the mean
/// time of those notes. A later verse sung a tone high is then a verse off the key, whatever
/// share of the take it is. Distances are octave-agnostic, as the errors are.
fn key_cents(notes: &[Note], results: &[NoteResult]) -> (f32, f32) {
    let heard_in = |pick: &dyn Fn(&Note) -> bool| -> Vec<(f32, f32, f32)> {
        results
            .iter()
            .filter(|r| pick(&notes[r.index]))
            .filter_map(|r| r.cents.map(|c| (c, notes[r.index].dur_s, mid(&notes[r.index]))))
            .collect()
    };
    let mut verses: Vec<u32> = notes.iter().map(|n| n.verse).collect();
    verses.dedup();
    let heard = verses
        .iter()
        .map(|&v| heard_in(&|n: &Note| n.verse == v))
        .find(|h| h.len() >= 3)
        .unwrap_or_else(|| heard_in(&|_: &Note| true));
    let support = |c: f32| -> f32 {
        heard
            .iter()
            .filter(|(x, _, _)| fold(x - c).abs() <= KEY_WINDOW_CENTS)
            .map(|(_, d, _)| d)
            .sum()
    };
    let mut best = (heard[0].0, f32::NEG_INFINITY);
    for &(c, _, _) in &heard {
        let s = support(c);
        if s > best.1 {
            best = (c, s);
        }
    }
    let window: Vec<(f32, f32)> = heard
        .iter()
        .map(|(x, _, t)| (fold(x - best.0), *t))
        .filter(|(d, _)| d.abs() <= KEY_WINDOW_CENTS)
        .collect();
    let mut offsets: Vec<f32> = window.iter().map(|w| w.0).collect();
    let t0 = window.iter().map(|w| w.1).sum::<f32>() / window.len() as f32;
    (fold(best.0 + median(&mut offsets)), t0)
}

/// The drift, in cents per second: a Theil-Sen line (the median of pairwise slopes) through
/// the heard notes' errors from the key, fitted twice. The first fit pairs notes only within
/// a verse: a tone sinking moves within each verse, while a verse sung off is level inside
/// and would otherwise read as a slope across verses. The second leaves out the notes further
/// than [`DRIFT_OUTLIER_CENTS`] from the first line, faults and verses sung that far off, and
/// pairs the rest across verses too: within one verse a singer's slow wander can rise or fall
/// by tens of cents, which the first line would carry across the take. A verse sung off by
/// less than the cut still tilts the line, in a two-verse take by about its offset or more,
/// so a 45-cent step there can read as unsteady. A tone sinking in level steps between verses
/// and flat within them leaves the cut after a step or two and is read by the verses before.
fn drift_slope(notes: &[Note], errors: &[Option<f32>], t0: f32) -> f32 {
    let points: Vec<(u32, f32, f32)> = errors
        .iter()
        .enumerate()
        .filter_map(|(i, e)| e.map(|e| (notes[i].verse, mid(&notes[i]), e)))
        .collect();
    let first = theil_sen(&points, true);
    let inliers: Vec<(u32, f32, f32)> = points
        .iter()
        .copied()
        .filter(|(_, t, e)| fold(e - first * (t - t0)).abs() < DRIFT_OUTLIER_CENTS)
        .collect();
    theil_sen(&inliers, false)
}

/// The median slope over pairs of points at least [`DRIFT_MIN_DT_S`] apart, within one
/// verse when `within`.
fn theil_sen(points: &[(u32, f32, f32)], within: bool) -> f32 {
    let mut slopes = Vec::new();
    for (i, a) in points.iter().enumerate() {
        for b in points[i + 1..].iter().filter(|b| !within || b.0 == a.0) {
            let dt = b.1 - a.1;
            if dt.abs() >= DRIFT_MIN_DT_S {
                slopes.push(fold(b.2 - a.2) / dt);
            }
        }
    }
    if slopes.is_empty() { 0.0 } else { median(&mut slopes) }
}

/// Marks for verses off together and verses silent throughout.
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
        let frames: usize = results[start..=end].iter().map(|r| r.frames).sum();
        let quiet: usize = results[start..=end].iter().map(|r| r.quiet_frames).sum();
        if count >= 3 && frames > 0 && quiet as f32 >= VERSE_SILENT * frames as f32 {
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
                    // An unheard note here was silent.
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
    fn a_rise_inside_each_verse_is_not_a_drift() {
        // Each verse rises 32 cents and the next starts where the first did: a singer's
        // wander, not a take sharpening by 32 cents a verse.
        let c: Vec<Option<f32>> = (0..10).map(|i| Some(8.0 * (i % 5) as f32)).collect();
        let v = judge(&notes(), &report(&c));
        assert!(v.steady, "{}", v.drift_cents);
        assert!(v.drift_cents.abs() < 30.0, "{}", v.drift_cents);
        assert!(v.marks.is_empty(), "{v:?}");
    }

    #[test]
    fn a_verse_sung_off_is_not_a_drift() {
        let c: Vec<Option<f32>> = (0..10).map(|i| Some(if i < 5 { 0.0 } else { 80.0 })).collect();
        let v = judge(&notes(), &report(&c));
        assert!(v.steady, "{}", v.drift_cents);
        assert!(v.drift_cents.abs() < 30.0, "{}", v.drift_cents);
        assert_eq!(v.in_tune, 5);
    }

    #[test]
    fn a_drift_under_a_step_the_other_way_is_still_a_drift() {
        // Sinking 20 cents a second, the second verse a step sharp: still sinking.
        let c: Vec<Option<f32>> = notes()
            .iter()
            .enumerate()
            .map(|(i, n)| Some(-20.0 * n.start_s + if i < 5 { 0.0 } else { 80.0 }))
            .collect();
        let v = judge(&notes(), &report(&c));
        assert!(!v.steady, "{}", v.drift_cents);
        assert!(v.drift_cents < -DRIFT_CENTS, "{}", v.drift_cents);
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
    fn a_verse_loud_but_unpitched_is_not_marked() {
        let mut c = [Some(0.0); 10];
        for x in &mut c[5..] {
            *x = None;
        }
        let mut r = report(&c);
        for n in &mut r.notes[5..] {
            n.quiet_frames = 0;
        }
        assert!(judge(&notes(), &r).marks.is_empty());
    }

    #[test]
    fn a_note_whose_frames_disagree_is_not_marked() {
        let mut c = [Some(0.0); 10];
        c[4] = Some(-570.0);
        let mut r = report(&c);
        r.notes[4].spread_cents = Some(400.0);
        assert!(judge(&notes(), &r).marks.is_empty());
        r.notes[4].spread_cents = Some(20.0);
        r.notes[4].voiced_frames = 4;
        assert!(judge(&notes(), &r).marks.is_empty());
    }

    #[test]
    fn a_report_for_other_notes_is_not_heard() {
        let r = report(&[Some(0.0); 9]);
        assert_eq!(judge(&notes(), &r).outcome, Outcome::NotHeard);
    }

    #[test]
    fn the_key_is_where_the_singer_started() {
        // Verse 0 in tune, verse 1 (the longer) a tone high: verse 1 is off, not verse 0.
        let notes: Vec<Note> = (0..12)
            .map(|i| Note {
                verse: u32::from(i >= 4),
                phrase: (i / 2) as u32,
                ..Note::new(60.0, 0.6 * i as f32, 0.5)
            })
            .collect();
        let c: Vec<Option<f32>> = (0..12).map(|i| Some(if i >= 4 { 200.0 } else { 0.0 })).collect();
        let v = judge(&notes, &report(&c));
        assert_eq!(v.key_cents, Some(0.0));
        assert_eq!(v.marks.len(), 1, "{v:?}");
        assert_eq!((v.marks[0].kind, v.marks[0].first), (MarkKind::Verse, 4));
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
        // Sinking four times as fast still marks nothing, and the drift is told in full.
        let c: Vec<Option<f32>> = (0..10).map(|i| Some(-48.0 * i as f32)).collect();
        let v = judge(&notes(), &report(&c));
        assert!(v.marks.is_empty(), "{v:?}");
        assert!((v.drift_cents + 432.0).abs() < 1.0, "{}", v.drift_cents);
    }

    const PSALM: &str = "(c4) O(g) praise(h) the(j) Lord(j) all(j) ye(j) hea(k)then:(j.) *(:) praise(j) him(j) all(i) ye(j) na(h)tions.(g.) (::) \
        Glo(j)ry(j) be(j) to(j) the(j) Fa(j)ther,(j) and(j) to(k) the(j) Son:(j.) *(:) world(j) with(j) end(j) a(j)men.(j) (::)";

    #[test]
    fn a_psalm_tones_cadence_follows_its_recitation() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        assert!(recited(&notes));
        // "hea-then"; "all ye na-tions"; "to the Son" (its last two notes on the tone); and
        // nothing for a phrase that never leaves the tone.
        assert_eq!(cadences(&notes), [(6, 7), (10, 13), (22, 24)]);
    }

    #[test]
    fn a_cadence_keeps_its_accent_when_it_passes_the_tone() {
        // Tone VII's mediant leaves the tenor (i) for its accent and passes it twice on the way
        // down: "fróm my wíck-ed-ness" is all cadence. A first half-verse that comes back to the
        // tenor after its intonation has none.
        let notes = crate::notes_from_gabc(
            "(c3) Wash(i) me(i) through(i)ly(i) fróm(k) my(j) wíck(i)ed(i)ness,(j) *(:) and(i) cléanse(j) me(i) fróm(h) my(g) sin.(g) (::) \
             O(g) praise(h) the(i) Lord(i) all(i) ye(i) hea(i)then(i) *(:) praise(i) him(i) all(i) ye(i) na(h)tions.(g) (::)",
            0.5,
        );
        assert_eq!(cadences(&notes), [(4, 8), (10, 14), (27, 28)]);
        // A run on the final inside a termination is no recitation to start after.
        let notes = crate::notes_from_gabc(
            "(c4) Glo(j)ry(j) be(j) to(j) the(j) Fa(j)ther,(j) and(j) to(k) the(j) Son:(j.) *(:) and(j) to(j) the(j) Ho(j)ly(h) Son,(h) and(g) to(g) the(g) Ghost.(g) (::)",
            0.5,
        );
        assert_eq!(cadences(&notes)[1], (15, 20));
    }

    #[test]
    fn a_chant_not_recited_ends_each_phrase_in_two_notes() {
        let notes = crate::notes_from_gabc("(c4) Te(g) lu(h)cis(j) an(i)te(h) (,) ter(g)mi(h)num(g) (::)", 0.5);
        assert!(!recited(&notes));
        assert_eq!(cadences(&notes), [(3, 4), (6, 7)]);
    }

    #[test]
    fn a_cadence_is_judged_in_the_first_phrase_too() {
        // The first mediant a minor third flat: no mark, as the first phrase never has one, but
        // its cadence is off pitch; a termination 80 cents flat is still on it.
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        let cents: Vec<Option<f32>> = (0..notes.len())
            .map(|i| {
                Some(match i {
                    6 | 7 => -300.0,
                    12 | 13 => -80.0,
                    _ => 0.0,
                })
            })
            .collect();
        let v = judge(&notes, &report(&cents));
        assert!(v.marks.is_empty(), "{:?}", v.marks);
        let on: Vec<Option<bool>> = v.cadences.iter().map(Cadence::on_pitch).collect();
        assert_eq!(on, [Some(false), Some(true), Some(true)]);
        // A note clearly heard off puts its cadence off, whatever trailed away after it.
        let mut trailing = cents.clone();
        trailing[12] = Some(200.0);
        trailing[13] = None;
        assert_eq!(judge(&notes, &report(&trailing)).cadences[1].on_pitch(), Some(false));
        // Otherwise a cadence with a note whose frames disagree is not judged, nor one not heard.
        let mut disagreeing = report(&cents);
        disagreeing.notes[12].spread_cents = Some(200.0);
        assert_eq!(judge(&notes, &disagreeing).cadences[1].on_pitch(), None);
        let mut cents = cents;
        cents[22..=24].fill(None);
        let v = judge(&notes, &report(&cents));
        assert_eq!(v.cadences[2].on_pitch(), None);
    }
}
