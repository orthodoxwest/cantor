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
//!
//! A run of the chant sung again after a take ([`judge_again`]) is judged in the key the take
//! was in there, given, with no drift: so a note of its first phrase may be marked too, and the
//! part of a verse the run holds is marked as a verse when all of it was off together.

use std::ops::Range;

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
    /// The note `cents` is of, by index.
    #[serde(default)]
    pub note: Option<usize>,
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
    /// into `-600.0..600.0`, when heard; of a run sung again, the key it was judged in.
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

    /// The verdict on `len` notes not judged, for `outcome`: nothing heard of them.
    fn silent(outcome: Outcome, len: usize) -> Verdict {
        Verdict {
            outcome,
            key_cents: None,
            drift_cents: 0.0,
            steady: true,
            marks: Vec::new(),
            relative: vec![None; len],
            in_tune: 0,
            cadences: Vec::new(),
        }
    }

    /// The verdict on notes from `first` on, with its notes indexed as among `len`: those before
    /// and after them not heard.
    fn placed(mut self, first: usize, len: usize) -> Verdict {
        for m in &mut self.marks {
            m.first += first;
            m.last += first;
        }
        for c in &mut self.cadences {
            c.first += first;
            c.last += first;
            c.note = c.note.map(|n| n + first);
        }
        let mut relative = vec![None; len];
        for (i, r) in self.relative.into_iter().enumerate() {
            if let Some(at) = relative.get_mut(first + i) {
                *at = r;
            }
        }
        self.relative = relative;
        self
    }

    /// The verdict on the notes `run` alone, indexed from its first, as [`judge_again`] judged
    /// them: their marks, cadences and errors, its outcome, key, drift and count in tune as they
    /// were (of the whole take, for a take's verdict).
    pub fn within(&self, run: Range<usize>) -> Verdict {
        let inside = |first: usize, last: usize| first >= run.start && last < run.end;
        Verdict {
            marks: self
                .marks
                .iter()
                .filter(|m| inside(m.first, m.last))
                .map(|m| Mark {
                    first: m.first - run.start,
                    last: m.last - run.start,
                    ..*m
                })
                .collect(),
            cadences: self
                .cadences
                .iter()
                .filter(|c| inside(c.first, c.last))
                .map(|c| Cadence {
                    first: c.first - run.start,
                    last: c.last - run.start,
                    note: c.note.map(|n| n - run.start),
                    ..*c
                })
                .collect(),
            relative: self.relative.get(run).map_or_else(Vec::new, <[_]>::to_vec),
            ..self.clone()
        }
    }
}

/// Judges a scored take of `notes`. A report that does not match the notes is not heard.
pub fn judge(notes: &[Note], report: &Report) -> Verdict {
    judge_part(notes, notes.len(), report)
}

/// Judges a scored take of the first `judged` of `chant`'s notes, as of a take stopped short
/// at the end of a phrase: on those notes alone, but with the cadences the whole chant has
/// (whether it is recited, and its reciting tone, are the whole chant's), so that a phrase
/// finished is judged as when the chant is sung whole. A report that does not match those
/// notes is not heard.
pub fn judge_part(chant: &[Note], judged: usize, report: &Report) -> Verdict {
    judge_run(chant, 0..judged.min(chant.len()), report, None)
}

/// Judges a scored take of `chant`'s notes `run` alone, sung again after `take`, a take of the
/// whole chant, in that take's key there, `key_cents`: against that key, with no drift (a run is
/// too short to read one from, and not sung long enough to drift), and with the cadences the
/// whole chant has there. The key is given, so a note may be marked in the first phrase too. A
/// verse the run holds whole is marked as a take's is. The part of a verse it holds is marked as
/// a verse, by the same rule, only where the take marked that verse, so a phrase of a verse the
/// take marked sung off again is marked as the verse was, though its recited notes are too short
/// to be marked alone ([`crate::tell::told_again`] tells such a mark of its notes, not of the
/// verse); elsewhere its notes are judged one at a time, as the take judged them, a phrase being
/// too few notes to judge a verse by. The verdict's notes are the chant's, by index, those
/// outside the run not heard; `report` scores the run's alone, from its first. A report that
/// does not match them is not heard.
///
/// A key that is not a number (no key to sing it in) leaves the run not heard; a run that ends
/// before it begins is empty.
pub fn judge_again(chant: &[Note], run: Range<usize>, report: &Report, key_cents: f32, take: &Verdict) -> Verdict {
    let start = run.start.min(chant.len());
    let run = start..run.end.clamp(start, chant.len());
    if !key_cents.is_finite() {
        return Verdict::silent(Outcome::NotHeard, chant.len());
    }
    judge_run(chant, run.clone(), report, Some((fold(key_cents), take))).placed(run.start, chant.len())
}

/// The key the take judged `verdict` (scored as `report`) was in at its notes `run`, for the run to
/// be sung again in ([`judge_again`]): its key moved along its drift line to there, the median of
/// where the line lay at each of the run's notes the judge read an error of; at the key the take
/// started in when it read none there, and none when the take had no key. A singer who sinks
/// sings a run again where they had sunk to, as the run was sung in the take.
pub fn key_at(verdict: &Verdict, report: &Report, run: Range<usize>) -> Option<f32> {
    let key = verdict.key_cents?;
    let mut moved: Vec<f32> = run
        .filter_map(|i| {
            match (
                report.notes.get(i).and_then(|r| r.cents),
                verdict.relative.get(i).copied().flatten(),
            ) {
                (Some(c), Some(rel)) => Some(fold(c - key - rel)),
                _ => None,
            }
        })
        .collect();
    let line = if moved.is_empty() { 0.0 } else { median(&mut moved) };
    Some(fold(key + line))
}

/// Judges a scored take of `chant`'s notes `run`, indexed from the run's first: sung `again` in a
/// key given after a take (see [`judge_again`]), else in the key the take starts in, following
/// its drift.
fn judge_run(chant: &[Note], run: Range<usize>, report: &Report, again: Option<(f32, &Verdict)>) -> Verdict {
    let notes = &chant[run.clone()];
    let silent = |outcome| Verdict::silent(outcome, notes.len());
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

    let given = again.is_some();
    let (key, t0) = again.map_or_else(|| key_cents(notes, results), |(key, _)| (key, 0.0));
    let errors: Vec<Option<f32>> = results.iter().map(|r| r.cents.map(|c| fold(c - key))).collect();
    let slope = if given { 0.0 } else { drift_slope(notes, &errors, t0) };
    let relative: Vec<Option<f32>> = errors
        .iter()
        .enumerate()
        .map(|(i, e)| e.map(|e| fold(e - slope * (mid(&notes[i]) - t0))))
        .collect();

    // Sung again, the part of a verse a run holds is marked as a verse only under the take's mark
    // on that verse: a phrase is too few notes to judge a verse by, and where the take judged the
    // verse's notes one at a time, so is the run's part of it. The whole of a verse is marked as
    // the take marks one.
    let whole = |m: &Mark| {
        let verse = notes[m.first].verse;
        let (a, b) = (run.start + m.first, run.start + m.last);
        (a == 0 || chant[a - 1].verse != verse) && chant.get(b + 1).is_none_or(|n| n.verse != verse)
    };
    let under = |m: &Mark| {
        again.is_none_or(|(_, take)| {
            take.marks
                .iter()
                .any(|t| t.kind != MarkKind::Note && t.first <= run.start + m.first && run.start + m.last <= t.last)
        })
    };
    let mut marks: Vec<Mark> = verse_marks(notes, results, &relative)
        .into_iter()
        .filter(|m| whole(m) || under(m))
        .collect();
    for i in 0..notes.len() {
        if marks.iter().any(|m| m.covers(i)) {
            continue;
        }
        let (Some(rel), r) = (relative[i], &results[i]) else { continue };
        if (given || notes[i].phrase > 0) && notes[i].dur_s >= MARK_MIN_S && rel.abs() >= MARK_CENTS && agreed(r) {
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
    let cadences = cadences(chant)
        .into_iter()
        .filter(|&(first, last)| first >= run.start && last < run.end)
        .map(|(first, last)| (first - run.start, last - run.start))
        .map(|(first, last)| {
            let worst = cadence_cents(
                (first..=last)
                    .filter(|&i| notes[i].dur_s >= HEARD_MIN_S)
                    .map(|i| (i, relative[i].filter(|_| agreed(&results[i])))),
            );
            Cadence {
                first,
                last,
                note: worst.map(|(i, _)| i),
                cents: worst.map(|(_, cents)| cents),
            }
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
/// the tone after its first note ("and cléanse me fróm my sin"); it has none when it ends on two
/// or more notes back on the tone. So in a recited chant an antiphon's phrase is nearly all
/// cadence.
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
                    None => (last - off < CADENCE_NOTES).then(|| (first + 1..=off).find(|&i| pitch(&notes[i]) != t).unwrap_or(off)),
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

/// A cadence's note furthest from the line, of its notes' errors (by index) when clearly
/// heard, the first of them on a tie, with its error. A note clearly heard off pitch puts it off
/// whatever else was heard; otherwise a note not clearly heard could be the one off, and it is
/// not judged.
fn cadence_cents(errors: impl Iterator<Item = (usize, Option<f32>)>) -> Option<(usize, f32)> {
    let errors: Vec<(usize, Option<f32>)> = errors.collect();
    let worst = errors
        .iter()
        .filter_map(|&(i, e)| Some((i, e?)))
        .reduce(|a, b| if b.1.abs() > a.1.abs() { b } else { a })?;
    (worst.1.abs() >= CADENCE_CENTS || errors.iter().all(|(_, e)| e.is_some())).then_some(worst)
}

/// Whether a note's frames agree on its pitch: enough of them, close together, as a note marked
/// alone needs.
pub fn agreed(r: &NoteResult) -> bool {
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

    /// A take of `notes` sung in tune, with no marks, for a run to be sung again after.
    fn plain(notes: &[Note]) -> Verdict {
        judge(notes, &report(&vec![Some(0.0); notes.len()]))
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
    fn a_take_stopped_short_keeps_the_whole_chants_cadences() {
        // The psalm's first verse alone is too little recited to be read as a recited chant, so
        // judged on its own its second cadence would be its last two notes, "na-tions". Stopped
        // there, it is still the tone's termination, "all ye na-tions", as sung whole.
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        assert!(!recited(&notes[..14]));
        assert_eq!(cadences(&notes[..14]), [(6, 7), (12, 13)]);
        let v = judge_part(&notes, 14, &report(&[Some(0.0); 14]));
        assert_eq!(v.cadences.iter().map(|c| (c.first, c.last)).collect::<Vec<_>>(), [(6, 7), (10, 13)]);
        assert_eq!(v.relative.len(), 14);
        // Judged whole, a take is judged as by `judge`.
        let cents = vec![Some(0.0); notes.len()];
        assert_eq!(judge_part(&notes, notes.len(), &report(&cents)), judge(&notes, &report(&cents)));
    }

    #[test]
    fn a_run_sung_again_is_judged_in_the_key_given_with_its_notes_where_they_are_in_the_chant() {
        // Notes 3 to 5 again, the middle one a major second high, in the key the take was in.
        let v = judge_again(
            &notes(),
            3..6,
            &report(&[Some(-370.0), Some(-150.0), Some(-360.0)]),
            -370.0,
            &plain(&notes()),
        );
        assert_eq!(v.outcome, Outcome::Heard);
        assert_eq!(v.key_cents, Some(-370.0));
        assert_eq!((v.drift_cents, v.steady), (0.0, true));
        assert_eq!(
            v.marks.iter().map(|m| (m.kind, m.first, m.last)).collect::<Vec<_>>(),
            [(MarkKind::Note, 4, 4)]
        );
        assert_eq!(v.relative.len(), 10);
        assert_eq!(v.relative[3..6], [Some(0.0), Some(220.0), Some(10.0)]);
        assert!(v.relative[..3].iter().chain(&v.relative[6..]).all(Option::is_none));
        assert_eq!(v.in_tune, 2);
        // Within the run, as it was judged.
        let w = v.within(3..6);
        assert_eq!((w.marks[0].first, w.relative.len()), (1, 3));
    }

    #[test]
    fn a_run_sung_again_is_off_the_key_given_however_steadily_it_is_sung() {
        // A whole take sung a tone high is in its own key; a run sung again so is off the take's.
        assert!(judge(&notes(), &report(&[Some(200.0); 10])).marks.is_empty());
        let v = judge_again(&notes(), 5..10, &report(&[Some(200.0); 5]), 0.0, &plain(&notes()));
        assert_eq!(
            v.marks.iter().map(|m| (m.kind, m.first, m.last, m.cents)).collect::<Vec<_>>(),
            [(MarkKind::Verse, 5, 9, Some(200.0))]
        );
        assert_eq!(v.in_tune, 0);
    }

    #[test]
    fn sung_again_a_note_of_the_first_phrase_may_be_marked() {
        // The key is not found there, but given: sharp or flat.
        let v = judge_again(&notes(), 0..3, &report(&[Some(0.0), Some(300.0), Some(0.0)]), 0.0, &plain(&notes()));
        assert_eq!(v.marks.iter().map(|m| m.first).collect::<Vec<_>>(), [1]);
        let v = judge_again(
            &notes(),
            0..3,
            &report(&[Some(0.0), Some(0.0), Some(-200.0)]),
            0.0,
            &plain(&notes()),
        );
        assert_eq!(v.marks.iter().map(|m| (m.first, m.cents)).collect::<Vec<_>>(), [(2, Some(-200.0))]);
    }

    #[test]
    fn a_run_sung_again_does_not_drift_from_the_key_given() {
        // Rising steadily, each note is its own error from the key, none put down to a drift.
        let v = judge_again(
            &notes(),
            5..9,
            &report(&[Some(0.0), Some(30.0), Some(60.0), Some(90.0)]),
            0.0,
            &plain(&notes()),
        );
        assert_eq!((v.drift_cents, v.steady), (0.0, true));
        assert_eq!(v.relative[5..9], [Some(0.0), Some(30.0), Some(60.0), Some(90.0)]);
    }

    #[test]
    fn a_run_sung_again_in_no_key_is_not_heard_and_a_key_given_is_folded() {
        let r = report(&[Some(0.0), Some(0.0), Some(0.0)]);
        for key in [f32::NAN, f32::INFINITY] {
            let v = judge_again(&notes(), 3..6, &r, key, &plain(&notes()));
            assert_eq!((v.outcome, v.key_cents, v.relative.len()), (Outcome::NotHeard, None, 10));
        }
        // A key given past a tritone is folded, as the judge's own is.
        let v = judge_again(&notes(), 3..6, &report(&[Some(-500.0); 3]), 1900.0, &plain(&notes()));
        assert_eq!(v.key_cents, Some(-500.0));
        assert!(v.marks.is_empty());
        // A run that ends before it begins is empty, and not heard.
        let v = judge_again(&notes(), Range { start: 6, end: 3 }, &r, 0.0, &plain(&notes()));
        assert_eq!((v.outcome, v.relative.len()), (Outcome::NotHeard, 10));
    }

    fn kinds(v: &Verdict) -> Vec<(MarkKind, usize, usize)> {
        v.marks.iter().map(|m| (m.kind, m.first, m.last)).collect()
    }

    #[test]
    fn sung_again_a_verse_is_marked_as_a_take_s_is_and_part_of_one_only_where_the_take_marked_it() {
        let cents = |c: &[Option<f32>]| report(c);
        // The second verse held whole is marked as a take's is, whatever the take before.
        assert_eq!(
            kinds(&judge_again(&notes(), 5..10, &cents(&[Some(200.0); 5]), 0.0, &plain(&notes()))),
            [(MarkKind::Verse, 5, 9)]
        );
        // Part of it is marked as a verse under the take's mark on the verse, by the same rule;
        // a part of another verse, which the take did not mark, note by note.
        let mut sharp = vec![Some(0.0); 10];
        sharp[5..].fill(Some(200.0));
        let take = judge(&notes(), &report(&sharp));
        assert_eq!(kinds(&take), [(MarkKind::Verse, 5, 9)]);
        let v = judge_again(&notes(), 3..8, &cents(&[Some(200.0); 5]), 0.0, &take);
        assert_eq!(kinds(&v), [(MarkKind::Note, 3, 3), (MarkKind::Note, 4, 4), (MarkKind::Verse, 5, 7)]);
        // Where the take did not mark it, the part is judged note by note, as the take judged it.
        let v = judge_again(&notes(), 3..8, &cents(&[Some(200.0); 5]), 0.0, &plain(&notes()));
        assert_eq!(kinds(&v), (3..8).map(|i| (MarkKind::Note, i, i)).collect::<Vec<_>>());
        // Under the take's mark, a part too little off for a verse is judged note by note too.
        let v = judge_again(&notes(), 5..8, &cents(&[Some(200.0), Some(0.0), Some(0.0)]), 0.0, &take);
        assert_eq!(kinds(&v), [(MarkKind::Note, 5, 5)]);
        // Off enough for one, a note in tune or a little off, or not heard, is under the mark.
        for part in [
            [Some(200.0), Some(200.0), Some(200.0), Some(0.0)],
            [Some(200.0), Some(200.0), Some(90.0), Some(200.0)],
            [Some(200.0), None, Some(200.0), Some(200.0)],
        ] {
            let v = judge_again(&notes(), 5..9, &cents(&part), 0.0, &take);
            assert_eq!(kinds(&v), [(MarkKind::Verse, 5, 8)], "{part:?}");
        }
        // Silent throughout, the run is not heard: a whole verse sung again is not marked missing.
        let v = judge_again(&notes(), 5..10, &cents(&[None; 5]), 0.0, &take);
        assert_eq!(v.outcome, Outcome::NotHeard);
        // Its part of a verse the take marked, silent throughout beside a part heard, is; of one
        // the take did not mark, its notes are not heard.
        let silent = cents(&[Some(0.0), Some(0.0), Some(0.0), None, None, None]);
        assert_eq!(
            kinds(&judge_again(&notes(), 2..8, &silent, 0.0, &take)),
            [(MarkKind::VerseMissing, 5, 7)]
        );
        assert!(judge_again(&notes(), 2..8, &silent, 0.0, &plain(&notes())).marks.is_empty());
    }

    #[test]
    fn a_phrase_of_a_verse_the_take_marked_sung_off_again_is_marked_so_though_its_notes_are_too_short_to_mark_alone() {
        // The psalm's second verse sung a tone sharp, at every speed the page sings at, one of its
        // recited notes in tune or not: a verse mark in the take, though no recited note is long
        // enough to be marked alone.
        for (pulse, true_note) in [0.38, 0.5, 0.65].into_iter().flat_map(|p| [(p, None), (p, Some(17))]) {
            let notes = crate::notes_from_gabc(PSALM, pulse);
            let cents: Vec<Option<f32>> = (0..notes.len())
                .map(|i| Some(if i >= 14 && Some(i) != true_note { 200.0 } else { 0.0 }))
                .collect();
            let take = judge(&notes, &report(&cents));
            assert_eq!(kinds(&take), [(MarkKind::Verse, 14, 29)], "{pulse}");
            // Each phrase of it sung again the same is marked so over the same notes, and told so.
            for (run, n) in [(14..25, "eleven"), (25..30, "five")] {
                assert!(notes[run.clone()].iter().filter(|n| n.dur_s < MARK_MIN_S).count() >= 3);
                let key = key_at(&take, &report(&cents), run.clone()).unwrap();
                assert!(key.abs() < 1.0, "{key}");
                let v = judge_again(&notes, run.clone(), &report(&cents[run.clone()]), key, &take);
                assert_eq!(kinds(&v), [(MarkKind::Verse, run.start, run.end - 1)], "{pulse} {run:?}");
                assert_eq!(
                    crate::tell::again(&take, &cents, &v, run.clone()),
                    [
                        format!("None of its {n} notes were in tune, as before."),
                        "It is marked on the same notes as before.".to_string()
                    ]
                );
            }
        }
    }

    #[test]
    fn a_phrase_sung_off_in_a_verse_the_take_did_not_mark_is_marked_again_as_the_take_marked_it() {
        // A hymn's phrase, two of its three notes a tone sharp, or all three off by a tone or
        // less: the take marks those off enough one at a time, and so does the phrase sung again
        // the same.
        let hymn = crate::notes_from_gabc("(c4) Te(g) lu(h)cis(j) an(i)te(h) (,) ter(g)mi(h)num(g) (::)", 0.5);
        for off in [[200.0, 200.0, 0.0], [200.0, 120.0, 200.0]] {
            let mut cents = vec![Some(0.0); hymn.len()];
            for (k, c) in off.into_iter().enumerate() {
                cents[5 + k] = Some(c);
            }
            let take = judge(&hymn, &report(&cents));
            assert!(take.marks.iter().all(|m| m.kind == MarkKind::Note) && !take.marks.is_empty());
            let again = judge_again(&hymn, 5..8, &report(&cents[5..]), take.key_cents.unwrap(), &take);
            assert_eq!(kinds(&again), kinds(&take), "{off:?}");
            assert!(
                crate::tell::again(&take, &cents, &again, 5..8)
                    .iter()
                    .all(|s| s.contains("as before"))
            );
        }
        // The psalm's second phrase, all but its final or all of it sharp, and its second verse's
        // second half all sharp, at every speed: too little of the verse for the take to mark it
        // as one, so only notes long enough to be marked alone, or none, are.
        for pulse in [0.38, 0.5, 0.65] {
            let notes = crate::notes_from_gabc(PSALM, pulse);
            for (run, off) in [(8..14, 8..12), (8..14, 8..14), (25..30, 25..30)] {
                let cents: Vec<Option<f32>> = (0..notes.len()).map(|i| Some(if off.contains(&i) { 200.0 } else { 0.0 })).collect();
                let take = judge(&notes, &report(&cents));
                assert!(take.marks.iter().all(|m| m.kind == MarkKind::Note), "{pulse} {off:?}");
                let key = key_at(&take, &report(&cents), run.clone()).unwrap();
                let again = judge_again(&notes, run.clone(), &report(&cents[run.clone()]), key, &take);
                let taken: Vec<_> = kinds(&take).into_iter().filter(|m| run.contains(&m.1)).collect();
                assert_eq!(kinds(&again), taken, "{pulse} {off:?}");
                let told = crate::tell::again(&take, &cents, &again, run.clone());
                assert!(told.iter().all(|s| s.contains("as before")), "{pulse} {off:?} {told:?}");
            }
        }
    }

    #[test]
    fn a_take_that_sank_sung_again_the_same_is_told_as_before() {
        // Sinking 50 cents a second: the take is in tune along its drift, but the run sung again
        // the same, in the key the take had sunk to at its middle, sinks off it at either end.
        let cents: Vec<Option<f32>> = (0..10).map(|i| Some(-30.0 * i as f32)).collect();
        let take = judge(&notes(), &report(&cents));
        assert!(!take.steady && take.in_tune == 10, "{take:?}");
        let key = key_at(&take, &report(&cents), 5..10).unwrap();
        let again = judge_again(&notes(), 5..10, &report(&cents[5..]), key, &take);
        assert_eq!(again.in_tune, 3);
        // The take's notes are read in that key too, so the same singing is in tune the same.
        assert_eq!(
            crate::tell::again(&take, &cents, &again, 5..10),
            ["Three of its five notes were in tune, as before."]
        );
    }

    #[test]
    fn a_take_in_a_key_near_a_tritone_from_the_score_sung_again_the_same_is_told_as_before() {
        // About a tritone above the score, its notes either side of it: in tune in the take, and
        // read so again beside the run, the take's errors folded as the judge folds them.
        let cents: Vec<Option<f32>> = (0..10).map(|i| Some(if i % 2 == 0 { 590.0 } else { -590.0 })).collect();
        let take = judge(&notes(), &report(&cents));
        assert!(take.marks.is_empty() && take.in_tune == 10, "{take:?}");
        let key = key_at(&take, &report(&cents), 5..9).unwrap();
        let again = judge_again(&notes(), 5..9, &report(&cents[5..9]), key, &take);
        assert_eq!(again.in_tune, 4);
        assert_eq!(
            crate::tell::again(&take, &cents, &again, 5..9),
            ["All four of its notes were in tune, as before."]
        );
    }

    #[test]
    fn a_verse_sung_off_again_where_the_take_was_in_tune_is_told_it_has_one_mark() {
        let again = judge_again(&notes(), 5..10, &report(&[Some(200.0); 5]), 0.0, &plain(&notes()));
        assert_eq!(kinds(&again), [(MarkKind::Verse, 5, 9)]);
        assert_eq!(
            crate::tell::again(&plain(&notes()), &[Some(0.0); 10], &again, 5..10),
            [
                "None of its five notes were in tune this time, where all were before.",
                "It has one mark."
            ]
        );
    }

    #[test]
    fn a_long_run_counts_its_notes_in_figures_and_its_marks_in_words() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        let take = judge(&notes, &report(&vec![Some(0.0); notes.len()]));
        let mut cents = vec![Some(0.0); notes.len()];
        cents[13] = Some(200.0);
        cents[24] = Some(200.0);
        let again = judge_again(&notes, 0..notes.len(), &report(&cents), 0.0, &take);
        assert_eq!(again.marks.len(), 2);
        assert_eq!(
            crate::tell::again(&take, &vec![Some(0.0); notes.len()], &again, 0..notes.len()),
            [
                "Of its 30 notes, 28 were in tune this time, where all were before.",
                "It has two marks."
            ]
        );
    }

    #[test]
    fn sung_again_a_note_whose_frames_do_not_agree_is_not_marked() {
        let mut r = report(&[Some(0.0), Some(200.0), Some(0.0)]);
        r.notes[1].spread_cents = Some(MARK_MAX_SPREAD);
        assert!(judge_again(&notes(), 3..6, &r, 0.0, &plain(&notes())).marks.is_empty());
        let mut r = report(&[Some(0.0), Some(200.0), Some(0.0)]);
        r.notes[1].voiced_frames = MARK_MIN_FRAMES - 1;
        assert!(judge_again(&notes(), 3..6, &r, 0.0, &plain(&notes())).marks.is_empty());
        // Agreed, it is.
        assert_eq!(
            kinds(&judge_again(
                &notes(),
                3..6,
                &report(&[Some(0.0), Some(200.0), Some(0.0)]),
                0.0,
                &plain(&notes())
            )),
            [(MarkKind::Note, 4, 4)]
        );
    }

    #[test]
    fn a_run_is_sung_again_in_the_key_the_take_had_drifted_to_there() {
        // Key 100, the line 50 above it over notes 2..5, and each note off the line by its own.
        let mut v = judge(&notes(), &report(&[Some(100.0); 10]));
        v.key_cents = Some(100.0);
        v.relative = vec![Some(0.0), Some(0.0), Some(10.0), None, Some(-30.0), Some(5.0)];
        let r = report(&[Some(100.0), Some(100.0), Some(160.0), Some(900.0), Some(120.0), Some(155.0)]);
        assert_eq!(key_at(&v, &r, 0..2), Some(100.0));
        // A note the judge read no error of is left out, as are the notes past the run.
        assert_eq!(key_at(&v, &r, 2..5), Some(150.0));
        // Nothing read there leaves the key where it started.
        assert_eq!(key_at(&v, &r, 6..9), Some(100.0));
        // The line where it lay at the run's notes in the middle: at three, the middle one; at
        // two, between them.
        v.relative = vec![None, None, Some(0.0), Some(0.0), Some(0.0)];
        let r = report(&[None, None, Some(140.0), Some(170.0), Some(150.0)]);
        assert_eq!(key_at(&v, &r, 2..5), Some(150.0));
        assert_eq!(key_at(&v, &r, 2..4), Some(155.0));
        // Drifted past a tritone, the key folds as the judge's does.
        v.key_cents = Some(550.0);
        v.relative = vec![Some(0.0)];
        assert_eq!(key_at(&v, &report(&[Some(-500.0)]), 0..1), Some(-500.0));
        // A take with no key gives none.
        v.key_cents = None;
        assert_eq!(key_at(&v, &r, 0..2), None);
    }

    #[test]
    fn a_run_sung_again_keeps_the_whole_chants_cadences_inside_it() {
        let notes = crate::notes_from_gabc(PSALM, 0.5);
        let whole = judge(&notes, &report(&vec![Some(0.0); notes.len()]));
        let again = judge_again(&notes, 14..notes.len(), &report(&vec![Some(0.0); notes.len() - 14]), 0.0, &whole);
        let spans = |v: &Verdict| v.cadences.iter().map(|c| (c.first, c.last, c.note)).collect::<Vec<_>>();
        assert!(!again.cadences.is_empty());
        assert_eq!(spans(&again), spans(&whole).into_iter().filter(|c| c.0 >= 14).collect::<Vec<_>>());
        // A run that does not match its report is not heard, and its notes are the chant's.
        let unheard = judge_again(&notes, 14..20, &report(&[Some(0.0); 3]), 0.0, &whole);
        assert_eq!((unheard.outcome, unheard.relative.len()), (Outcome::NotHeard, notes.len()));
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
        // A half-verse with no recitation is cadence from its first note off the tone, however
        // many notes its final's neume adds.
        let notes = crate::notes_from_gabc(
            "(c4) Glo(h)ry(h) be(h) to(h) the(h) Fa(h)ther(g) (:) and(h) cléanse(i) me(h) fróm(g) my(g) sin.(gfedf) (::)",
            0.5,
        );
        assert_eq!(cadences(&notes)[1], (8, 16));
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
        // Each names its note furthest off, the first of two as far.
        assert_eq!(v.cadences[0].note, Some(6));
        // A note clearly heard off puts its cadence off, whatever trailed away after it.
        let mut trailing = cents.clone();
        trailing[12] = Some(200.0);
        trailing[13] = None;
        let off = judge(&notes, &report(&trailing)).cadences[1];
        assert_eq!((off.on_pitch(), off.note), (Some(false), Some(12)));
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
