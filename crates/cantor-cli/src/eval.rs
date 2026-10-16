//! `cantor eval`: the listening gates. Every suite in `evals/suites/` is synthesized,
//! listened to, scored and judged, and checked two ways: against its gate (what the take
//! must and must not be told) and against `evals/baseline.json` (no metric may get worse
//! past its tolerance). Real takes from a directory given with `--takes` run through the
//! expert gate the same way. The scorecard is printed and written to `out/eval.json` and
//! `out/eval.md`.
//!
//! The gates:
//! - `expert`: a good take is told nothing wrong. No marks, at least 95% of the notes of
//!   0.3 s or more heard, a steady reciting tone, and every take judged.
//! - `student`: planted faults a teacher hears across the room are marked. At least 95% of
//!   them caught, no mark on anything not planted, and drift named where it was planted.
//! - `silent`: the guide alone, singer silent. No take judged, no marks, nothing in tune.
//! - `wrong`: a wrong singer over a right guide is marked, as for `student`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use cantor_core::judge::{MARK_CENTS, MARK_MIN_S};
use cantor_core::{Guide, Mark, MarkKind, Note, Outcome, Planted, Profile, Verdict, judge, listen, notes_from_gabc, render_take, score};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::SAMPLE_RATE;

/// A take is told a fault it doesn't have when a mark lands on a note planted less than
/// this far off.
const CLEAR_CENTS: f32 = 100.0;
/// A planted drift at least this large must be named, and one at most `STEADY_DRIFT` must not.
const UNSTEADY_DRIFT: f32 = 90.0;
const STEADY_DRIFT: f32 = 40.0;
/// A heard note further than this from the truth is a tracking gross error.
const GROSS_CENTS: f32 = 50.0;
/// The floors the gates hold.
const HEARD_FLOOR: f32 = 0.95;
const RECALL_FLOOR: f32 = 0.95;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Gate {
    /// Measured and held to the baseline, with no gate of its own.
    #[default]
    None,
    Expert,
    Student,
    Silent,
    Wrong,
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

/// A real take: a recording of a chant with the time each note was sung, judged by the
/// expert gate. Paths are relative to the file.
#[derive(Debug, Deserialize)]
struct RealTake {
    name: String,
    gabc: String,
    audio: String,
    /// `[start, end]` in seconds for each note of the chant, in order.
    notes: Vec<[f32; 2]>,
}

/// One take, ready to judge: its notes, what was planted on them, and the drift planted.
struct Judged {
    notes: Vec<Note>,
    planted: Vec<Planted>,
    /// The truth for each note in cents from the score, when known (synthetic takes).
    truth: Vec<Option<f32>>,
    planted_drift: f32,
    verdict: Verdict,
    report: cantor_core::Report,
}

/// The numbers a suite is judged by.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
struct Metrics {
    takes: u32,
    /// Of the notes of 0.3 s or more that were sung, the fraction heard.
    heard_fraction: f32,
    /// Of the same notes, the fraction masked by the guide's bleed.
    masked_fraction: f32,
    /// The mean distance of heard notes from the truth, in cents (from the key, for real takes).
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
    /// Takes whose steadiness disagrees with the drift planted.
    summary_errors: u32,
    /// Takes given an outcome instead of a judgement.
    unjudged: u32,
    /// Notes heard in tune, over all takes.
    in_tune: u32,
}

impl Metrics {
    fn of(takes: &[Judged]) -> Metrics {
        let mut m = Metrics {
            takes: takes.len() as u32,
            ..Metrics::default()
        };
        let (mut counted, mut heard, mut masked) = (0usize, 0usize, 0usize);
        let (mut errors, mut gross, mut tracked) = (0.0f32, 0usize, 0usize);
        let mut caught = 0u32;
        for take in takes {
            let v = &take.verdict;
            for (i, note) in take.notes.iter().enumerate() {
                let r = &take.report.notes[i];
                if note.dur_s >= cantor_core::judge::HEARD_MIN_S && !take.planted[i].silent {
                    counted += 1;
                    heard += usize::from(r.cents.is_some());
                    masked += usize::from(r.cents.is_none() && r.masked_frames > r.voiced_frames);
                }
                let error = match (r.cents, take.truth[i], v.relative[i]) {
                    (Some(c), Some(t), _) => Some(cantor_core::score::fold(c - t)),
                    (_, None, Some(rel)) => Some(rel),
                    _ => None,
                };
                if let Some(e) = error {
                    errors += e.abs();
                    gross += usize::from(e.abs() > GROSS_CENTS);
                    tracked += 1;
                }
            }
            m.marks += v.marks.len() as u32;
            m.false_marks += v.marks.iter().filter(|mark| !deserved(mark, &take.planted)).count() as u32;
            for i in faults(&take.notes, &take.planted) {
                m.faults += 1;
                caught += u32::from(v.marks.iter().any(|mark| catches(mark, i, &take.planted[i])));
            }
            if v.outcome == Outcome::Heard {
                let wrong =
                    (take.planted_drift.abs() >= UNSTEADY_DRIFT && v.steady) || (take.planted_drift.abs() <= STEADY_DRIFT && !v.steady);
                m.summary_errors += u32::from(wrong);
            } else {
                m.unjudged += 1;
            }
            m.in_tune += v.in_tune as u32;
        }
        let ratio = |a: usize, b: usize| if b == 0 { 0.0 } else { a as f32 / b as f32 };
        m.heard_fraction = ratio(heard, counted);
        m.masked_fraction = ratio(masked, counted);
        m.tracking_cents = if tracked == 0 { 0.0 } else { errors / tracked as f32 };
        m.gross_error_rate = ratio(gross, tracked);
        m.recall = if m.faults == 0 { 1.0 } else { caught as f32 / m.faults as f32 };
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
        match gate {
            Gate::None => {}
            Gate::Expert => {
                need(self.marks == 0, format!("{} marks on good takes", self.marks));
                need(
                    self.heard_fraction >= HEARD_FLOOR,
                    format!("heard {:.3} < {HEARD_FLOOR}", self.heard_fraction),
                );
                need(self.unjudged == 0, format!("{} takes not judged", self.unjudged));
                need(self.summary_errors == 0, format!("{} wrong summaries", self.summary_errors));
            }
            Gate::Student | Gate::Wrong => {
                need(self.false_marks == 0, format!("{} false marks", self.false_marks));
                need(self.recall >= RECALL_FLOOR, format!("recall {:.3} < {RECALL_FLOOR}", self.recall));
                need(self.faults > 0, "no faults planted".into());
                need(self.unjudged == 0, format!("{} takes not judged", self.unjudged));
                need(self.summary_errors == 0, format!("{} wrong summaries", self.summary_errors));
            }
            Gate::Silent => {
                need(
                    self.unjudged == self.takes,
                    format!("{} of {} takes judged", self.takes - self.unjudged, self.takes),
                );
                need(self.marks == 0, format!("{} marks", self.marks));
                need(self.in_tune == 0, format!("{} notes heard in tune", self.in_tune));
            }
        }
        out
    }

    /// Which metrics moved the wrong way beyond tolerance since `base`.
    fn regressions(&self, base: &Metrics) -> Vec<String> {
        let mut out = Vec::new();
        let mut check = |name: &str, now: f32, was: f32, worse: bool| {
            if worse {
                out.push(format!("{name} {was:.3} -> {now:.3}"));
            }
        };
        check(
            "heard_fraction",
            self.heard_fraction,
            base.heard_fraction,
            self.heard_fraction < base.heard_fraction - 0.02,
        );
        check(
            "masked_fraction",
            self.masked_fraction,
            base.masked_fraction,
            self.masked_fraction > base.masked_fraction + 0.02,
        );
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
            "false_marks",
            self.false_marks as f32,
            base.false_marks as f32,
            self.false_marks > base.false_marks,
        );
        out
    }
}

/// The notes a mark must catch: planted at least [`MARK_CENTS`] off, long enough to mark
/// and past the first phrase, or in a verse planted silent throughout.
fn faults<'a>(notes: &'a [Note], planted: &'a [Planted]) -> impl Iterator<Item = usize> + 'a {
    (0..notes.len()).filter(move |&i| {
        let p = &planted[i];
        if p.silent {
            let verse: Vec<usize> = (0..notes.len()).filter(|&j| notes[j].verse == notes[i].verse).collect();
            verse.len() >= 3 && verse.iter().all(|&j| planted[j].silent)
        } else {
            p.cents.abs() >= MARK_CENTS && notes[i].dur_s >= MARK_MIN_S && notes[i].phrase > 0
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
        MarkKind::Note | MarkKind::Verse => !p.silent && mark.cents.is_some_and(|c| c.signum() == p.cents.signum()),
    }
}

/// Whether the notes under `mark` were planted the way it says: for a note mark, its note;
/// for a verse mark, at least half its notes.
fn deserved(mark: &Mark, planted: &[Planted]) -> bool {
    let fits = |p: &Planted| match mark.kind {
        MarkKind::VerseMissing => p.silent,
        MarkKind::Note | MarkKind::Verse => {
            !p.silent && p.cents.abs() >= CLEAR_CENTS && mark.cents.is_some_and(|c| c.signum() == p.cents.signum())
        }
    };
    let under = &planted[mark.first..=mark.last.min(planted.len() - 1)];
    2 * under.iter().filter(|p| fits(p)).count() >= under.len()
}

/// What `out/eval.json` holds for one suite.
#[derive(Serialize)]
struct SuiteOutput<'a> {
    name: &'a str,
    gate: Gate,
    metrics: Metrics,
    failures: Vec<String>,
    takes: Vec<TakeOutput<'a>>,
}

#[derive(Serialize)]
struct TakeOutput<'a> {
    verdict: &'a Verdict,
    report: &'a cantor_core::Report,
}

pub fn run(root: &Path, takes_dir: Option<&Path>, write_baseline: bool) -> Result<ExitCode, String> {
    let mut suites: Vec<(String, Gate, Vec<Judged>)> = Vec::new();
    for suite in load_suites(&root.join("evals/suites"))? {
        let judged = suite.takes.iter().map(|t| run_take(root, t)).collect::<Result<_, _>>()?;
        suites.push((suite.name, suite.gate, judged));
    }
    if let Some(dir) = takes_dir {
        let judged = load_real_takes(dir)?;
        if judged.is_empty() {
            return Err(format!("{}: no takes", dir.display()));
        }
        suites.push(("real-takes".into(), Gate::Expert, judged));
    }

    let baseline_path = root.join("evals/baseline.json");
    let baseline: BTreeMap<String, Metrics> = match std::fs::read_to_string(&baseline_path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", baseline_path.display()))?,
        Err(_) => BTreeMap::new(),
    };

    let header = format!(
        "{:<22} {:<8} {:>5} {:>6} {:>6} {:>7} {:>6} {:>6} {:>6} {:>5}  result",
        "suite", "gate", "takes", "heard", "masked", "|cents|", "gross", "faults", "recall", "false"
    );
    println!("{header}");
    let mut md = String::from(
        "| suite | gate | takes | heard | masked | \\|cents\\| | gross | faults | recall | false marks | result |\n|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|\n",
    );
    let mut scorecard = BTreeMap::new();
    let mut outputs = Vec::new();
    let mut all_failures = Vec::new();
    for (name, gate, judged) in &suites {
        let metrics = Metrics::of(judged);
        let mut failures = metrics.gate_failures(*gate);
        // Real takes are held to their gate only: the set and its audio live elsewhere.
        if name != "real-takes" {
            match baseline.get(name) {
                Some(base) => failures.extend(metrics.regressions(base)),
                None => failures.push("not in the baseline".into()),
            }
            scorecard.insert(name.clone(), metrics);
        }
        let result = if failures.is_empty() {
            "pass".to_string()
        } else {
            format!("FAIL: {}", failures.join("; "))
        };
        let gate_name = serde_json::to_value(gate)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default();
        println!(
            "{:<22} {:<8} {:>5} {:>6.3} {:>6.3} {:>7.2} {:>6.3} {:>6} {:>6.3} {:>5}  {result}",
            name,
            gate_name,
            metrics.takes,
            metrics.heard_fraction,
            metrics.masked_fraction,
            metrics.tracking_cents,
            metrics.gross_error_rate,
            metrics.faults,
            metrics.recall,
            metrics.false_marks,
        );
        md.push_str(&format!(
            "| {name} | {gate_name} | {} | {:.3} | {:.3} | {:.2} | {:.3} | {} | {:.3} | {} | {result} |\n",
            metrics.takes,
            metrics.heard_fraction,
            metrics.masked_fraction,
            metrics.tracking_cents,
            metrics.gross_error_rate,
            metrics.faults,
            metrics.recall,
            metrics.false_marks,
        ));
        all_failures.extend(failures.iter().map(|f| format!("{name}: {f}")));
        outputs.push(SuiteOutput {
            name,
            gate: *gate,
            metrics,
            failures,
            takes: judged
                .iter()
                .map(|j| TakeOutput {
                    verdict: &j.verdict,
                    report: &j.report,
                })
                .collect(),
        });
    }

    let out_dir = root.join("out");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    write_json(&out_dir.join("eval.json"), &outputs)?;
    std::fs::write(out_dir.join("eval.md"), &md).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    if write_baseline {
        write_json(&baseline_path, &scorecard)?;
        println!("wrote {}", baseline_path.display());
        // A new baseline cannot excuse a failed gate.
        all_failures.retain(|f| !f.contains("not in the baseline") && !f.contains(" -> "));
    }
    for f in &all_failures {
        println!("failed: {f}");
    }
    Ok(if all_failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn run_take(root: &Path, spec: &TakeSpec) -> Result<Judged, String> {
    let path = root.join(&spec.gabc);
    let gabc = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut notes = notes_from_gabc(&gabc, spec.pulse_s);
    for n in &mut notes {
        n.start_s += spec.lead_in_s;
    }
    let profile = &spec.profile;
    let take = render_take(&notes, profile, SAMPLE_RATE, spec.seed);
    let guide = take.guide.as_deref().map(|samples| Guide {
        samples,
        alone: (0.0, spec.lead_in_s),
    });
    let frames = listen(&take.samples, SAMPLE_RATE, guide);
    let report = score(&notes, &frames);
    let verdict = judge(&notes, &report);
    let planted = profile.planted(&notes);
    let mid = |n: &Note| n.start_s + n.dur_s / 2.0;
    let truth = notes
        .iter()
        .zip(&planted)
        .map(|(n, p)| (!p.silent).then(|| profile.key_cents + p.cents + profile.drift_cents_per_second * mid(n)))
        .collect();
    let span = match (notes.first(), notes.last()) {
        (Some(a), Some(b)) => mid(b) - mid(a),
        _ => 0.0,
    };
    Ok(Judged {
        planted_drift: profile.drift_over(span),
        notes,
        planted,
        truth,
        verdict,
        report,
    })
}

fn load_real_takes(dir: &Path) -> Result<Vec<Judged>, String> {
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
        for (n, [start, end]) in notes.iter_mut().zip(&take.notes) {
            n.start_s = *start;
            n.dur_s = end - start;
        }
        let (samples, rate) = crate::wav::read_mono(&base.join(&take.audio))?;
        let frames = listen(&samples, rate, None);
        let report = score(&notes, &frames);
        let verdict = judge(&notes, &report);
        let len = notes.len();
        out.push(Judged {
            notes,
            planted: vec![Planted::default(); len],
            truth: vec![None; len],
            planted_drift: 0.0,
            verdict,
            report,
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
        assert!(deserved(&mark(MarkKind::Verse, 0, 3, Some(200.0)), &planted));
        assert!(!deserved(&mark(MarkKind::VerseMissing, 0, 3, None), &planted));
    }
}
