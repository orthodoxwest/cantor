//! `cantor eval`: the listening gates. Every suite in `evals/suites/` is synthesized,
//! listened to, scored and judged, and checked two ways: against its gate (what the take
//! must and must not be told) and against `evals/baseline.json`, or with `--nsdf-only`
//! `evals/baseline-nsdf.json` (no metric may get worse
//! past its tolerance, and the faults and takes counted must not change). Real takes from a
//! directory given with `--takes` are held to the expert gate; they have no guide and no
//! planted truth, so their tracking error is measured from the judge's own key. A note a real
//! take is known to sing off the score is named in its file (`off`), as a fault planted, so
//! that a mark on it sung again is deserved. The scorecard
//! is printed and written to `out/eval.json` and `out/eval.md` (`eval-nsdf.*` with
//! `--nsdf-only`), and every take is drawn in `out/explain/` (`explain-nsdf/`). With
//! `--oracle MODEL`, CREPE labels every take too (see `oracle.rs`), and a second, ungated
//! table counts the notes where it and the scorer disagree.
//!
//! What counts as a fault, and how long a note must be to count, are this file's own
//! constants, written from the specification, not read from the judge: tuning the judge
//! cannot shrink what it is tested against. Cadences are the exception: where a cadence lies
//! is the judge's, so how many there are, and how many were planted off, are held to the
//! baseline.
//!
//! The gates. Every suite, gated or not, must have no false marks, and be told the same when
//! timed as the page times it (below).
//! - `expert`: a good take is told nothing wrong. No marks; at least 95% of the notes of
//!   0.3 s or more heard over the suite and 90% in every take (all but one in a take stopped
//!   short with fewer than ten, as one stopped in its second phrase, judged on its first, can
//!   be, its misses also missed sung whole: see the gates of stopping); 90% of all notes heard; a
//!   steady reciting tone; no cadence called off pitch, and 80% of them judged; every take
//!   judged.
//! - `student`: planted faults a teacher hears across the room are marked: at least 95% of
//!   them caught, nothing planted 100 cents or more off called in tune, the key found within
//!   50 cents, and drift named where it was planted. No cadence told wrong (called off with
//!   every note planted within 50 cents, or on with one planted 150 off), and 80% judged.
//! - `silent`: the guide alone, singer silent. No take judged, no note heard, nothing in tune.
//! - `wrong`: a wrong singer over a right guide is marked, as for `student`.
//!
//! Every take is also timed as the page times it ([`mod@cantor_core::entry`]), its first
//! note due where it was sung (a real take's is where it was aligned), and must be told the
//! same there: the same outcome, steadiness and marks (their kinds and notes), and the same
//! cadences called off pitch (one called on pitch one way and not clearly heard the other is
//! not counted). A take sung as on the page, after a lead of [`PAGE_LEAD_S`] or more with no
//! guide in it (every real take, and the `-lead` suites), is timed again as for a singer
//! each of [`LATE_S`] behind the cursor, its note due that much earlier: it must be told the
//! same, and under the expert, student and wrong gates be timed by the same first sound as on
//! time, within [`SAME_SOUND_S`]. Not
//! covered: a singer late behind a guide heard in the take. A synthetic guide sings with the
//! singer, and its cue ends just before the first note, where the page listens only after the
//! cue; on the page the guide's bleed can be the first sound heard. Nor a singer who leads
//! the cursor: the page then times the take as due, as the singer holds the first note until
//! the cursor moves, which a recording sung at its own pace does not.
//!
//! A take may be stopped short: its spec's `through` names the last note sung whole, and the
//! take ends halfway through the next. It is judged as the page judges it: `through` read
//! from the take's length as `sing.ts` reads it, then only the phrases finished there, by the
//! ear's own [`cantor_ear::judge_gabc`]. It is held to its suite's gate over the notes judged
//! (a take with none is left out of those numbers), and under every gate to the gates of
//! stopping: the notes judged, and the bands the page draws, end exactly where the last
//! phrase finished at `through` ends, as read here from the chant's phrases; no mark or
//! cadence ends past them; a take stopped before a phrase finished is judged to nothing and
//! told nothing (no key, mark, cadence, band or words: the page says there is nothing to judge
//! yet, not that the singer was not heard); and no fault planted past the notes judged (sung in
//! the phrase cut short, or never sung) is caught. When it is timed again as the page times it,
//! it is judged each time through the note the page would read from its length on that timing.
//! It is held to the take sung whole too: judged alike on the notes judged, its key near the
//! whole take's, and no note of 0.3 s or more heard sung whole lost stopped. Real takes are
//! stopped too (`real-takes-stopped`), halfway through the middle note of their first, second,
//! middle and last phrases, and held to the expert gate and the same gates of stopping; their
//! `through` is read from the singer's own note times, not the page's pulses, as a real take
//! sung whole is timed, and they are judged by [`cantor_ear::judge_notes`]. Their first phrases are recited, so only `expert-stopped`'s first take
//! holds a take stopped to the whole chant's phrase endings where the notes judged alone would
//! be read as not recited.
//!
//! Every take stopped is compared with the take sung whole, judged on all of the chant: on the
//! notes judged it must be judged alike, with the same outcome and marks there (a mark running
//! past them compared as far as they go), the cadences of the phrases finished placed and
//! called alike (as when a take is retimed), the key within [`KEY_TOLERANCE`], and no note of
//! 0.3 s or more, not planted silent, that the take sung whole heard lost (`lost`). Every suite
//! with takes stopped is gated on it. The judge reads whether a chant is recited, and so where
//! its cadences lie, from the whole chant ([`cantor_core::judge_part`]), and the ear's
//! [`cantor_ear::judge_notes`] tells its summary, and whether it speaks of a reciting tone,
//! from the whole chant too: the psalm's first verse alone, with four of its fourteen notes
//! recited, would not be, and stopped there (`expert-stopped` 0) its second cadence would be
//! "na-tions", not the tone's termination "all ye na-tions".
//!
//! A run of a take may be sung again (`cantor_ear::judge_again_notes`): the singer chooses a
//! phrase and sings it alone, judged in the take's key. Every take heard whole is sung again
//! so in its first, second, middle and last phrases, and in the whole verse its middle phrase
//! is of, each heard from the take's own frames over the run and half a second either side, in
//! the key the take was in there (its key moved along its drift line), and compared with the
//! take: no mark it does not deserve; no run the take heard enough of to judge left unheard;
//! and, where the two are judged alike, the same note marks past the first phrase (save under a
//! verse's mark, as the run's part of a verse all off together is judged as a verse), verse
//! marks on a verse the run holds whole, and its cadences placed and called alike. A fault
//! planted in a run that the take caught must be caught sung again too wherever the run's frames
//! agree on the note, as a mark on a note alone needs; and the run's part of a verse the take
//! marked off together must be marked so again wherever it was planted so and three of its notes
//! were heard, however short they are, as a psalm phrase's recited notes are. Sung as before, a
//! run past the first phrase must be told so: which of its notes were in tune as beside itself,
//! and no mark gone. `student-notes` sings a last phrase two-thirds sharp, ending in tune, which
//! the take marks a note at a time and the run must too. A run sung again does not drift, so a
//! whole verse of a take that sank lies from the take's errors along its line by what it sank
//! there; its words read the take's notes in the run's key, so it is told it was in tune as
//! before. Sung again in a key given, a
//! first phrase may be marked where a take never is: under the student and wrong gates the
//! faults planted there are caught as a take's are, so `student-notes` and
//! `control-wrong-singer` plant one there, flat and sharp. Every suite is gated on it; how
//! many faults the runs hold is fixed, and how far a note's error sung again lies from its error
//! in the take is held, by the baseline, and a table counts what each suite's runs sung again
//! were judged. Not covered: a run heard in a take of its own, with its own loudness floor and
//! the guide's cue before it.
//!
//! The app's guide plays in the singer's key. The `guide-key` suites play it in another: at
//! -12 dB or quieter an expert is told nothing wrong by either ear; louder, both ears still
//! mark nothing, but the NSDF tracker alone loses notes, and by -6 dB whole takes go
//! unjudged. At -3 dB the guide's pitch can be read as a
//! note and marked, so no suite plays it that loud: masking frames at the guide's pitch would
//! stop it, but would mask a singer in unison with a loud guide too, which is the app's case.

use std::collections::BTreeMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use cantor_core::score::fold;
use cantor_core::synth::{GuideMode, cue_span};
use cantor_core::{
    Cadence, Entry, Frame, Guide, Mark, MarkKind, Note, Outcome, Planted, Profile, Take, Verdict, judge, judge_part, key_at,
    notes_from_gabc, render_take, score,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::SAMPLE_RATE;
use crate::ear::Ear;
use crate::explain;
use crate::oracle::Oracle;

/// A fault a mark must catch: a note this many cents off...
const FLAGRANT_CENTS: f32 = 150.0;
/// ...lasting at least this long, past the chant's first phrase (where the key settles).
const FLAGRANT_MIN_S: f32 = 0.4;
/// Notes at least this long count towards the heard fraction.
const COUNTED_MIN_S: f32 = 0.3;
/// A take is told a fault it doesn't have when a mark lands on a note planted less than
/// this far off.
const CLEAR_CENTS: f32 = 100.0;
/// A verse mark is deserved when this share of its notes were planted off its way.
const VERSE_DESERVED: f32 = 0.8;
/// A note heard in tune that was planted this far off is a false "in tune".
const OFF_CENTS: f32 = 100.0;
/// A cadence called off pitch is wrong when every note of it was planted within this; one
/// with a note planted at least [`FLAGRANT_CENTS`] off must be called off.
const CADENCE_CLEAR_CENTS: f32 = 50.0;
/// The share of cadences the judge must rule on. One it does not rule on is not told either
/// way (the page counts only those clearly heard), so it is not a cadence told wrong, but a
/// judge that stopped ruling would tell nothing.
const CADENCE_JUDGED_FLOOR: f32 = 0.8;
/// A planted drift at least this large must be named, and one at most `STEADY_DRIFT` must not.
const UNSTEADY_DRIFT: f32 = 90.0;
const STEADY_DRIFT: f32 = 40.0;
/// A heard note further than this from the truth is a tracking gross error.
const GROSS_CENTS: f32 = 50.0;
/// The floors the gates hold.
const HEARD_FLOOR: f32 = 0.95;
const TAKE_HEARD_FLOOR: f32 = 0.9;

/// How many of a take's `counted` notes (0.3 s or more) must be heard: [`TAKE_HEARD_FLOOR`] of
/// them, or, of a take `stopped` short, all but one of fewer than ten, as the one phrase judged
/// of a take stopped in its second can be: a note the tracker misses sung whole too is a sixth of
/// a first half-verse of six. No note the take sung whole heard may be lost stopped
/// ([`StopMetrics::lost`]).
fn take_floor(counted: usize, stopped: bool) -> usize {
    let floor = (TAKE_HEARD_FLOOR * counted as f32).ceil() as usize;
    if stopped { floor.min(counted.saturating_sub(1)) } else { floor }
}
const ALL_HEARD_FLOOR: f32 = 0.9;
const RECALL_FLOOR: f32 = 0.95;
const KEY_TOLERANCE: f32 = 50.0;
const SILENT_CEILING: f32 = 0.01;
/// Two trackers agree on a frame within this many cents, octaves aside.
const AGREEMENT_CENTS: f32 = 50.0;
/// The name real takes are reported under, and the name they are reported under stopped short.
const REAL: &str = "real-takes";
const REAL_STOPPED: &str = "real-takes-stopped";

/// Whether a suite is of real takes, which have no baseline: the set and its audio live
/// elsewhere.
fn is_real(name: &str) -> bool {
    name == REAL || name == REAL_STOPPED
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Gate {
    /// Measured and held to the baseline, with no gate of its own but no false marks.
    #[default]
    None,
    Expert,
    Student,
    Silent,
    Wrong,
}

impl Gate {
    fn name(self) -> &'static str {
        match self {
            Gate::None => "none",
            Gate::Expert => "expert",
            Gate::Student => "student",
            Gate::Silent => "silent",
            Gate::Wrong => "wrong",
        }
    }
}

/// One synthetic take: the chant, its tempo, the seed, the lead-in and the profile.
#[derive(Debug, Deserialize)]
struct TakeSpec {
    /// The GABC file, relative to the repository root.
    gabc: String,
    pulse_s: f32,
    seed: u64,
    /// Seconds before the first note, when only the guide's cue sounds.
    #[serde(default)]
    lead_in_s: f32,
    /// The last note sung whole when the singer stopped the take short, if they did: the take
    /// ends halfway through the next note.
    #[serde(default)]
    through: Option<usize>,
    #[serde(flatten)]
    profile: Profile,
}

/// A suite file: a name, a gate, defaults, and the takes, each overriding the defaults.
struct Suite {
    name: String,
    gate: Gate,
    takes: Vec<TakeSpec>,
}

/// A real take: a recording of a chant with the time each note was sung. Paths are relative
/// to the file.
#[derive(Debug, Deserialize)]
struct RealTake {
    name: String,
    gabc: String,
    audio: String,
    /// `[start, end]` in seconds for each note of the chant, in order.
    notes: Vec<[f32; 2]>,
    /// Notes the singer is known to have sung off the score (the takes' README says why), as a
    /// synthetic take's faults are planted, so that a mark on one sung again is deserved. The take
    /// sung whole is still held to the expert gate, no mark at all, so a note named here is one a
    /// take is not marked on: in its first phrase, where the key is read.
    #[serde(default)]
    off: Vec<Off>,
}

/// A note of a real take sung off the score, by about `cents`.
#[derive(Debug, Deserialize)]
struct Off {
    note: usize,
    cents: f32,
}

/// One judged take, with what it is checked against.
struct Judged {
    name: String,
    notes: Vec<Note>,
    planted: Vec<Planted>,
    /// The truth for each note in cents from the score, when known (synthetic takes).
    truth: Vec<Option<f32>>,
    /// The key the singer started in, when known.
    true_key: Option<f32>,
    planted_drift: f32,
    frames: Vec<Frame>,
    verdict: Verdict,
    report: cantor_core::Report,
    /// The scorer's report on the oracle's labels and the judge's verdict on it, when the
    /// oracle listened.
    oracle: Option<OracleTake>,
    timing: Timing,
    /// When the take was stopped short: where, and what it was judged on and told.
    stop: Option<Stop>,
}

/// A take stopped short: where the page reads it stopped, what it was judged on and told
/// there, and the take sung whole.
#[derive(Serialize)]
struct Stop {
    /// The last note sung whole, as the page reads it from the take's length; none when the
    /// first note was not.
    through: Option<usize>,
    /// Where the notes judged must end: after the last phrase finished at `through`, as
    /// [`phrase_end`] reads the chant.
    finished: usize,
    /// The bands the page draws (it says the take was judged through the last of them), and
    /// the sentences it shows: the marks' words and the summary.
    ribbon: usize,
    words: usize,
    /// Faults planted on notes past `finished` (see [`faults`]), sung in the phrase cut short
    /// or never sung, and of them those a mark caught.
    cut_faults: u32,
    cut_caught: u32,
    /// The take sung whole, judged on all of the chant.
    whole: Verdict,
}

impl Stop {
    /// `shown`, the take of `chant` (planted with `planted`) stopped after note `through`, as
    /// the page was given it, beside `whole`.
    fn of(chant: &[Note], planted: &[Planted], through: Option<usize>, shown: &cantor_ear::Judged, whole: Verdict) -> Stop {
        let finished = through.map_or(0, |t| phrase_end(chant, t));
        let (mut cut_faults, mut cut_caught) = (0, 0);
        for i in faults(chant, planted).filter(|&i| i >= finished) {
            cut_faults += 1;
            cut_caught += u32::from(shown.verdict.marks.iter().any(|m| catches(m, i, &planted[i])));
        }
        Stop {
            through,
            finished,
            ribbon: shown.ribbon.len(),
            words: shown.told.len() + shown.summary.len(),
            cut_faults,
            cut_caught,
            whole,
        }
    }
}

/// The last note sung whole in a take `heard_s` seconds long, as the page reads it when the
/// take is stopped (`sing.ts`): the last of the notes, in order, ended by then; none when the
/// first had not ended.
fn through_heard(notes: &[Note], heard_s: f32) -> Option<usize> {
    notes.iter().take_while(|n| n.end_s() <= heard_s).count().checked_sub(1)
}

/// Where a take stopped with note `through` the last sung whole must be judged to: just after
/// the last note up to `through` that ends its phrase (as the chant's last note does), or at
/// the start when none does. Read from the chant's phrases, not from the ear.
fn phrase_end(notes: &[Note], through: usize) -> usize {
    if notes.is_empty() {
        return 0;
    }
    (0..=through.min(notes.len() - 1))
        .rev()
        .find(|&i| notes.get(i + 1).is_none_or(|next| next.phrase != notes[i].phrase))
        .map_or(0, |i| i + 1)
}

/// Whether a take stopped short was judged otherwise than when sung whole, on the `judged`
/// notes it was judged on: another outcome, other marks there (one of the whole take's running
/// past them is compared as far as they go), or the cadences of the phrases finished placed or
/// called otherwise (see [`contradicts`]). Their keys are held apart to [`KEY_TOLERANCE`].
fn judged_otherwise(stopped: &Verdict, whole: &Verdict, judged: usize) -> bool {
    let marks = |v: &Verdict| -> Vec<(MarkKind, usize, usize)> {
        v.marks
            .iter()
            .filter(|m| m.first < judged)
            .map(|m| (m.kind, m.first, m.last.min(judged.saturating_sub(1))))
            .collect()
    };
    let finished: Vec<Cadence> = whole.cadences.iter().filter(|c| c.last < judged).copied().collect();
    stopped.outcome != whole.outcome || marks(stopped) != marks(whole) || contradicts(&stopped.cadences, &finished)
}

/// Whether two verdicts' cadences are told otherwise: placed otherwise, or one called off
/// pitch where the other is not. One on pitch one way and not clearly heard the other is not
/// told otherwise, only not counted.
fn contradicts(a: &[Cadence], b: &[Cadence]) -> bool {
    a.len() != b.len()
        || a.iter()
            .zip(b)
            .any(|(x, y)| (x.first, x.last) != (y.first, y.last) || (x.on_pitch() == Some(false)) != (y.on_pitch() == Some(false)))
}

/// How far behind the cursor a singer is taken to be, in seconds, each time a take is timed as
/// the page times it for a late singer: its first note falls due that long before it was sung.
const LATE_S: [f32; 2] = [0.3, 0.8];
/// A late singer's take must be timed by a first sound this close to the one it is timed by
/// on time, in seconds.
const SAME_SOUND_S: f32 = 0.05;
/// The page listens at least this long before the first note is due (sing.ts's `LEAD`, less
/// a margin); a take with a shorter lead is not timed as for a late singer.
const PAGE_LEAD_S: f32 = 1.0;

/// A take timed as the page times it, its first note due where it was sung (`on_time`) and,
/// when it was sung as on the page, each of [`LATE_S`] before (`late`).
#[derive(Clone, Debug, Serialize)]
struct Timing {
    on_time: Retimed,
    late: Vec<Retimed>,
}

impl Timing {
    /// Whether the take was timed as for a late singer, and each time by the first sound it
    /// was timed by on time.
    fn by_sound(&self) -> bool {
        let same = |r: &Retimed| match (r.entry.sound, self.on_time.entry.sound) {
            (Some(a), Some(b)) => (a - b).abs() <= SAME_SOUND_S,
            _ => false,
        };
        !self.late.is_empty() && self.late.iter().all(same)
    }

    /// Whether the take was told the same each way it was timed.
    fn kept(&self) -> bool {
        self.on_time.kept && self.late.iter().all(|r| r.kept)
    }
}

/// Where the notes were put, and whether the judge told the take the same there.
#[derive(Clone, Copy, Debug, Serialize)]
struct Retimed {
    entry: Entry,
    kept: bool,
}

impl Timing {
    /// `notes`: the chant's, as timed in the take. `stopped`: the take was stopped short, so
    /// each way it is timed it is judged as the page judges it then, through the note it reads
    /// as the last sung whole from the take's length on that timing (see [`through_heard`]),
    /// to the end of the last phrase finished there. `guided`: the guide is heard in the take.
    fn of(notes: &[Note], stopped: bool, samples: &[f32], rate: f32, frames: &[Frame], verdict: &Verdict, guided: bool) -> Timing {
        let start = notes.first().map_or(0.0, |n| n.start_s);
        let heard_s = samples.len() as f32 / rate;
        let live = cantor_core::live(samples, rate);
        let loud = cantor_ear::onset(samples, rate);
        let told = |v: &Verdict| {
            let marks: Vec<_> = v.marks.iter().map(|m| (m.kind, m.first, m.last)).collect();
            (v.outcome, v.steady, marks, v.relative.len())
        };
        let retime = |due: f32| {
            let entry = cantor_core::entry(&live, loud, due);
            let moved: Vec<Note> = notes
                .iter()
                .map(|n| Note {
                    start_s: n.start_s + entry.at - start,
                    ..*n
                })
                .collect();
            // Judged by the page's own ear, through the note it would read from the take's length.
            let through = if stopped { through_heard(&moved, heard_s) } else { None };
            let again = if stopped && through.is_none() {
                judge_part(&moved, 0, &score(&[], frames))
            } else {
                cantor_ear::judge_notes(moved, frames, through).verdict
            };
            Retimed {
                entry,
                kept: told(&again) == told(verdict) && !contradicts(&again.cadences, &verdict.cadences),
            }
        };
        let late = if !guided && start >= PAGE_LEAD_S {
            LATE_S.iter().map(|late| retime(start - late)).collect()
        } else {
            Vec::new()
        };
        Timing {
            on_time: retime(start),
            late,
        }
    }
}

#[derive(Serialize)]
struct OracleTake {
    report: cantor_core::Report,
    verdict: Verdict,
}

impl OracleTake {
    fn of(notes: &[Note], frames: &[Frame]) -> OracleTake {
        let report = score(notes, frames);
        let verdict = judge(notes, &report);
        OracleTake { report, verdict }
    }
}

/// Whether a verdict's steadiness disagrees with the drift planted.
fn summary_wrong(v: &Verdict, planted_drift: f32) -> bool {
    (planted_drift.abs() >= UNSTEADY_DRIFT && v.steady) || (planted_drift.abs() <= STEADY_DRIFT && !v.steady)
}

/// What was planted on a cadence: whether a note of it that counts was planted at least
/// [`FLAGRANT_CENTS`] off (it must be called off), or every one within
/// [`CADENCE_CLEAR_CENTS`] (it must not be). The spans are the judge's; what is planted on
/// them is the suite's.
fn cadence_planted(c: &Cadence, notes: &[Note], planted: &[Planted]) -> (bool, bool) {
    let counted: Vec<f32> = (c.first..=c.last)
        .filter(|&i| !planted[i].silent && notes[i].dur_s >= COUNTED_MIN_S)
        .map(|i| fold(planted[i].cents).abs())
        .collect();
    (
        counted.iter().any(|&p| p >= FLAGRANT_CENTS),
        !counted.is_empty() && counted.iter().all(|&p| p < CADENCE_CLEAR_CENTS),
    )
}

/// How the oracle's per-note pitch compares with the scorer's. It is never gated: it says
/// where to look.
#[derive(Clone, Copy, Debug, Serialize)]
struct OracleStats {
    /// Of the notes sung, the fraction the oracle heard.
    heard: f32,
    /// Notes both heard.
    compared: u32,
    /// Of those, notes whose pitches are more than [`GROSS_CENTS`] apart, octaves aside.
    disagreements: u32,
    /// The oracle's mean distance from the truth over the notes it heard, where the truth
    /// is known (synthetic takes).
    tracking_cents: Option<f32>,
    /// The judge's steadiness and key on the oracle's labels, counted as for the scorer's;
    /// the key only where the truth is known.
    summary_errors: u32,
    key_error_cents: Option<f32>,
}

impl OracleStats {
    fn of(takes: &[Judged]) -> Option<OracleStats> {
        let (mut sung, mut heard, mut compared, mut disagreements) = (0u32, 0u32, 0u32, 0u32);
        let (mut errors, mut tracked) = (0.0f32, 0u32);
        let (mut summary_errors, mut key_error_cents) = (0u32, None::<f32>);
        for take in takes {
            let oracle = take.oracle.as_ref()?;
            let v = &oracle.verdict;
            if v.outcome == Outcome::Heard {
                summary_errors += u32::from(summary_wrong(v, take.planted_drift));
                if let (Some(k), Some(t)) = (v.key_cents, take.true_key) {
                    key_error_cents = Some(key_error_cents.unwrap_or(0.0).max(fold(k - t).abs()));
                }
            }
            for (i, (o, r)) in oracle.report.notes.iter().zip(&take.report.notes).enumerate() {
                if take.planted[i].silent {
                    continue;
                }
                sung += 1;
                let Some(oc) = o.cents else { continue };
                heard += 1;
                if let Some(rc) = r.cents {
                    compared += 1;
                    disagreements += u32::from(fold(oc - rc).abs() > GROSS_CENTS);
                }
                if let Some(t) = take.truth[i] {
                    errors += fold(oc - t).abs();
                    tracked += 1;
                }
            }
        }
        Some(OracleStats {
            heard: if sung == 0 { 0.0 } else { heard as f32 / sung as f32 },
            compared,
            disagreements,
            tracking_cents: (tracked > 0).then(|| errors / tracked as f32),
            summary_errors,
            key_error_cents,
        })
    }
}

/// The numbers a suite is judged by.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Metrics {
    takes: u32,
    /// Of the notes of 0.3 s or more that were sung, the fraction heard.
    heard_fraction: f32,
    /// The lowest heard fraction of any one take.
    worst_take_heard: f32,
    /// Takes with fewer of their notes of 0.3 s or more heard than [`take_floor`].
    takes_under_floor: u32,
    /// Of all the notes sung, the fraction heard.
    heard_all: f32,
    /// Of the notes of 0.3 s or more, the fraction masked by the guide's bleed.
    masked_fraction: f32,
    /// The mean distance of heard notes from the truth, in cents.
    tracking_cents: f32,
    /// The fraction of heard notes further than 50 cents from the truth.
    gross_error_rate: f32,
    marks: u32,
    /// Marks on notes that were not planted off, or not off that way.
    false_marks: u32,
    /// Planted faults a mark must catch.
    faults: u32,
    /// The fraction of `faults` caught (1 when none were planted).
    recall: f32,
    /// Notes called in tune that were planted at least 100 cents off.
    false_in_tune: u32,
    /// The largest distance of a judged take's key from the truth, in cents.
    key_error_cents: f32,
    /// Takes whose steadiness disagrees with the drift planted.
    summary_errors: u32,
    /// Cadences, and those the judge ruled on.
    cadences: u32,
    cadences_judged: u32,
    /// Cadences called off pitch that were planted on it, or on pitch that were planted off.
    cadence_errors: u32,
    /// Cadences with a note planted flagrantly off, and the fraction of them called off (1
    /// when there were none); the rest were not judged, as one called on is a cadence error.
    cadence_faults: u32,
    cadence_recall: f32,
    /// Takes given an outcome instead of a judgement.
    unjudged: u32,
    /// Takes timed as for a singer [`LATE_S`] behind the cursor; those of them timed each way
    /// by the same first sound as on time; and takes told otherwise when timed as the page
    /// times them, any way.
    timed_late: u32,
    timed_by_sound: u32,
    timing_moved_marks: u32,
    /// Notes heard in tune, over all takes.
    in_tune: u32,
    /// Of the frames the NSDF tracker found clear and SwiftF0 also voiced, the fraction
    /// within [`AGREEMENT_CENTS`] of each other, octaves aside; none when SwiftF0 did not listen.
    agreement: Option<f32>,
    /// What the takes stopped short are judged by; none when no take was.
    #[serde(skip_serializing_if = "Option::is_none")]
    stopped: Option<StopMetrics>,
    /// What runs of the takes sung again are judged by; none when no take was heard whole.
    #[serde(skip_serializing_if = "Option::is_none")]
    again: Option<AgainMetrics>,
}

/// How long before a run's first note and after its last the run sung again is heard, in
/// seconds.
const AGAIN_PAD_S: f32 = 0.5;

/// The runs of a take sung again: its first, second, middle and last phrases, and the whole
/// verse its middle phrase is of (each once), as the notes each spans.
fn again_runs(notes: &[Note]) -> Vec<Range<usize>> {
    let Some(last) = notes.last() else { return Vec::new() };
    let phrases = last.phrase as usize + 1;
    let span = |of: &dyn Fn(&Note) -> bool| {
        let first = notes.iter().position(of)?;
        let last = notes.iter().rposition(of)?;
        Some(first..last + 1)
    };
    let mut runs: Vec<Range<usize>> = [0, 1, phrases / 2, phrases - 1]
        .into_iter()
        .filter(|&p| p < phrases)
        .filter_map(|p| span(&|n: &Note| n.phrase as usize == p))
        .collect();
    let middle = notes.iter().find(|n| n.phrase as usize == phrases / 2).map(|n| n.verse);
    runs.extend(middle.and_then(|verse| span(&|n: &Note| n.verse == verse)));
    runs.sort_by_key(|r| (r.start, r.end));
    runs.dedup();
    runs
}

/// The numbers a suite's runs sung again are judged by: each of [`again_runs`] of every take
/// heard whole, heard again from the take's own frames over the run ([`AGAIN_PAD_S`] either
/// side) and judged by the ear's [`cantor_ear::judge_again_notes`] in the key the take was in
/// there ([`key_at`]), beside the take.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct AgainMetrics {
    runs: u32,
    /// Runs the take heard enough of to judge (as the judge's own floor counts) not heard again.
    unheard: u32,
    /// Runs judged otherwise than in the take ([`again_otherwise`]).
    otherwise: u32,
    /// The furthest a note's error sung again is from its error in the take, in cents.
    apart_cents: f32,
    /// Marks on runs sung again that were not deserved (see [`deserved`]).
    false_marks: u32,
    /// Faults planted in runs sung again and heard, as a take's are counted but in a first phrase
    /// too (see [`fault`]); those caught by a mark; and those the take caught and the run did
    /// not, though its frames agreed on the note, as a mark on a note alone needs, besides each
    /// part of a verse the take marked off together that the run holds and is not marked so
    /// again, though it was planted so ([`deserved`]) and heard on three notes, as a verse's mark
    /// needs, whatever their length.
    faults: u32,
    caught: u32,
    dropped: u32,
    /// Of those, the faults in a first phrase, which a take is never marked in but a run sung
    /// again, in a key given, may be; and those caught.
    first_faults: u32,
    first_caught: u32,
    /// Runs past the first phrase whose words beside the take say otherwise than beside
    /// themselves which of their notes were in tune, or tell of a mark gone: sung from the take's
    /// own frames, a run is sung as before.
    told_otherwise: u32,
}

impl AgainMetrics {
    fn add(&mut self, take: &Judged) {
        let before = cantor_ear::Before {
            verdict: take.verdict.clone(),
            report: take.report.clone(),
        };
        for run in again_runs(&take.notes) {
            let (from, to) = (
                take.notes[run.start].start_s - AGAIN_PAD_S,
                take.notes[run.end - 1].end_s() + AGAIN_PAD_S,
            );
            let frames: Vec<Frame> = take.frames.iter().filter(|f| f.t >= from && f.t < to).cloned().collect();
            let Some(key) = key_at(&take.verdict, &take.report, run.clone()) else {
                continue;
            };
            let again = cantor_ear::judge_again_notes(take.notes.clone(), run.clone(), key, &before, &frames);
            let v = &again.verdict;
            self.runs += 1;
            if v.outcome != Outcome::Heard {
                let counted: Vec<usize> = run.clone().filter(|&i| take.notes[i].dur_s >= COUNTED_MIN_S).collect();
                let heard = counted.iter().filter(|&&i| take.report.notes[i].cents.is_some()).count();
                self.unheard += u32::from(heard as f32 >= cantor_core::judge::TAKE_HEARD_FLOOR * counted.len() as f32);
                continue;
            }
            self.false_marks += v.marks.iter().filter(|m| !deserved(m, &take.planted)).count() as u32;
            for i in run.clone().filter(|&i| fault(&take.notes, &take.planted, i)) {
                let caught = u32::from(v.marks.iter().any(|m| catches(m, i, &take.planted[i])));
                let before = take.verdict.marks.iter().any(|m| catches(m, i, &take.planted[i]));
                // A note its frames do not agree on is not marked alone, as part of a verse sung
                // again is; the take may have marked it with its verse.
                let heard = again.report.notes.get(i - run.start).is_some_and(cantor_core::judge::agreed);
                self.faults += 1;
                self.caught += caught;
                self.dropped += u32::from(before && heard && caught == 0);
                if take.notes[i].phrase == 0 {
                    self.first_faults += 1;
                    self.first_caught += caught;
                }
            }
            for m in take.verdict.marks.iter().filter(|m| m.kind == MarkKind::Verse) {
                let (first, last) = (m.first.max(run.start), m.last.min(run.end - 1));
                if first > last {
                    continue;
                }
                let part = Mark { first, last, ..*m };
                let heard = (first..=last)
                    .filter(|&i| again.report.notes[i - run.start].cents.is_some())
                    .count();
                let marked = v.marks.iter().any(|a| {
                    let way = a.cents.zip(m.cents).is_some_and(|(a, m)| a.signum() == m.signum());
                    a.kind == MarkKind::Verse && a.first <= first && a.last >= last && way
                });
                self.dropped += u32::from(deserved(&part, &take.planted) && heard >= 3 && !marked);
            }
            self.otherwise += u32::from(again_otherwise(&take.notes, v, &take.verdict, run.clone()));
            if run.clone().all(|i| take.notes[i].phrase > 0) {
                let mut own = vec![None; take.notes.len()];
                for (k, r) in again.report.notes.iter().enumerate() {
                    own[run.start + k] = r.cents;
                }
                let itself = cantor_core::again(v, &own, v, run.clone());
                let gone = again.summary.iter().any(|s| s.contains("gone"));
                self.told_otherwise += u32::from(again.summary.first() != itself.first() || gone);
            }
            for i in run {
                if let (Some(a), Some(w)) = (v.relative[i], take.verdict.relative[i]) {
                    self.apart_cents = self.apart_cents.max(fold(a - w).abs());
                }
            }
        }
    }
}

/// Whether a run of `notes` sung again (`again`) was judged otherwise than the same notes in
/// the take (`whole`), where the two are judged alike: other note marks past the first phrase
/// (where a take is never marked), save on a note a verse mark of either covers (sung again,
/// the part of a verse the run holds is judged as a verse when all of it is off together, which
/// it may be where the whole verse was not); other verse marks on a verse the run holds whole; or
/// the cadences inside it placed or called otherwise (see [`contradicts`]).
fn again_otherwise(notes: &[Note], again: &Verdict, whole: &Verdict, run: Range<usize>) -> bool {
    let in_verse = |i: usize| {
        [again, whole]
            .iter()
            .any(|v| v.marks.iter().any(|m| m.kind != MarkKind::Note && m.covers(i)))
    };
    let noted = |v: &Verdict| -> Vec<usize> {
        v.marks
            .iter()
            .filter(|m| m.kind == MarkKind::Note && run.contains(&m.first) && notes[m.first].phrase > 0 && !in_verse(m.first))
            .map(|m| m.first)
            .collect()
    };
    let held = |verse: u32| notes.iter().enumerate().all(|(i, n)| n.verse != verse || run.contains(&i));
    let verses = |v: &Verdict| -> Vec<(MarkKind, usize, usize)> {
        v.marks
            .iter()
            .filter(|m| m.kind != MarkKind::Note && run.contains(&m.first) && held(notes[m.first].verse))
            .map(|m| (m.kind, m.first, m.last))
            .collect()
    };
    let inside: Vec<Cadence> = whole
        .cadences
        .iter()
        .filter(|c| run.contains(&c.first) && run.contains(&c.last))
        .copied()
        .collect();
    noted(again) != noted(whole) || verses(again) != verses(whole) || contradicts(&again.cadences, &inside)
}

/// The numbers a suite's takes stopped short are judged by, besides its gate's over the notes
/// judged.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct StopMetrics {
    /// Takes stopped short, and those of them stopped before a phrase finished.
    takes: u32,
    unfinished: u32,
    /// Takes judged other than to the end of the last phrase finished: their notes, scores,
    /// errors or bands ending elsewhere, or a mark or cadence ending past it.
    misjudged: u32,
    /// Of the takes stopped before a phrase finished, those told anything: a key, a mark, a
    /// cadence, a band or a sentence.
    told_unfinished: u32,
    /// Faults planted past the notes judged (sung in the phrase cut short, or never sung),
    /// and those of them a mark caught.
    cut_faults: u32,
    cut_caught: u32,
    /// Takes with a phrase finished, each compared with the take sung whole on the notes
    /// judged; those judged otherwise there (see [`judged_otherwise`]); and the largest
    /// distance between the two keys, in cents.
    compared: u32,
    otherwise: u32,
    key_apart_cents: f32,
    /// Notes of 0.3 s or more the take sung whole heard that it did not, stopped, among the
    /// notes judged.
    lost: u32,
}

impl StopMetrics {
    fn add(&mut self, take: &Judged, s: &Stop) {
        let v = &take.verdict;
        let n = s.finished;
        self.takes += 1;
        self.cut_faults += s.cut_faults;
        self.cut_caught += s.cut_caught;
        let ends = [take.notes.len(), take.report.notes.len(), v.relative.len(), s.ribbon];
        self.misjudged +=
            u32::from(ends.iter().any(|&e| e != n) || v.marks.iter().any(|m| m.last >= n) || v.cadences.iter().any(|c| c.last >= n));
        if n == 0 {
            self.unfinished += 1;
            let told = s.ribbon > 0 || s.words > 0 || v.key_cents.is_some() || !v.marks.is_empty() || !v.cadences.is_empty();
            self.told_unfinished += u32::from(told);
        } else {
            self.compared += 1;
            self.otherwise += u32::from(judged_otherwise(v, &s.whole, n));
            let lost = |i: &usize| {
                take.notes[*i].dur_s >= COUNTED_MIN_S
                    && !take.planted[*i].silent
                    && v.relative[*i].is_none()
                    && s.whole.relative[*i].is_some()
            };
            self.lost += (0..n.min(v.relative.len())).filter(lost).count() as u32;
            if let (Some(a), Some(b)) = (v.key_cents, s.whole.key_cents) {
                self.key_apart_cents = self.key_apart_cents.max(fold(a - b).abs());
            }
        }
    }
}

impl Metrics {
    fn of(takes: &[Judged]) -> Metrics {
        let mut m = Metrics {
            takes: takes.len() as u32,
            worst_take_heard: 1.0,
            ..Metrics::default()
        };
        let ratio = |a: usize, b: usize| if b == 0 { 0.0 } else { a as f32 / b as f32 };
        let (mut counted, mut heard, mut masked, mut all, mut all_heard) = (0, 0, 0, 0, 0);
        let (mut errors, mut gross, mut tracked) = (0.0f32, 0usize, 0usize);
        let (mut caught, mut cadences_caught) = (0u32, 0u32);
        let (mut both, mut agreed) = (0usize, 0usize);
        let mut stopped: Option<StopMetrics> = None;
        let mut again: Option<AgainMetrics> = None;
        for take in takes {
            for f in &take.frames {
                if let (Some(m), Some(o)) = (f.midi, f.other)
                    && f.clarity >= cantor_core::pitch::DEFAULT_MIN_CLARITY
                {
                    both += 1;
                    agreed += usize::from(fold((m - o) * 100.0).abs() <= AGREEMENT_CENTS);
                }
            }
            m.timed_late += u32::from(!take.timing.late.is_empty());
            m.timed_by_sound += u32::from(take.timing.by_sound());
            m.timing_moved_marks += u32::from(!take.timing.kept());
            if let Some(s) = &take.stop {
                stopped.get_or_insert_default().add(take, s);
                // Stopped before a phrase finished: nothing was judged to measure.
                if take.notes.is_empty() {
                    continue;
                }
            }
            let v = &take.verdict;
            if take.stop.is_none() && v.outcome == Outcome::Heard {
                again.get_or_insert_default().add(take);
            }
            let (mut take_counted, mut take_heard) = (0, 0);
            for (i, note) in take.notes.iter().enumerate() {
                let r = &take.report.notes[i];
                let p = &take.planted[i];
                if !p.silent {
                    all += 1;
                    all_heard += usize::from(r.cents.is_some());
                    if note.dur_s >= COUNTED_MIN_S {
                        take_counted += 1;
                        take_heard += usize::from(r.cents.is_some());
                        masked += usize::from(r.cents.is_none() && r.masked_frames > r.voiced_frames);
                    }
                }
                let error = match (r.cents, take.truth[i], v.relative[i]) {
                    (Some(c), Some(t), _) => Some(fold(c - t)),
                    (_, None, Some(rel)) => Some(rel),
                    _ => None,
                };
                if let Some(e) = error {
                    errors += e.abs();
                    gross += usize::from(e.abs() > GROSS_CENTS);
                    tracked += 1;
                }
                let called_in_tune = v.relative[i].is_some_and(|c| c.abs() < cantor_core::judge::IN_TUNE_CENTS)
                    && !v.marks.iter().any(|mark| mark.covers(i));
                if called_in_tune && !p.silent && fold(p.cents).abs() >= OFF_CENTS {
                    m.false_in_tune += 1;
                }
            }
            counted += take_counted;
            heard += take_heard;
            m.worst_take_heard = m.worst_take_heard.min(ratio(take_heard, take_counted));
            m.takes_under_floor += u32::from(take_heard < take_floor(take_counted, take.stop.is_some()));
            m.marks += v.marks.len() as u32;
            m.false_marks += v.marks.iter().filter(|mark| !deserved(mark, &take.planted)).count() as u32;
            for i in faults(&take.notes, &take.planted) {
                m.faults += 1;
                caught += u32::from(v.marks.iter().any(|mark| catches(mark, i, &take.planted[i])));
            }
            if v.outcome == Outcome::Heard {
                m.summary_errors += u32::from(summary_wrong(v, take.planted_drift));
                for c in &v.cadences {
                    let (off, clear) = cadence_planted(c, &take.notes, &take.planted);
                    m.cadences += 1;
                    m.cadences_judged += u32::from(c.on_pitch().is_some());
                    m.cadence_errors += u32::from(match c.on_pitch() {
                        Some(true) => off,
                        Some(false) => clear,
                        None => false,
                    });
                    m.cadence_faults += u32::from(off);
                    cadences_caught += u32::from(off && c.on_pitch() == Some(false));
                }
                if let (Some(k), Some(t)) = (v.key_cents, take.true_key) {
                    m.key_error_cents = m.key_error_cents.max(fold(k - t).abs());
                }
            } else {
                m.unjudged += 1;
            }
            m.in_tune += v.in_tune as u32;
        }
        m.stopped = stopped;
        m.again = again;
        m.heard_fraction = ratio(heard, counted);
        m.heard_all = ratio(all_heard, all);
        m.masked_fraction = ratio(masked, counted);
        m.tracking_cents = if tracked == 0 { 0.0 } else { errors / tracked as f32 };
        m.gross_error_rate = ratio(gross, tracked);
        m.recall = if m.faults == 0 { 1.0 } else { caught as f32 / m.faults as f32 };
        m.cadence_recall = if m.cadence_faults == 0 {
            1.0
        } else {
            cadences_caught as f32 / m.cadence_faults as f32
        };
        m.agreement = (both > 0).then(|| agreed as f32 / both as f32);
        m
    }

    /// Why `gate` fails, if it does.
    fn gate_failures(&self, gate: Gate) -> Vec<String> {
        let mut out = Vec::new();
        let mut need = |ok: bool, what: String| {
            if !ok {
                out.push(what);
            }
        };
        need(self.false_marks == 0, format!("{} false marks", self.false_marks));
        need(
            self.timing_moved_marks == 0,
            format!("{} takes told otherwise as the page times them", self.timing_moved_marks),
        );
        // A take stopped short is judged to the end of the last phrase finished, and on nothing
        // past it.
        if let Some(s) = self.stopped {
            need(
                s.misjudged == 0,
                format!("{} stopped takes not judged to the end of the last phrase finished", s.misjudged),
            );
            need(
                s.told_unfinished == 0,
                format!(
                    "{} of {} takes stopped before a phrase finished told something",
                    s.told_unfinished, s.unfinished
                ),
            );
            need(
                s.cut_caught == 0,
                format!("{} of {} faults past the notes judged caught", s.cut_caught, s.cut_faults),
            );
        }
        // A singer late behind the cursor is timed by the sound of the voice.
        if matches!(gate, Gate::Expert | Gate::Student | Gate::Wrong) {
            need(
                self.timed_by_sound == self.timed_late,
                format!("{} of {} takes timed by their first sound", self.timed_by_sound, self.timed_late),
            );
        }
        match gate {
            Gate::None => {}
            Gate::Expert => {
                need(self.marks == 0, format!("{} marks on good takes", self.marks));
                need(
                    self.heard_fraction >= HEARD_FLOOR,
                    format!("heard {:.3} < {HEARD_FLOOR}", self.heard_fraction),
                );
                need(
                    self.takes_under_floor == 0,
                    format!(
                        "{} takes heard under {TAKE_HEARD_FLOOR} (worst {:.3})",
                        self.takes_under_floor, self.worst_take_heard
                    ),
                );
                need(
                    self.heard_all >= ALL_HEARD_FLOOR,
                    format!("all notes heard {:.3} < {ALL_HEARD_FLOOR}", self.heard_all),
                );
                need(self.unjudged == 0, format!("{} takes not judged", self.unjudged));
                need(self.summary_errors == 0, format!("{} wrong summaries", self.summary_errors));
                need(self.cadence_errors == 0, format!("{} cadences told wrong", self.cadence_errors));
                need(
                    self.cadences_judged as f32 >= CADENCE_JUDGED_FLOOR * self.cadences as f32,
                    format!("{} of {} cadences judged", self.cadences_judged, self.cadences),
                );
            }
            Gate::Student | Gate::Wrong => {
                need(self.recall >= RECALL_FLOOR, format!("recall {:.3} < {RECALL_FLOOR}", self.recall));
                need(self.faults > 0, "no faults planted".into());
                need(self.false_in_tune == 0, format!("{} faults called in tune", self.false_in_tune));
                need(
                    self.key_error_cents <= KEY_TOLERANCE,
                    format!("key off by {:.0} cents", self.key_error_cents),
                );
                need(self.unjudged == 0, format!("{} takes not judged", self.unjudged));
                need(self.summary_errors == 0, format!("{} wrong summaries", self.summary_errors));
                need(self.cadence_errors == 0, format!("{} cadences told wrong", self.cadence_errors));
                need(
                    self.cadences_judged as f32 >= CADENCE_JUDGED_FLOOR * self.cadences as f32,
                    format!("{} of {} cadences judged", self.cadences_judged, self.cadences),
                );
            }
            Gate::Silent => {
                need(
                    self.unjudged == self.takes,
                    format!("{} of {} takes judged", self.takes - self.unjudged, self.takes),
                );
                need(self.marks == 0, format!("{} marks", self.marks));
                need(
                    self.heard_all <= SILENT_CEILING,
                    format!("{:.3} of the notes heard", self.heard_all),
                );
                need(self.in_tune == 0, format!("{} notes heard in tune", self.in_tune));
            }
        }
        out
    }

    /// Why runs sung again fail their gates, if they do: every suite's, and under the student
    /// and wrong gates the faults planted in a first phrase caught.
    fn again_failures(&self, gate: Gate) -> Vec<String> {
        let Some(a) = self.again else { return Vec::new() };
        let mut out = Vec::new();
        let mut need = |ok: bool, what: String| {
            if !ok {
                out.push(what);
            }
        };
        need(a.false_marks == 0, format!("{} false marks on runs sung again", a.false_marks));
        need(a.unheard == 0, format!("{} of {} runs sung again not heard", a.unheard, a.runs));
        need(
            a.otherwise == 0,
            format!("{} of {} runs sung again judged otherwise than in the take", a.otherwise, a.runs),
        );
        need(
            a.dropped == 0,
            format!("{} faults the take caught not caught sung again", a.dropped),
        );
        need(
            a.told_otherwise == 0,
            format!("{} runs sung again as before told otherwise", a.told_otherwise),
        );
        if matches!(gate, Gate::Student | Gate::Wrong) && a.first_faults > 0 {
            let recall = a.first_caught as f32 / a.first_faults as f32;
            need(
                recall >= RECALL_FLOOR,
                format!(
                    "{} of {} faults in a first phrase sung again caught",
                    a.first_caught, a.first_faults
                ),
            );
        }
        out
    }

    /// Why takes stopped short fail to agree with the takes sung whole, if they do: a gate of
    /// every suite with takes stopped.
    fn agreement_failures(&self) -> Vec<String> {
        let Some(s) = self.stopped else { return Vec::new() };
        let mut out = Vec::new();
        if s.otherwise > 0 {
            out.push(format!(
                "{} of {} stopped takes judged otherwise than sung whole",
                s.otherwise, s.compared
            ));
        }
        if s.key_apart_cents > KEY_TOLERANCE {
            out.push(format!("a stopped take's key {:.0} cents from the whole take's", s.key_apart_cents));
        }
        if s.lost > 0 {
            out.push(format!("{} notes heard sung whole not heard stopped", s.lost));
        }
        out
    }

    /// Which metrics moved the wrong way beyond tolerance since `base`. For the silent
    /// control, hearing more is the wrong way.
    fn regressions(&self, base: &Metrics, gate: Gate) -> Vec<String> {
        let mut out = Vec::new();
        let mut check = |name: &str, now: f32, was: f32, worse: bool| {
            if worse {
                out.push(format!("{name} {was:.3} -> {now:.3}"));
            }
        };
        if gate == Gate::Silent {
            check("heard_all", self.heard_all, base.heard_all, self.heard_all > base.heard_all + 0.005);
        } else {
            check(
                "heard_fraction",
                self.heard_fraction,
                base.heard_fraction,
                self.heard_fraction < base.heard_fraction - 0.02,
            );
            check("heard_all", self.heard_all, base.heard_all, self.heard_all < base.heard_all - 0.02);
            check(
                "masked_fraction",
                self.masked_fraction,
                base.masked_fraction,
                self.masked_fraction > base.masked_fraction + 0.02,
            );
        }
        check(
            "tracking_cents",
            self.tracking_cents,
            base.tracking_cents,
            self.tracking_cents > base.tracking_cents + 2.0,
        );
        check(
            "gross_error_rate",
            self.gross_error_rate,
            base.gross_error_rate,
            self.gross_error_rate > base.gross_error_rate + 0.02,
        );
        check("recall", self.recall, base.recall, self.recall < base.recall - 0.02);
        check(
            "timed_by_sound",
            self.timed_by_sound as f32,
            base.timed_by_sound as f32,
            self.timed_by_sound < base.timed_by_sound,
        );
        check(
            "timed_late",
            self.timed_late as f32,
            base.timed_late as f32,
            self.timed_late != base.timed_late,
        );
        if let (Some(now), Some(was)) = (self.agreement, base.agreement) {
            check("agreement", now, was, now < was - 0.02);
        }
        check(
            "summary_errors",
            self.summary_errors as f32,
            base.summary_errors as f32,
            self.summary_errors > base.summary_errors,
        );
        let judged = |m: &Metrics| {
            if m.cadences == 0 {
                1.0
            } else {
                m.cadences_judged as f32 / m.cadences as f32
            }
        };
        check("cadences_judged", judged(self), judged(base), judged(self) < judged(base) - 0.02);
        check(
            "cadence_recall",
            self.cadence_recall,
            base.cadence_recall,
            self.cadence_recall < base.cadence_recall - 0.02,
        );
        check(
            "cadence_errors",
            self.cadence_errors as f32,
            base.cadence_errors as f32,
            self.cadence_errors > base.cadence_errors,
        );
        check(
            "key_error_cents",
            self.key_error_cents,
            base.key_error_cents,
            self.key_error_cents > base.key_error_cents + 10.0,
        );
        check(
            "false_marks",
            self.false_marks as f32,
            base.false_marks as f32,
            self.false_marks > base.false_marks,
        );
        // What is counted is fixed by the suites: a change means the test moved, not the listener.
        check("faults", self.faults as f32, base.faults as f32, self.faults != base.faults);
        check(
            "cadences",
            self.cadences as f32,
            base.cadences as f32,
            self.cadences != base.cadences,
        );
        check(
            "cadence_faults",
            self.cadence_faults as f32,
            base.cadence_faults as f32,
            self.cadence_faults != base.cadence_faults,
        );
        check("takes", self.takes as f32, base.takes as f32, self.takes != base.takes);
        // Where takes are stopped, and what is planted past the stop, is fixed by the suites too.
        let stopped = |m: &Metrics| m.stopped.unwrap_or_default();
        let (now, was) = (stopped(self), stopped(base));
        check("stopped takes", now.takes as f32, was.takes as f32, now.takes != was.takes);
        check(
            "stopped before a phrase finished",
            now.unfinished as f32,
            was.unfinished as f32,
            now.unfinished != was.unfinished,
        );
        check(
            "faults past the notes judged",
            now.cut_faults as f32,
            was.cut_faults as f32,
            now.cut_faults != was.cut_faults,
        );
        check(
            "stopped takes judged otherwise than sung whole",
            now.otherwise as f32,
            was.otherwise as f32,
            now.otherwise > was.otherwise,
        );
        check(
            "stopped key_apart_cents",
            now.key_apart_cents,
            was.key_apart_cents,
            now.key_apart_cents > was.key_apart_cents + 10.0,
        );
        // Which runs are sung again, and what is planted in them, is fixed by the suites too.
        let again = |m: &Metrics| m.again.unwrap_or_default();
        let (now, was) = (again(self), again(base));
        check("runs sung again", now.runs as f32, was.runs as f32, now.runs != was.runs);
        check("faults sung again", now.faults as f32, was.faults as f32, now.faults != was.faults);
        check(
            "faults in a first phrase sung again",
            now.first_faults as f32,
            was.first_faults as f32,
            now.first_faults != was.first_faults,
        );
        check(
            "again apart_cents",
            now.apart_cents,
            was.apart_cents,
            now.apart_cents > was.apart_cents + 10.0,
        );
        // SwiftF0 going deaf on a suite would otherwise drop its agreement from the gate.
        if let (None, Some(was)) = (self.agreement, base.agreement) {
            out.push(format!("agreement {was:.3} -> none: SwiftF0 compared no frames"));
        }
        out
    }
}

/// The notes a mark on a take must catch: its [`fault`]s past the first phrase, where the key
/// is read.
fn faults<'a>(notes: &'a [Note], planted: &'a [Planted]) -> impl Iterator<Item = usize> + 'a {
    (0..notes.len()).filter(move |&i| notes[i].phrase > 0 && fault(notes, planted, i))
}

/// Whether note `i` is a fault a mark must catch, given the key: planted at least
/// [`FLAGRANT_CENTS`] off (octave-agnostic) and long enough, or in a verse planted silent
/// throughout. A run sung again, in a key given, must catch it in a first phrase too.
fn fault(notes: &[Note], planted: &[Planted], i: usize) -> bool {
    let p = &planted[i];
    if p.silent {
        let verse: Vec<usize> = (0..notes.len()).filter(|&j| notes[j].verse == notes[i].verse).collect();
        verse.len() >= 3 && verse.iter().all(|&j| planted[j].silent)
    } else {
        fold(p.cents).abs() >= FLAGRANT_CENTS && notes[i].dur_s >= FLAGRANT_MIN_S
    }
}

/// Whether `mark` catches the fault planted on note `i`.
fn catches(mark: &Mark, i: usize, p: &Planted) -> bool {
    if !mark.covers(i) {
        return false;
    }
    match mark.kind {
        MarkKind::VerseMissing => p.silent,
        MarkKind::Note | MarkKind::Verse => !p.silent && mark.cents.is_some_and(|c| c.signum() == fold(p.cents).signum()),
    }
}

/// Whether the notes under `mark` were planted the way it says: for a note mark, its note;
/// for a verse mark, at least [`VERSE_DESERVED`] of its notes.
fn deserved(mark: &Mark, planted: &[Planted]) -> bool {
    let fits = |p: &Planted| match mark.kind {
        MarkKind::VerseMissing => p.silent,
        MarkKind::Note | MarkKind::Verse => {
            let c = fold(p.cents);
            !p.silent && c.abs() >= CLEAR_CENTS && mark.cents.is_some_and(|m| m.signum() == c.signum())
        }
    };
    let Some(under) = planted.get(mark.first..=mark.last) else {
        return false;
    };
    under.iter().filter(|p| fits(p)).count() as f32 >= VERSE_DESERVED * under.len() as f32
}

/// What `out/eval.json` holds for one suite.
#[derive(Serialize)]
struct SuiteOutput<'a> {
    name: &'a str,
    gate: Gate,
    metrics: Metrics,
    #[serde(skip_serializing_if = "Option::is_none")]
    oracle: Option<OracleStats>,
    failures: Vec<String>,
    takes: Vec<TakeOutput<'a>>,
}

#[derive(Serialize)]
struct TakeOutput<'a> {
    name: &'a str,
    verdict: &'a Verdict,
    report: &'a cantor_core::Report,
    #[serde(skip_serializing_if = "Option::is_none")]
    oracle: Option<&'a OracleTake>,
    timing: &'a Timing,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<&'a Stop>,
}

/// The widths of the console's columns of takes stopped short, after the suite's name.
const STOP_WIDTHS: [usize; 9] = [7, 10, 5, 9, 6, 6, 8, 9, 4];
/// The widths of the columns of the table of runs sung again, after the suite's name.
const AGAIN_WIDTHS: [usize; 10] = [5, 7, 9, 5, 6, 6, 7, 6, 6, 4];

/// Runs the gates, or with `only`, just the named suite, drawing its takes. With an oracle,
/// every take is also labelled by it and compared, outside the gates.
pub fn run(
    root: &Path,
    ear: &Ear,
    oracle: Option<&Oracle>,
    takes_dir: Option<&Path>,
    write_baseline: bool,
    only: Option<&str>,
) -> Result<ExitCode, String> {
    let mut suites: Vec<(String, Gate, Vec<Judged>)> = Vec::new();
    for suite in load_suites(&root.join("evals/suites"))? {
        if only.is_some_and(|o| o != suite.name) {
            continue;
        }
        let judged = in_parallel(&suite.takes, |i, t| run_take(root, ear, oracle, t, format!("{} {i}", suite.name)))
            .into_iter()
            .collect::<Result<_, _>>()?;
        suites.push((suite.name, suite.gate, judged));
    }
    if let Some(dir) = takes_dir.filter(|_| only.is_none_or(is_real)) {
        let recorded = json_files(dir)?.iter().map(|p| Recorded::read(p)).collect::<Result<Vec<_>, _>>()?;
        if recorded.is_empty() {
            return Err(format!("{}: no takes", dir.display()));
        }
        let whole = recorded
            .iter()
            .map(|t| judge_real(ear, oracle, t, None))
            .collect::<Result<Vec<_>, _>>()?;
        // Each stopped where `stop_notes` says, and heard again from there.
        let stopped: Option<Vec<Judged>> = if only.is_none_or(|o| o == REAL_STOPPED) {
            let stops: Vec<(usize, usize)> = recorded
                .iter()
                .enumerate()
                .flat_map(|(i, t)| stop_notes(&t.notes).into_iter().map(move |k| (i, k)))
                .collect();
            let judged = in_parallel(&stops, |_, &(i, k)| {
                judge_real(ear, oracle, &recorded[i], Some((k, &whole[i].verdict)))
            });
            Some(judged.into_iter().collect::<Result<_, _>>()?)
        } else {
            None
        };
        if only.is_none_or(|o| o == REAL) {
            suites.push((REAL.into(), Gate::Expert, whole));
        }
        if let Some(stopped) = stopped {
            suites.push((REAL_STOPPED.into(), Gate::Expert, stopped));
        }
    }
    if suites.is_empty() {
        return Err(format!("no suite named {}", only.unwrap_or("")));
    }

    // The NSDF tracker alone, as the browser listens, is held to a baseline of its own.
    let tag = if ear.nsdf_only() { "-nsdf" } else { "" };
    let out_dir = root.join("out");
    let explain_dir = out_dir.join(format!("explain{tag}"));
    std::fs::create_dir_all(&explain_dir).map_err(|e| format!("{}: {e}", explain_dir.display()))?;
    for (_, _, judged) in &suites {
        for j in judged {
            let path = explain_dir.join(format!("{}.svg", j.name.replace(' ', "-")));
            let svg = explain::svg(&explain::Picture {
                title: &j.name,
                notes: &j.notes,
                frames: &j.frames,
                verdict: &j.verdict,
                truth: &j.truth,
                scored: &j.report.notes,
                oracle: j.oracle.as_ref().map(|o| &o.report.notes[..]),
            });
            std::fs::write(&path, svg).map_err(|e| format!("{}: {e}", path.display()))?;
            if only.is_some() {
                println!("{}", path.display());
            }
        }
    }
    if only.is_some() {
        return Ok(ExitCode::SUCCESS);
    }

    let baseline_path = root.join(format!("evals/baseline{tag}.json"));
    let baseline: BTreeMap<String, Metrics> = match std::fs::read_to_string(&baseline_path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", baseline_path.display()))?,
        Err(_) => BTreeMap::new(),
    };

    println!(
        "{:<22} {:<8} {:>5} {:>6} {:>6} {:>6} {:>7} {:>6} {:>6} {:>6} {:>5} {:>6} {:>6}  result",
        "suite", "gate", "takes", "heard", "all", "masked", "|cents|", "gross", "faults", "recall", "false", "agree", "late"
    );
    let mut md = String::from(
        "| suite | gate | takes | heard | all heard | masked | \\|cents\\| | gross | faults | recall | false marks | trackers agree | late singer timed by sound | result |\n|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|\n",
    );
    let mut scorecard = BTreeMap::new();
    let mut outputs = Vec::new();
    let mut gate_failures = Vec::new();
    let mut baseline_failures = Vec::new();
    let mut oracle_md = String::new();
    let mut oracle_console = String::new();
    let mut stop_md = String::new();
    let mut stop_console = String::new();
    let mut again_md = String::new();
    let mut again_console = String::new();
    for (name, gate, judged) in &suites {
        let metrics = Metrics::of(judged);
        let oracle = OracleStats::of(judged);
        let mut gated = metrics.gate_failures(*gate);
        gated.extend(metrics.agreement_failures());
        gated.extend(metrics.again_failures(*gate));
        let mut moved = Vec::new();
        // Real takes are held to their gate only: the set and its audio live elsewhere.
        if !is_real(name) {
            match baseline.get(name) {
                Some(base) => moved.extend(metrics.regressions(base, *gate)),
                None => moved.push("not in the baseline".into()),
            }
            scorecard.insert(name.clone(), metrics);
        }
        let failures: Vec<String> = gated.iter().chain(&moved).cloned().collect();
        let agreement = metrics.agreement.map_or("-".to_string(), |a| format!("{a:.3}"));
        let late = format!("{}/{}", metrics.timed_by_sound, metrics.timed_late);
        let result = if failures.is_empty() {
            "pass".to_string()
        } else {
            format!("FAIL: {}", failures.join("; "))
        };
        println!(
            "{:<22} {:<8} {:>5} {:>6.3} {:>6.3} {:>6.3} {:>7.2} {:>6.3} {:>6} {:>6.3} {:>5} {:>6} {:>6}  {result}",
            name,
            gate.name(),
            metrics.takes,
            metrics.heard_fraction,
            metrics.heard_all,
            metrics.masked_fraction,
            metrics.tracking_cents,
            metrics.gross_error_rate,
            metrics.faults,
            metrics.recall,
            metrics.false_marks,
            agreement,
            late,
        );
        md.push_str(&format!(
            "| {name} | {} | {} | {:.3} | {:.3} | {:.3} | {:.2} | {:.3} | {} | {:.3} | {} | {} | {} | {result} |\n",
            gate.name(),
            metrics.takes,
            metrics.heard_fraction,
            metrics.heard_all,
            metrics.masked_fraction,
            metrics.tracking_cents,
            metrics.gross_error_rate,
            metrics.faults,
            metrics.recall,
            metrics.false_marks,
            agreement,
            late,
        ));
        gate_failures.extend(gated.iter().map(|f| format!("{name}: {f}")));
        baseline_failures.extend(moved.iter().map(|f| format!("{name}: {f}")));
        if let Some(s) = metrics.stopped {
            let counts = [
                s.takes,
                s.unfinished,
                s.told_unfinished,
                s.misjudged,
                s.cut_faults,
                s.cut_caught,
                s.compared,
                s.otherwise,
                s.lost,
            ];
            let console: String = counts.iter().zip(STOP_WIDTHS).map(|(c, w)| format!(" {c:>w$}")).collect();
            stop_console.push_str(&format!("{name:<22}{console} {:>9.1}\n", s.key_apart_cents));
            let cells: String = counts.iter().map(|c| format!(" {c} |")).collect();
            stop_md.push_str(&format!("| {name} |{cells} {:.1} |\n", s.key_apart_cents));
        }
        if let Some(a) = metrics.again {
            let counts = [
                a.runs,
                a.unheard,
                a.otherwise,
                a.false_marks,
                a.faults,
                a.caught,
                a.dropped,
                a.first_faults,
                a.first_caught,
                a.told_otherwise,
            ];
            let console: String = counts.iter().zip(AGAIN_WIDTHS).map(|(c, w)| format!(" {c:>w$}")).collect();
            again_console.push_str(&format!("{name:<22}{console} {:>6.1}\n", a.apart_cents));
            let cells: String = counts.iter().map(|c| format!(" {c} |")).collect();
            again_md.push_str(&format!("| {name} |{cells} {:.1} |\n", a.apart_cents));
        }
        if let Some(o) = oracle {
            let cents = o.tracking_cents.map_or("-".to_string(), |c| format!("{c:.2}"));
            let key = o.key_error_cents.map_or("-".to_string(), |c| format!("{c:.0}"));
            oracle_console.push_str(&format!(
                "{name:<22} {:>6.3} {:>8} {:>8} {cents:>7} {:>8} {key:>6}\n",
                o.heard, o.compared, o.disagreements, o.summary_errors
            ));
            oracle_md.push_str(&format!(
                "| {name} | {:.3} | {} | {} | {cents} | {} | {key} |\n",
                o.heard, o.compared, o.disagreements, o.summary_errors
            ));
        }
        outputs.push(SuiteOutput {
            name,
            gate: *gate,
            metrics,
            oracle,
            failures,
            takes: judged
                .iter()
                .map(|j| TakeOutput {
                    name: &j.name,
                    verdict: &j.verdict,
                    report: &j.report,
                    oracle: j.oracle.as_ref(),
                    timing: &j.timing,
                    stop: j.stop.as_ref(),
                })
                .collect(),
        });
    }
    // A suite the baseline holds must still exist: deleting a hard suite is not a pass.
    for name in baseline.keys().filter(|n| !scorecard.contains_key(*n)) {
        baseline_failures.push(format!("{name}: in the baseline but not in evals/suites"));
    }

    if !stop_md.is_empty() {
        let note = "Takes stopped short, judged to the end of the last phrase finished where the singer stopped. \
             Unfinished: stopped before a phrase finished, so judged to nothing; told: of those, told anything. \
             Misjudged: judged to elsewhere, or a mark or cadence past it. Cut faults: planted past the notes judged \
             (caught: by a mark). Otherwise: judged otherwise than the take sung whole on the notes judged; \
             lost: notes heard sung whole not heard stopped; key apart: the furthest the two keys were.";
        let heads = [
            "stopped",
            "unfinished",
            "told",
            "misjudged",
            "cut",
            "caught",
            "compared",
            "otherwise",
            "lost",
        ];
        let heads: String = heads.iter().zip(STOP_WIDTHS).map(|(h, w)| format!(" {h:>w$}")).collect();
        println!("\n{note}\n{:<22}{heads} {:>9}\n{stop_console}", "suite", "key apart");
        md.push_str(&format!(
            "\n{note}\n\n| suite | stopped | unfinished | told | misjudged | cut faults | caught | compared with the whole take | judged otherwise | lost | key apart (cents) |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n{stop_md}"
        ));
    }
    if !again_md.is_empty() {
        let note = "Runs sung again: the first, second, middle and last phrases of every take heard whole, and the verse \
             of its middle phrase, heard again from the take's own sound and judged in the key the take was in there. \
             Unheard: not heard again though the take heard enough of them. Otherwise: judged otherwise than in the take \
             where the two are judged alike. False: marks not deserved. Faults: planted in the runs heard again, in a \
             first phrase too (caught: by a mark; dropped: caught by the take, not the run, a verse's part included). \
             First: of those, in a first phrase, which only a run sung again is marked in. Told: runs past the first \
             phrase told otherwise beside the take than beside themselves which notes were in tune, or of a mark gone. \
             Apart: the furthest a note's error sung again was from its error in the take.";
        let heads = [
            "runs",
            "unheard",
            "otherwise",
            "false",
            "faults",
            "caught",
            "dropped",
            "first",
            "caught",
            "told",
        ];
        let heads: String = heads.iter().zip(AGAIN_WIDTHS).map(|(h, w)| format!(" {h:>w$}")).collect();
        println!("\n{note}\n{:<22}{heads} {:>6}\n{again_console}", "suite", "apart");
        md.push_str(&format!(
            "\n{note}\n\n| suite | runs | unheard | judged otherwise | false marks | faults | caught | dropped | first-phrase faults | caught | told otherwise | apart (cents) |\n|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n{again_md}"
        ));
    }
    if !oracle_md.is_empty() {
        let note = format!(
            "The oracle (CREPE), not gated. Heard: of the notes sung, the share it gave a pitch. \
             Disagree: notes both heard more than {GROSS_CENTS:.0} cents apart, octaves aside."
        );
        println!(
            "\n{note}\n{:<22} {:>6} {:>8} {:>8} {:>7} {:>8} {:>6}\n{oracle_console}",
            "suite", "heard", "compared", "disagree", "|cents|", "summary", "key"
        );
        md.push_str(&format!(
            "\n{note}\n\n| suite | oracle heard | notes compared | disagree with the scorer | oracle \\|cents\\| | oracle summary errors | oracle key error |\n|---|--:|--:|--:|--:|--:|--:|\n{oracle_md}"
        ));
    }
    write_json(&out_dir.join(format!("eval{tag}.json")), &outputs)?;
    std::fs::write(out_dir.join(format!("eval{tag}.md")), &md).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    if write_baseline {
        if !gate_failures.is_empty() {
            for f in &gate_failures {
                println!("failed: {f}");
            }
            println!("not writing the baseline while a gate fails");
            return Ok(ExitCode::FAILURE);
        }
        write_json(&baseline_path, &scorecard)?;
        println!("wrote {}", baseline_path.display());
        return Ok(ExitCode::SUCCESS);
    }
    let failures: Vec<&String> = gate_failures.iter().chain(&baseline_failures).collect();
    for f in &failures {
        println!("failed: {f}");
    }
    Ok(if failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

/// `f` over `items` on every core, the results in order. Each take is judged on its own, so
/// the order they run in changes nothing.
fn in_parallel<T: Sync, R: Send>(items: &[T], f: impl Fn(usize, &T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<R>>> = items.iter().map(|_| Mutex::new(None)).collect();
    let workers = std::thread::available_parallelism().map_or(1, |n| n.get()).min(items.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    let r = f(i, item);
                    *results[i].lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
                }
            });
        }
    });
    results
        .into_iter()
        .map(|r| r.into_inner().unwrap_or_else(|e| e.into_inner()).expect("every item ran"))
        .collect()
}

/// A suite's take: its chant, the chant's notes as timed in the take, the take rendered whole,
/// and, when the singer stopped it short, how many of its samples were heard (to halfway
/// through the note after `through`).
fn render_spec(root: &Path, spec: &TakeSpec) -> Result<(String, Vec<Note>, Take, Option<usize>), String> {
    let path = root.join(&spec.gabc);
    let gabc = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut notes = notes_from_gabc(&gabc, spec.pulse_s);
    for n in &mut notes {
        n.start_s += spec.lead_in_s;
    }
    let take = render_take(&notes, &spec.profile, SAMPLE_RATE, spec.seed);
    let heard = match spec.through {
        None => None,
        Some(through) => {
            let next = notes
                .get(through + 1)
                .ok_or_else(|| format!("{}: note {through} is the chant's last or past it, so not stopped short", spec.gabc))?;
            let end = ((next.start_s + next.dur_s / 2.0) * SAMPLE_RATE).round() as usize;
            Some(end.min(take.samples.len()))
        }
    };
    Ok((gabc, notes, take, heard))
}

fn run_take(root: &Path, ear: &Ear, oracle: Option<&Oracle>, spec: &TakeSpec, name: String) -> Result<Judged, String> {
    let (gabc, chant, take, heard) = render_spec(root, spec)?;
    let profile = &spec.profile;
    let len = heard.unwrap_or(take.samples.len());
    let samples = &take.samples[..len];
    // The app knows when it played the cue; with none, the guide's bleed cannot be measured.
    let guide = |len: usize| {
        take.guide.as_deref().map(|played| Guide {
            samples: &played[..len],
            alone: cue_span(&chant).unwrap_or((0.0, 0.0)),
        })
    };
    let frames = ear.listen(samples, SAMPLE_RATE, guide(len))?;
    let planted_all = profile.planted(&chant);
    let (notes, report, verdict, stop) = match spec.through {
        None => {
            let report = score(&chant, &frames);
            let verdict = judge(&chant, &report);
            (chant.clone(), report, verdict, None)
        }
        Some(want) => {
            let through = through_heard(&chant, len as f32 / SAMPLE_RATE);
            if through != Some(want) {
                return Err(format!(
                    "{name}: stopped after note {want}, but the take's length reads {through:?}"
                ));
            }
            // Judged as the page judges it, by the ear's own function.
            let shown = cantor_ear::judge_gabc(&gabc, spec.pulse_s, spec.lead_in_s, &frames, through);
            let whole_frames = ear.listen(&take.samples, SAMPLE_RATE, guide(take.samples.len()))?;
            let whole = judge(&chant, &score(&chant, &whole_frames));
            let stop = Stop::of(&chant, &planted_all, through, &shown, whole);
            (shown.notes, shown.report, shown.verdict, Some(stop))
        }
    };
    let oracle = match oracle {
        Some(_) if notes.is_empty() => Some(OracleTake::of(&notes, &[])),
        Some(o) => Some(OracleTake::of(&notes, &o.label(samples, SAMPLE_RATE, &notes, &frames)?)),
        None => None,
    };
    let timing = Timing::of(
        &chant,
        stop.is_some(),
        samples,
        SAMPLE_RATE,
        &frames,
        &verdict,
        take.guide.is_some(),
    );
    let planted = planted_all[..notes.len()].to_vec();
    let mid = |n: &Note| n.start_s + n.dur_s / 2.0;
    let truth = notes
        .iter()
        .zip(&planted)
        .map(|(n, p)| (!p.silent).then(|| profile.key_cents + p.cents + profile.drift_cents_per_second * mid(n)))
        .collect();
    // The key at the first verse judged, where the judge sets it.
    let first_verse: Vec<f32> = notes.iter().filter(|n| n.verse == notes[0].verse).map(mid).collect();
    let t0 = first_verse.iter().sum::<f32>() / first_verse.len().max(1) as f32;
    let span = match (notes.first(), notes.last()) {
        (Some(a), Some(b)) => mid(b) - mid(a),
        _ => 0.0,
    };
    Ok(Judged {
        name,
        true_key: (!profile.singer_silent).then(|| fold(profile.key_cents + profile.drift_cents_per_second * t0)),
        planted_drift: profile.drift_over(span),
        notes,
        planted,
        truth,
        frames,
        verdict,
        report,
        oracle,
        timing,
        stop,
    })
}

/// A suite's take as `cantor take` gives it: the chant and timing to judge it by, and what
/// `cantor eval` heard, so another ear can be checked against the eval.
#[derive(Serialize)]
pub struct TakeFile {
    pub gabc: String,
    pub pulse_s: f32,
    /// When the first note starts, and the take's first loud sample, in seconds.
    pub lead_in_s: f32,
    pub onset_s: Option<f32>,
    pub report: cantor_core::Report,
    pub verdict: Verdict,
    /// The take note by note, as the page draws it.
    pub ribbon: Vec<cantor_core::Band>,
    /// Each of the verdict's marks in words, for a reader of the file (another ear's words
    /// differ with its cents).
    pub told: Vec<String>,
    /// The take as a whole in two sentences, as the page shows it.
    pub summary: Vec<String>,
}

/// Take `index` of `suite`, as `ear` hears it in `cantor eval`, and its samples at `rate`.
/// Takes with a guide are refused: the guide's bleed is measured from samples the app plays,
/// which a file alone does not carry. So are takes stopped short, which the file would judge
/// whole.
pub fn take(root: &Path, ear: &Ear, suite: &str, index: usize, rate: f32) -> Result<(Vec<f32>, TakeFile), String> {
    let suites = load_suites(&root.join("evals/suites"))?;
    let found = suites
        .iter()
        .find(|s| s.name == suite)
        .ok_or_else(|| format!("no suite named {suite}"))?;
    let spec = found
        .takes
        .get(index)
        .ok_or_else(|| format!("{suite} has {} takes", found.takes.len()))?;
    if spec.profile.guide != GuideMode::None {
        return Err(format!("{suite} {index} plays a guide"));
    }
    if spec.through.is_some() {
        return Err(format!("{suite} {index} is stopped short"));
    }
    let judged = run_take(root, ear, None, spec, format!("{suite}-{index}"))?;
    let path = root.join(&spec.gabc);
    let gabc = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let take = render_take(&judged.notes, &spec.profile, SAMPLE_RATE, spec.seed);
    let samples = if rate == SAMPLE_RATE {
        take.samples
    } else {
        cantor_swift::resample(&take.samples, SAMPLE_RATE, rate)
    };
    let onset_s = cantor_ear::onset(&samples, rate);
    Ok((
        samples,
        TakeFile {
            gabc,
            pulse_s: spec.pulse_s,
            lead_in_s: spec.lead_in_s,
            onset_s,
            ribbon: cantor_core::ribbon(&judged.notes, &judged.frames, &judged.report, &judged.verdict),
            told: cantor_core::told(&judged.verdict),
            summary: cantor_core::summary(&judged.notes, &judged.verdict),
            report: judged.report,
            verdict: judged.verdict,
        },
    ))
}

/// Every take's audio and its rate, named as the eval names it: each suite's synthetic takes
/// (a take stopped short as far as it was heard), then the real takes in `takes`, whole.
pub fn audio(root: &Path, takes: Option<&Path>) -> Result<Vec<(String, Vec<f32>, f32)>, String> {
    let mut out = Vec::new();
    for suite in load_suites(&root.join("evals/suites"))? {
        for (i, spec) in suite.takes.iter().enumerate() {
            let (_, _, mut take, heard) = render_spec(root, spec)?;
            take.samples.truncate(heard.unwrap_or(take.samples.len()));
            out.push((format!("{}-{i}", suite.name), take.samples, SAMPLE_RATE));
        }
    }
    if let Some(dir) = takes {
        for path in json_files(dir)? {
            let take = Recorded::read(&path)?;
            out.push((format!("{REAL} {}", take.name), take.samples, take.rate));
        }
    }
    Ok(out)
}

/// `f` over `items` on every core, as the eval runs takes.
pub fn each<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    in_parallel(items, |_, item| f(item))
}

/// The ribbon of the real take described by the file at `path`, as `ear` hears it: an aligned
/// recording's trace, which the page draws under the singer's.
pub fn recording(ear: &Ear, path: &Path) -> Result<Vec<cantor_core::Band>, String> {
    let take = judge_real(ear, None, &Recorded::read(path)?, None)?;
    Ok(cantor_core::ribbon(&take.notes, &take.frames, &take.report, &take.verdict))
}

/// A real take read (see [`RealTake`]): its name, the chant's notes at the times they were
/// sung, and its audio.
struct Recorded {
    name: String,
    notes: Vec<Note>,
    /// What the singer is known to have sung off the score, note by note ([`RealTake::off`]).
    planted: Vec<Planted>,
    samples: Vec<f32>,
    rate: f32,
}

impl Recorded {
    /// The real take described by the file at `path`.
    fn read(path: &Path) -> Result<Recorded, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let take: RealTake = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let base = path.parent().unwrap_or(Path::new("."));
        let gabc_path = base.join(&take.gabc);
        let gabc = std::fs::read_to_string(&gabc_path).map_err(|e| format!("{}: {e}", gabc_path.display()))?;
        let mut notes = notes_from_gabc(&gabc, 1.0);
        if notes.len() != take.notes.len() {
            return Err(format!("{}: {} note times for {} notes", take.name, take.notes.len(), notes.len()));
        }
        for (i, (n, [start, end])) in notes.iter_mut().zip(&take.notes).enumerate() {
            if end <= start {
                return Err(format!("{}: note {i} ends at {end} before it starts at {start}", take.name));
            }
            n.start_s = *start;
            n.dur_s = end - start;
        }
        let mut planted = vec![Planted::default(); notes.len()];
        for off in &take.off {
            let p = planted
                .get_mut(off.note)
                .ok_or_else(|| format!("{}: note {} is off but not in the chant", take.name, off.note))?;
            p.cents = off.cents;
        }
        // The page listens before the first note is due, so a take is timed as it would be.
        if let Some(first) = notes.first().filter(|n| n.start_s < PAGE_LEAD_S) {
            return Err(format!(
                "{}: the first note starts at {} s, before the {PAGE_LEAD_S} s the page listens first",
                take.name, first.start_s
            ));
        }
        let (samples, rate) = crate::wav::read_mono(&base.join(&take.audio))?;
        Ok(Recorded {
            name: take.name,
            notes,
            planted,
            samples,
            rate,
        })
    }
}

/// Where each real take is stopped short in `real-takes-stopped`: halfway through the middle
/// note of its first, second, middle and last phrases (each once), as the notes' indices. The
/// first leaves no phrase finished, the second only one, the last all but one.
fn stop_notes(notes: &[Note]) -> Vec<usize> {
    let Some(last) = notes.last() else { return Vec::new() };
    let phrases = last.phrase as usize + 1;
    let mut chosen = vec![0, 1, phrases / 2, phrases - 1];
    chosen.retain(|&p| p < phrases);
    chosen.sort_unstable();
    chosen.dedup();
    chosen
        .into_iter()
        .filter_map(|p| {
            let first = notes.iter().position(|n| n.phrase as usize == p)?;
            let last = notes.iter().rposition(|n| n.phrase as usize == p)?;
            Some((first + last).div_ceil(2))
        })
        .collect()
}

/// A real take judged: whole, or with `stop`, stopped halfway through the note given, as
/// the page judges it there, beside the verdict on it whole.
fn judge_real(ear: &Ear, oracle: Option<&Oracle>, take: &Recorded, stop: Option<(usize, &Verdict)>) -> Result<Judged, String> {
    let len = match stop {
        None => take.samples.len(),
        Some((k, _)) => {
            let n = &take.notes[k];
            (((n.start_s + n.dur_s / 2.0) * take.rate).round() as usize).min(take.samples.len())
        }
    };
    let samples = &take.samples[..len];
    let frames = ear.listen(samples, take.rate, None)?;
    let (name, notes, report, verdict, stop) = match stop {
        None => {
            let report = score(&take.notes, &frames);
            let verdict = judge(&take.notes, &report);
            (format!("{REAL} {}", take.name), take.notes.clone(), report, verdict, None)
        }
        Some((k, whole)) => {
            let through = through_heard(&take.notes, len as f32 / take.rate);
            // A take stopped before its first note ended is not judged at all.
            let sung = if through.is_some() { take.notes.clone() } else { Vec::new() };
            let shown = cantor_ear::judge_notes(sung, &frames, through);
            let stop = Stop::of(&take.notes, &take.planted, through, &shown, whole.clone());
            let name = format!("{REAL_STOPPED} {} in note {k}", take.name);
            (name, shown.notes, shown.report, shown.verdict, Some(stop))
        }
    };
    let oracle = match oracle {
        Some(_) if notes.is_empty() => Some(OracleTake::of(&notes, &[])),
        Some(o) => Some(OracleTake::of(&notes, &o.label(samples, take.rate, &notes, &frames)?)),
        None => None,
    };
    let timing = Timing::of(&take.notes, stop.is_some(), samples, take.rate, &frames, &verdict, false);
    let len = notes.len();
    Ok(Judged {
        name,
        notes,
        planted: take.planted[..len].to_vec(),
        truth: vec![None; len],
        true_key: None,
        planted_drift: 0.0,
        frames,
        verdict,
        report,
        oracle,
        timing,
        stop,
    })
}

/// Every suite in `dir`, by file name. A suite's keys other than `name`, `gate` and `takes`
/// are defaults for its takes; an unknown key is an error, so a typo cannot silently plant
/// nothing.
fn load_suites(dir: &Path) -> Result<Vec<Suite>, String> {
    let known = known_take_keys();
    json_files(dir)?
        .iter()
        .map(|p| {
            let err = |e: String| format!("{}: {e}", p.display());
            let text = std::fs::read_to_string(p).map_err(|e| err(e.to_string()))?;
            let Value::Object(mut obj) = serde_json::from_str(&text).map_err(|e| err(e.to_string()))? else {
                return Err(err("not an object".into()));
            };
            let name = obj
                .remove("name")
                .and_then(|v| v.as_str().map(String::from))
                .ok_or_else(|| err("no name".into()))?;
            let gate: Gate = match obj.remove("gate") {
                Some(v) => serde_json::from_value(v).map_err(|e| err(e.to_string()))?,
                None => Gate::None,
            };
            let takes = match obj.remove("takes") {
                Some(Value::Array(takes)) => takes,
                Some(_) => return Err(err("takes is not a list".into())),
                None => vec![Value::Object(Default::default())],
            };
            let takes = takes
                .into_iter()
                .map(|t| {
                    let Value::Object(t) = t else {
                        return Err(err("a take is not an object".into()));
                    };
                    let mut merged = obj.clone();
                    merged.extend(t);
                    if let Some(k) = merged.keys().find(|k| !known.contains(k)) {
                        return Err(err(format!("unknown key {k}")));
                    }
                    serde_json::from_value(Value::Object(merged)).map_err(|e| err(e.to_string()))
                })
                .collect::<Result<_, _>>()?;
            Ok(Suite { name, gate, takes })
        })
        .collect()
}

/// The keys a take may have: its own and the profile's.
fn known_take_keys() -> Vec<String> {
    let mut keys: Vec<String> = ["gabc", "pulse_s", "seed", "lead_in_s", "through"].map(String::from).to_vec();
    if let Ok(Value::Object(p)) = serde_json::to_value(Profile::default()) {
        keys.extend(p.keys().cloned());
    }
    keys
}

/// Every `*.json` in `dir`, sorted.
fn json_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let err = |e: std::io::Error| format!("{}: {e}", dir.display());
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .map_err(err)?
        .map(|e| e.map(|e| e.path()))
        .collect::<Result<_, _>>()
        .map_err(err)?;
    paths.retain(|p| p.extension().is_some_and(|x| x == "json"));
    paths.sort();
    Ok(paths)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The page's ear, run natively on the take `ear.spec.ts` plays, at the rates a browser
    /// runs at, with its frames falling at quarter hops against the notes as the page's might:
    /// it hears and marks the take as the eval does, within the e2e test's tolerances.
    #[test]
    fn the_browser_ear_hears_a_take_as_the_eval_does_wherever_its_frames_fall() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let ear = Ear::new(false).expect("ear");
        let marks = |v: &Verdict| v.marks.iter().map(|m| (m.kind, m.first, m.last)).collect::<Vec<_>>();
        for rate in [44_100.0, 48_000.0] {
            let (samples, want) = take(&root, &ear, "student-notes", 0, rate).expect("take");
            assert!(!want.verdict.marks.is_empty());
            let hop = (cantor_core::pitch::DEFAULT_HOP_S * rate).round() as usize;
            for quarter in 0..4 {
                let mut padded = vec![0.0; quarter * hop / 4];
                padded.extend(&samples);
                let mut hearing = cantor_ear::Hearing::new(rate).expect("rate");
                for block in padded.chunks(1_024) {
                    hearing.push(block).expect("push");
                }
                let heard = hearing.finish().expect("heard");
                let offset = want.lead_in_s + heard.onset.expect("sound") - want.onset_s.expect("sound");
                let got = cantor_ear::judge_gabc(&want.gabc, want.pulse_s, offset, &heard.frames, None);
                let at = format!("{rate} Hz, {quarter}/4 hop");
                let heard = (got.report.heard_fraction - want.report.heard_fraction).abs();
                let key = (got.verdict.key_cents.expect("key") - want.verdict.key_cents.expect("key")).abs();
                assert!(heard <= 0.02, "{at}: heard {heard} apart");
                assert!(key <= 10.0, "{at}: key {key} cents apart");
                assert_eq!(marks(&got.verdict), marks(&want.verdict), "{at}");
                assert_eq!(got.summary, want.summary, "{at}");
                // Note by note, the ribbon the page draws is the eval's.
                assert_eq!(got.ribbon.len(), want.ribbon.len(), "{at}");
                let (mut apart, mut both) = (0, 0);
                for (g, w) in got.ribbon.iter().zip(&want.ribbon) {
                    match (g.cents, w.cents) {
                        (Some(a), Some(b)) => {
                            both += 1;
                            assert!((a - b).abs() <= BAND_CENTS, "{at}: note {} {a} vs {b}", g.index);
                            let (a, b) = (trace_median(&g.trace), trace_median(&w.trace));
                            assert!((a - b).abs() <= BAND_CENTS, "{at}: note {} trace {a} vs {b}", g.index);
                        }
                        (None, None) => {}
                        _ => apart += 1,
                    }
                }
                assert!(both > 0, "{at}");
                assert!(apart <= want.ribbon.len().div_ceil(50), "{at}: {apart} notes heard by one ear only");
            }
        }
    }

    /// Notes in the phrases given, a note to each, two phrases a verse.
    fn phrased(phrases: &[u32]) -> Vec<Note> {
        phrases
            .iter()
            .enumerate()
            .map(|(i, &phrase)| Note {
                phrase,
                verse: phrase / 2,
                ..Note::new(60.0, i as f32, 0.9)
            })
            .collect()
    }

    #[test]
    fn the_runs_sung_again_are_the_first_second_middle_and_last_phrases_and_the_middle_s_verse_each_once() {
        // Two phrases a verse.
        let runs = again_runs(&phrased(&[0, 0, 1, 1, 2, 2, 3, 4, 4, 4]));
        assert_eq!(runs, [0..2, 2..4, 4..6, 4..7, 7..10]);
        // A chant of two phrases sings each once, and its verse; of one, it once.
        assert_eq!(again_runs(&phrased(&[0, 0, 1])), [0..2, 0..3, 2..3]);
        assert_eq!(again_runs(&phrased(&[0, 0])), [Range { start: 0, end: 2 }]);
        assert!(again_runs(&[]).is_empty());
        // A phrase no note is in has no run, nor a verse.
        assert_eq!(again_runs(&phrased(&[0, 2, 2])), [0..1, 1..3]);
    }

    /// How far a note's band may be from the eval's wherever the frames fall, in cents; the
    /// browser test (`ear.spec.ts`) allows a little more for the browser's capture.
    const BAND_CENTS: f32 = 20.0;

    fn trace_median(trace: &[(f32, f32)]) -> f32 {
        let mut values: Vec<f32> = trace.iter().map(|p| p.1).collect();
        values.sort_by(f32::total_cmp);
        values[values.len() / 2]
    }

    /// A take written as a real take is (its chant, audio and note times beside it) is heard
    /// as the eval heard it, so a recording's ribbon is the one the eval would draw.
    #[test]
    fn a_recording_is_the_ribbon_of_its_take() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let ear = Ear::new(false).expect("ear");
        let suites = load_suites(&root.join("evals/suites")).expect("suites");
        let spec = &suites.iter().find(|s| s.name == "expert-lead").expect("suite").takes[0];
        let judged = run_take(&root, &ear, None, spec, "recording".into()).expect("take");
        let samples = render_take(&judged.notes, &spec.profile, SAMPLE_RATE, spec.seed).samples;
        let dir = std::env::temp_dir().join(format!("cantor-recording-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::copy(root.join(&spec.gabc), dir.join("chant.gabc")).expect("gabc");
        crate::wav::write_mono(&dir.join("take.wav"), &samples, SAMPLE_RATE).expect("wav");
        let notes: Vec<[f32; 2]> = judged.notes.iter().map(|n| [n.start_s, n.start_s + n.dur_s]).collect();
        let file = serde_json::json!({ "name": "take", "gabc": "chant.gabc", "audio": "take.wav", "notes": notes });
        std::fs::write(dir.join("take.json"), file.to_string()).expect("json");
        let got = recording(&ear, &dir.join("take.json"));
        std::fs::remove_dir_all(&dir).expect("clean");
        let got = got.expect("recording");
        let want = cantor_core::ribbon(&judged.notes, &judged.frames, &judged.report, &judged.verdict);
        assert_eq!(got.len(), want.len());
        assert!(want.iter().filter(|b| !b.trace.is_empty()).count() * 10 >= want.len() * 9);
        for (g, w) in got.iter().zip(&want) {
            assert_eq!(
                (g.index, g.cents.is_some(), g.trace.len()),
                (w.index, w.cents.is_some(), w.trace.len())
            );
            assert!((g.from_s - w.from_s).abs() < 1e-4 && (g.to_s - w.to_s).abs() < 1e-4);
            assert!((g.start_s - w.start_s).abs() < 1e-4 && (g.end_s - w.end_s).abs() < 1e-4);
            assert!(g.cents.zip(w.cents).is_none_or(|(g, w)| (g - w).abs() < 0.5), "{g:?} {w:?}");
        }
    }

    #[test]
    fn every_suite_loads() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let suites = load_suites(&root.join("evals/suites")).expect("suites");
        assert!(suites.iter().any(|s| s.gate == Gate::Expert));
        assert!(suites.iter().any(|s| s.gate == Gate::Student));
        assert!(suites.iter().any(|s| s.gate == Gate::Silent));
        assert!(suites.iter().any(|s| s.gate == Gate::Wrong));
        // Takes are stopped mid-phrase, at a division and before a phrase finished, good ones and
        // ones with faults planted before and after the stop.
        let (mut mid, mut division, mut unfinished, mut faulted) = (0, 0, 0, 0);
        for suite in &suites {
            for spec in &suite.takes {
                let Some(through) = spec.through else { continue };
                let notes = notes_from_gabc(&std::fs::read_to_string(root.join(&spec.gabc)).expect("gabc"), spec.pulse_s);
                assert!(through + 1 < notes.len(), "{}: stopped on its last note", suite.name);
                let end = phrase_end(&notes, through);
                match end {
                    0 => unfinished += 1,
                    e if e == through + 1 => division += 1,
                    _ => mid += 1,
                }
                let planted = spec.profile.planted(&notes);
                let fault: Vec<usize> = faults(&notes, &planted).collect();
                faulted += usize::from(fault.iter().any(|&i| i < end) && fault.iter().any(|&i| i > through));
            }
        }
        assert!(
            mid >= 2 && division >= 2 && unfinished >= 2 && faulted >= 2,
            "{mid} {division} {unfinished} {faulted}"
        );
    }

    /// The psalm the suites sing, timed as `cantor eval` times it.
    fn psalm() -> Vec<Note> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        notes_from_gabc(
            &std::fs::read_to_string(root.join("evals/chants/psalm-117.gabc")).expect("gabc"),
            0.45,
        )
    }

    #[test]
    fn the_page_reads_the_last_note_sung_whole_from_the_takes_length() {
        let notes = psalm();
        let mid = |n: &Note| n.start_s + n.dur_s / 2.0;
        assert_eq!(through_heard(&notes, 0.0), None);
        assert_eq!(through_heard(&notes, mid(&notes[0])), None, "the first note not yet ended");
        assert_eq!(through_heard(&notes, notes[0].end_s()), Some(0));
        assert_eq!(through_heard(&notes, mid(&notes[21])), Some(20));
        // In the pause after a phrase, and halfway through the next phrase's first note.
        assert_eq!(through_heard(&notes, notes[13].end_s() + 0.5), Some(13));
        assert_eq!(through_heard(&notes, mid(&notes[14])), Some(13));
        assert_eq!(through_heard(&notes, 1e4), Some(notes.len() - 1));
    }

    #[test]
    fn the_eval_reads_the_phrases_finished_as_the_ear_judges_them() {
        // Every stop in every chant the suites sing, and a chant whose first phrase is one note.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut chants: Vec<Vec<Note>> = load_suites(&root.join("evals/suites"))
            .expect("suites")
            .iter()
            .flat_map(|s| &s.takes)
            .map(|t| notes_from_gabc(&std::fs::read_to_string(root.join(&t.gabc)).expect("gabc"), t.pulse_s))
            .collect();
        chants.push(notes_from_gabc("(c4) A(g) (,) men(h)i(g) (:) al(f)le(g)lu(h)ia.(g) (::)", 0.5));
        for notes in &chants {
            for through in 0..notes.len() + 2 {
                assert_eq!(phrase_end(notes, through), cantor_ear::finished(notes, Some(through)), "{through}");
            }
        }
        let psalm = psalm();
        assert_eq!(phrase_end(&psalm, 5), 0, "in the first phrase");
        assert_eq!(phrase_end(&psalm, 7), 8, "at its end");
        assert_eq!(phrase_end(&psalm, 20), 14, "mid-phrase: the phrases before");
        assert_eq!(phrase_end(&psalm, 82), 83);
        assert_eq!(phrase_end(&[], 3), 0);
    }

    #[test]
    fn a_take_stopped_ends_halfway_through_the_next_note() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let spec = TakeSpec {
            gabc: "evals/chants/scale.gabc".into(),
            pulse_s: 0.5,
            seed: 1,
            lead_in_s: 1.0,
            through: Some(20),
            profile: Profile::default(),
        };
        let (_, notes, take, heard) = render_spec(&root, &spec).expect("take");
        let heard = heard.expect("stopped");
        let next = &notes[21];
        assert_eq!(heard, ((next.start_s + next.dur_s / 2.0) * SAMPLE_RATE).round() as usize);
        assert!(heard < take.samples.len());
        assert!(
            take.samples[heard - 100..heard].iter().any(|s| s.abs() > 0.01),
            "cut while the note sounds"
        );
        assert_eq!(through_heard(&notes, heard as f32 / SAMPLE_RATE), Some(20));
        let past = TakeSpec { through: Some(39), ..spec };
        assert!(render_spec(&root, &past).is_err(), "stopped on the last note is not stopped short");
    }

    /// Frames as a tracker hears `notes` sung each `cents[i]` off (0 past the list), every hop
    /// until `heard_s`, silent between notes.
    fn heard(notes: &[Note], cents: &[f32], heard_s: f32) -> Vec<Frame> {
        let hop = cantor_core::pitch::DEFAULT_HOP_S;
        (0..)
            .map(|k| k as f32 * hop)
            .take_while(|&t| t < heard_s)
            .map(|t| {
                let sung = notes.iter().position(|n| n.start_s <= t && t < n.end_s());
                Frame {
                    t,
                    midi: sung.map(|i| notes[i].midi + cents.get(i).copied().unwrap_or(0.0) / 100.0),
                    clarity: if sung.is_some() { 0.95 } else { 0.0 },
                    rms: if sung.is_some() { 0.1 } else { 0.0 },
                    masked: false,
                    quiet: sung.is_none(),
                    other: None,
                }
            })
            .collect()
    }

    /// `chant` sung `cents` off by note and stopped after note `through`, halfway through the
    /// next, judged as `cantor eval` judges it; `whole`, the verdict on it sung whole.
    fn stopped(chant: &[Note], cents: &[f32], through: usize, whole: Verdict) -> Judged {
        stopped_as(chant, cents, through, whole, |frames, through| {
            cantor_ear::judge_notes(chant.to_vec(), frames, through)
        })
    }

    /// [`stopped`], judged by `judged` on the frames heard and the note the page reads as the
    /// last sung whole.
    fn stopped_as(
        chant: &[Note],
        cents: &[f32],
        through: usize,
        whole: Verdict,
        judged: impl FnOnce(&[Frame], Option<usize>) -> cantor_ear::Judged,
    ) -> Judged {
        let next = &chant[through + 1];
        let heard_s = next.start_s + next.dur_s / 2.0;
        let frames = heard(chant, cents, heard_s);
        let through = through_heard(chant, heard_s);
        let shown = judged(&frames, through);
        let planted: Vec<Planted> = (0..chant.len())
            .map(|i| Planted {
                cents: cents.get(i).copied().unwrap_or(0.0),
                silent: false,
            })
            .collect();
        let stop = Stop::of(chant, &planted, through, &shown, whole);
        let n = shown.notes.len();
        let on_time = Retimed {
            entry: Entry {
                due: 0.0,
                sound: None,
                at: 0.0,
            },
            kept: true,
        };
        Judged {
            name: format!("stopped after {through:?}"),
            planted: planted[..n].to_vec(),
            truth: vec![None; n],
            true_key: None,
            planted_drift: 0.0,
            frames,
            notes: shown.notes,
            verdict: shown.verdict,
            report: shown.report,
            oracle: None,
            timing: Timing { on_time, late: Vec::new() },
            stop: Some(stop),
        }
    }

    /// The verdict on `chant` sung whole, each note `cents` off.
    fn whole(chant: &[Note], cents: &[f32]) -> Verdict {
        let end = chant.last().map_or(0.0, Note::end_s) + 0.5;
        judge(chant, &score(chant, &heard(chant, cents, end)))
    }

    #[test]
    fn a_take_stopped_is_judged_to_the_last_phrase_finished_and_no_further() {
        // The scale, faults planted before the stop (notes 9 and 12), in the phrase it cut short
        // (17, sung) and after it (33).
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let chant = notes_from_gabc(&std::fs::read_to_string(root.join("evals/chants/scale.gabc")).expect("gabc"), 0.5);
        let mut cents = vec![0.0; chant.len()];
        for (i, c) in [(9, 200.0), (12, -200.0), (17, 200.0), (33, 220.0)] {
            cents[i] = c;
        }
        let take = stopped(&chant, &cents, 20, whole(&chant, &cents));
        let first = stopped(&chant, &cents, 3, whole(&chant, &cents));
        let m = Metrics::of(&[take, first]);
        let s = m.stopped.expect("stopped");
        assert_eq!((s.takes, s.unfinished, s.misjudged, s.told_unfinished), (2, 1, 0, 0));
        assert_eq!(
            (s.cut_faults, s.cut_caught),
            (6, 0),
            "17 and 33, and 9 and 12 stopped before, never caught"
        );
        assert_eq!((s.compared, s.otherwise), (1, 0));
        assert_eq!((m.faults, m.recall), (2, 1.0), "the faults before the stop are caught");
        assert_eq!(m.unjudged, 0, "a take with nothing to judge is not a take not heard");
        assert!(m.worst_take_heard > 0.9);
        assert!(m.gate_failures(Gate::Student).is_empty(), "{:?}", m.gate_failures(Gate::Student));
        assert!(m.agreement_failures().is_empty());

        // A judge that ignored the stop, judging the whole take, is caught out.
        let ignored = stopped_as(&chant, &cents, 20, whole(&chant, &cents), |_, _| {
            cantor_ear::judge_notes(chant.clone(), &heard(&chant, &cents, 30.0), None)
        });
        let s = Metrics::of(&[ignored]).stopped.expect("stopped");
        assert_eq!((s.misjudged, s.cut_caught), (1, 2));

        // One told anything for a take stopped before a phrase finished is caught out.
        let mut told = stopped(&chant, &cents, 3, whole(&chant, &cents));
        told.verdict.key_cents = Some(0.0);
        let m = Metrics::of(&[told]);
        assert_eq!(m.stopped.expect("stopped").told_unfinished, 1);
        assert_eq!(m.gate_failures(Gate::None).len(), 1);

        // And a take stopped judged otherwise than sung whole: a fault there it was not sung
        // with, or another key.
        let clean = whole(&chant, &[]);
        let other = stopped(&chant, &cents, 20, clean);
        let mut sharp = whole(&chant, &cents);
        sharp.key_cents = sharp.key_cents.map(|k| k + 80.0);
        let apart = stopped(&chant, &cents, 20, sharp);
        let m = Metrics::of(&[other, apart]);
        let s = m.stopped.expect("stopped");
        assert_eq!(s.otherwise, 1);
        assert!((s.key_apart_cents - 80.0).abs() < 1e-3, "{}", s.key_apart_cents);
        assert_eq!(m.agreement_failures().len(), 2);

        // Or a note heard sung whole lost stopped, however few it is of the notes judged.
        let unheard_5 = |frames: &[Frame], through: Option<usize>| {
            let note = &chant[5];
            let gap: Vec<Frame> = frames
                .iter()
                .filter(|f| f.t < note.start_s || f.t >= note.end_s())
                .cloned()
                .collect();
            cantor_ear::judge_notes(chant.to_vec(), &gap, through)
        };
        let lost = stopped_as(&chant, &cents, 20, whole(&chant, &cents), unheard_5);
        assert!(lost.verdict.relative[5].is_none());
        let m = Metrics::of(&[lost]);
        assert_eq!(m.stopped.expect("stopped").lost, 1);
        assert_eq!(m.agreement_failures(), ["1 notes heard sung whole not heard stopped"]);
        // But not a note planted silent, which the take sung whole should not have heard.
        let mut silent = stopped_as(&chant, &cents, 20, whole(&chant, &cents), unheard_5);
        silent.planted[5].silent = true;
        assert_eq!(Metrics::of(&[silent]).stopped.expect("stopped").lost, 0);
    }

    #[test]
    fn a_take_is_held_to_its_share_of_notes_heard_or_stopped_all_but_one_of_a_few() {
        assert_eq!(take_floor(62, false), 56);
        assert_eq!(take_floor(62, true), 56);
        assert_eq!(take_floor(10, true), 9);
        // A take sung whole of a few is held to the share; one stopped may miss one.
        assert_eq!(take_floor(9, false), 9);
        assert_eq!(take_floor(6, false), 6);
        assert_eq!(take_floor(6, true), 5);
        assert_eq!(take_floor(1, true), 0);
        assert_eq!(take_floor(0, true), 0);

        // The scale's first phrase of eight, one note unheard: let by stopped, not sung whole.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let chant = notes_from_gabc(&std::fs::read_to_string(root.join("evals/chants/scale.gabc")).expect("gabc"), 0.5);
        let take = |stopped: bool| {
            let mut take = stopped_as(&chant, &[], 9, whole(&chant, &[]), |frames, through| {
                let note = &chant[5];
                let gap: Vec<Frame> = frames
                    .iter()
                    .filter(|f| f.t < note.start_s || f.t >= note.end_s())
                    .cloned()
                    .collect();
                cantor_ear::judge_notes(chant.clone(), &gap, through)
            });
            assert_eq!(take.notes.len(), 8);
            assert!(take.verdict.relative[5].is_none());
            if !stopped {
                take.stop = None;
            }
            take
        };
        assert_eq!(Metrics::of(&[take(true)]).takes_under_floor, 0);
        assert_eq!(Metrics::of(&[take(false)]).takes_under_floor, 1);
    }

    #[test]
    fn a_take_stopped_agrees_with_the_take_sung_whole_mark_by_mark() {
        let chant = psalm();
        let mut cents = vec![0.0; chant.len()];
        // A verse sung a tone high, stopped in its second phrase: its mark runs past the notes
        // judged, and is compared as far as they go.
        for c in &mut cents[45..=61] {
            *c = 200.0;
        }
        let take = stopped(&chant, &cents, 58, whole(&chant, &cents));
        assert_eq!(take.stop.as_ref().map(|s| s.finished), Some(56));
        assert_eq!(take.verdict.marks.len(), 1);
        assert_eq!((take.verdict.marks[0].first, take.verdict.marks[0].last), (45, 55));
        let s = Metrics::of(&[take]).stopped.expect("stopped");
        assert_eq!((s.misjudged, s.otherwise, s.cut_faults, s.cut_caught), (0, 0, 6, 0));
    }

    #[test]
    fn a_mark_is_deserved_by_what_was_planted() {
        let off = Planted {
            cents: 200.0,
            silent: false,
        };
        let clean = Planted::default();
        let mark = |kind, first, last, cents| Mark { kind, first, last, cents };
        let planted = [clean, off, off, clean];
        assert!(deserved(&mark(MarkKind::Note, 1, 1, Some(180.0)), &planted));
        assert!(!deserved(&mark(MarkKind::Note, 1, 1, Some(-180.0)), &planted));
        assert!(!deserved(&mark(MarkKind::Note, 0, 0, Some(180.0)), &planted));
        assert!(!deserved(&mark(MarkKind::Verse, 0, 3, Some(200.0)), &planted));
        assert!(deserved(&mark(MarkKind::Verse, 1, 2, Some(200.0)), &planted));
        assert!(!deserved(&mark(MarkKind::VerseMissing, 0, 3, None), &planted));
        assert!(!deserved(&mark(MarkKind::Note, 7, 7, Some(180.0)), &planted));
        // Planted offsets fold as the judge's errors do: +700 cents is a fourth down.
        let fifth = [Planted {
            cents: 700.0,
            silent: false,
        }];
        assert!(deserved(&mark(MarkKind::Note, 0, 0, Some(-500.0)), &fifth));
    }
}
