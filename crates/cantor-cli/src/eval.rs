//! `cantor eval`: the listening gates. Every suite in `evals/suites/` is synthesized,
//! listened to, scored and judged, and checked two ways: against its gate (what the take
//! must and must not be told) and against `evals/baseline.json`, or with `--nsdf-only`
//! `evals/baseline-nsdf.json` (no metric may get worse
//! past its tolerance, and the faults and takes counted must not change). Real takes from a
//! directory given with `--takes` are held to the expert gate; they have no guide and no
//! planted truth, so their tracking error is measured from the judge's own key. The scorecard
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
//!   0.3 s or more heard over the suite and 90% in every take; 90% of all notes heard; a
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
//! each of [`LATE_S`] behind the cursor, its note due that much earlier: it must be timed by
//! the same first sound as on time, within [`SAME_SOUND_S`], and be told the same. Not
//! covered: a singer late behind a guide heard in the take. A synthetic guide sings with the
//! singer, and its cue ends just before the first note, where the page listens only after the
//! cue; on the page the guide's bleed can be the first sound heard. Nor a singer who leads
//! the cursor: the page then times the take as due, as the singer holds the first note until
//! the cursor moves, which a recording sung at its own pace does not.
//!
//! The app's guide plays in the singer's key. The `guide-key` suites play it in another: at
//! -12 dB or quieter an expert is told nothing wrong by either ear; louder, both ears still
//! mark nothing, but the NSDF tracker alone loses notes, and by -6 dB whole takes go
//! unjudged. At -3 dB the guide's pitch can be read as a
//! note and marked, so no suite plays it that loud: masking frames at the guide's pitch would
//! stop it, but would mask a singer in unison with a loud guide too, which is the app's case.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use cantor_core::score::fold;
use cantor_core::synth::{GuideMode, cue_span};
use cantor_core::{
    Cadence, Entry, Frame, Guide, Mark, MarkKind, Note, Outcome, Planted, Profile, Verdict, judge, notes_from_gabc, render_take, score,
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
const ALL_HEARD_FLOOR: f32 = 0.9;
const RECALL_FLOOR: f32 = 0.95;
const KEY_TOLERANCE: f32 = 50.0;
const SILENT_CEILING: f32 = 0.01;
/// Two trackers agree on a frame within this many cents, octaves aside.
const AGREEMENT_CENTS: f32 = 50.0;
/// The name real takes are reported under.
const REAL: &str = "real-takes";

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
}

/// How far behind the cursor a singer is taken to be, in seconds, when a take is timed as
/// the page times it: its first note falls due this long before it was sung.
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
    /// `guided`: the guide is heard in the take.
    fn of(notes: &[Note], samples: &[f32], rate: f32, frames: &[Frame], verdict: &Verdict, guided: bool) -> Timing {
        let start = notes.first().map_or(0.0, |n| n.start_s);
        let live = cantor_core::live(samples, rate);
        let loud = cantor_ear::onset(samples, rate);
        let told = |v: &Verdict| {
            let marks: Vec<_> = v.marks.iter().map(|m| (m.kind, m.first, m.last)).collect();
            (v.outcome, v.steady, marks)
        };
        // A cadence on pitch one way and not clearly heard the other is not told otherwise,
        // only not counted; one called off pitch must be called off both ways.
        let contradicts = |a: &Verdict, b: &Verdict| {
            a.cadences.len() != b.cadences.len()
                || a.cadences
                    .iter()
                    .zip(&b.cadences)
                    .any(|(x, y)| (x.first, x.last) != (y.first, y.last) || (x.on_pitch() == Some(false)) != (y.on_pitch() == Some(false)))
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
            let again = judge(&moved, &score(&moved, frames));
            Retimed {
                entry,
                kept: told(&again) == told(verdict) && !contradicts(&again, verdict),
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
    /// Takes timed as for a singer [`LATE_S`] behind the cursor, and those of them the page
    /// would time by the first sound it times them by on time; and takes told otherwise when
    /// timed as the page times them, any way.
    timed_late: u32,
    timed_by_sound: u32,
    timing_moved_marks: u32,
    /// Notes heard in tune, over all takes.
    in_tune: u32,
    /// Of the frames the NSDF tracker found clear and SwiftF0 also voiced, the fraction
    /// within [`AGREEMENT_CENTS`] of each other, octaves aside; none when SwiftF0 did not listen.
    agreement: Option<f32>,
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
        for take in takes {
            for f in &take.frames {
                if let (Some(m), Some(o)) = (f.midi, f.other)
                    && f.clarity >= cantor_core::pitch::DEFAULT_MIN_CLARITY
                {
                    both += 1;
                    agreed += usize::from(fold((m - o) * 100.0).abs() <= AGREEMENT_CENTS);
                }
            }
            let v = &take.verdict;
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
            m.timed_late += u32::from(!take.timing.late.is_empty());
            m.timed_by_sound += u32::from(take.timing.by_sound());
            m.timing_moved_marks += u32::from(!take.timing.kept());
        }
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
                    self.worst_take_heard >= TAKE_HEARD_FLOOR,
                    format!("a take heard {:.3} < {TAKE_HEARD_FLOOR}", self.worst_take_heard),
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
        // SwiftF0 going deaf on a suite would otherwise drop its agreement from the gate.
        if let (None, Some(was)) = (self.agreement, base.agreement) {
            out.push(format!("agreement {was:.3} -> none: SwiftF0 compared no frames"));
        }
        out
    }
}

/// The notes a mark must catch: planted at least [`FLAGRANT_CENTS`] off (octave-agnostic),
/// long enough and past the first phrase, or in a verse planted silent throughout.
fn faults<'a>(notes: &'a [Note], planted: &'a [Planted]) -> impl Iterator<Item = usize> + 'a {
    (0..notes.len()).filter(move |&i| {
        let p = &planted[i];
        if p.silent {
            let verse: Vec<usize> = (0..notes.len()).filter(|&j| notes[j].verse == notes[i].verse).collect();
            verse.len() >= 3 && verse.iter().all(|&j| planted[j].silent)
        } else {
            fold(p.cents).abs() >= FLAGRANT_CENTS && notes[i].dur_s >= FLAGRANT_MIN_S && notes[i].phrase > 0
        }
    })
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
}

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
    if let Some(dir) = takes_dir.filter(|_| only.is_none_or(|o| o == REAL)) {
        let judged = load_real_takes(ear, oracle, dir)?;
        if judged.is_empty() {
            return Err(format!("{}: no takes", dir.display()));
        }
        suites.push((REAL.into(), Gate::Expert, judged));
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
    for (name, gate, judged) in &suites {
        let metrics = Metrics::of(judged);
        let oracle = OracleStats::of(judged);
        let gated = metrics.gate_failures(*gate);
        let mut moved = Vec::new();
        // Real takes are held to their gate only: the set and its audio live elsewhere.
        if name != REAL {
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
                })
                .collect(),
        });
    }
    // A suite the baseline holds must still exist: deleting a hard suite is not a pass.
    for name in baseline.keys().filter(|n| !scorecard.contains_key(*n)) {
        baseline_failures.push(format!("{name}: in the baseline but not in evals/suites"));
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

fn run_take(root: &Path, ear: &Ear, oracle: Option<&Oracle>, spec: &TakeSpec, name: String) -> Result<Judged, String> {
    let path = root.join(&spec.gabc);
    let gabc = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut notes = notes_from_gabc(&gabc, spec.pulse_s);
    for n in &mut notes {
        n.start_s += spec.lead_in_s;
    }
    let profile = &spec.profile;
    let take = render_take(&notes, profile, SAMPLE_RATE, spec.seed);
    // The app knows when it played the cue; with none, the guide's bleed cannot be measured.
    let guide = take.guide.as_deref().map(|samples| Guide {
        samples,
        alone: cue_span(&notes).unwrap_or((0.0, 0.0)),
    });
    let frames = ear.listen(&take.samples, SAMPLE_RATE, guide)?;
    let report = score(&notes, &frames);
    let oracle = match oracle {
        Some(o) => Some(OracleTake::of(&notes, &o.label(&take.samples, SAMPLE_RATE, &notes, &frames)?)),
        None => None,
    };
    let verdict = judge(&notes, &report);
    let timing = Timing::of(&notes, &take.samples, SAMPLE_RATE, &frames, &verdict, take.guide.is_some());
    let planted = profile.planted(&notes);
    let mid = |n: &Note| n.start_s + n.dur_s / 2.0;
    let truth = notes
        .iter()
        .zip(&planted)
        .map(|(n, p)| (!p.silent).then(|| profile.key_cents + p.cents + profile.drift_cents_per_second * mid(n)))
        .collect();
    // The key at the first verse, where the judge sets it.
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
/// which a file alone does not carry.
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

/// Every take's audio and its rate, named as the eval names it: each suite's synthetic takes,
/// then the real takes in `takes`.
pub fn audio(root: &Path, takes: Option<&Path>) -> Result<Vec<(String, Vec<f32>, f32)>, String> {
    let mut out = Vec::new();
    for suite in load_suites(&root.join("evals/suites"))? {
        for (i, spec) in suite.takes.iter().enumerate() {
            let path = root.join(&spec.gabc);
            let gabc = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let mut notes = notes_from_gabc(&gabc, spec.pulse_s);
            for n in &mut notes {
                n.start_s += spec.lead_in_s;
            }
            let take = render_take(&notes, &spec.profile, SAMPLE_RATE, spec.seed);
            out.push((format!("{}-{i}", suite.name), take.samples, SAMPLE_RATE));
        }
    }
    if let Some(dir) = takes {
        for path in json_files(dir)? {
            let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let take: RealTake = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
            let (samples, rate) = crate::wav::read_mono(&path.parent().unwrap_or(dir).join(&take.audio))?;
            out.push((format!("{REAL} {}", take.name), samples, rate));
        }
    }
    Ok(out)
}

/// `f` over `items` on every core, as the eval runs takes.
pub fn each<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    in_parallel(items, |_, item| f(item))
}

fn load_real_takes(ear: &Ear, oracle: Option<&Oracle>, dir: &Path) -> Result<Vec<Judged>, String> {
    let mut out = Vec::new();
    for path in json_files(dir)? {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let take: RealTake = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let base = path.parent().unwrap_or(dir);
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
        // The page listens before the first note is due, so a take is timed as it would be.
        if let Some(first) = notes.first().filter(|n| n.start_s < PAGE_LEAD_S) {
            return Err(format!(
                "{}: the first note starts at {} s, before the {PAGE_LEAD_S} s the page listens first",
                take.name, first.start_s
            ));
        }
        let (samples, rate) = crate::wav::read_mono(&base.join(&take.audio))?;
        let frames = ear.listen(&samples, rate, None)?;
        let report = score(&notes, &frames);
        let oracle = match oracle {
            Some(o) => Some(OracleTake::of(&notes, &o.label(&samples, rate, &notes, &frames)?)),
            None => None,
        };
        let verdict = judge(&notes, &report);
        let timing = Timing::of(&notes, &samples, rate, &frames, &verdict, false);
        let len = notes.len();
        out.push(Judged {
            name: format!("{REAL} {}", take.name),
            notes,
            planted: vec![Planted::default(); len],
            truth: vec![None; len],
            true_key: None,
            planted_drift: 0.0,
            frames,
            verdict,
            report,
            oracle,
            timing,
        });
    }
    Ok(out)
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
    let mut keys: Vec<String> = ["gabc", "pulse_s", "seed", "lead_in_s"].map(String::from).to_vec();
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
                let got = cantor_ear::judge_gabc(&want.gabc, want.pulse_s, offset, &heard.frames);
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

    /// How far a note's band may be from the eval's wherever the frames fall, in cents; the
    /// browser test (`ear.spec.ts`) allows a little more for the browser's capture.
    const BAND_CENTS: f32 = 20.0;

    fn trace_median(trace: &[(f32, f32)]) -> f32 {
        let mut values: Vec<f32> = trace.iter().map(|p| p.1).collect();
        values.sort_by(f32::total_cmp);
        values[values.len() / 2]
    }

    #[test]
    fn every_suite_loads() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let suites = load_suites(&root.join("evals/suites")).expect("suites");
        assert!(suites.iter().any(|s| s.gate == Gate::Expert));
        assert!(suites.iter().any(|s| s.gate == Gate::Student));
        assert!(suites.iter().any(|s| s.gate == Gate::Silent));
        assert!(suites.iter().any(|s| s.gate == Gate::Wrong));
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
