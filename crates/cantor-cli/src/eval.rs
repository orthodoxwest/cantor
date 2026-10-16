//! `cantor eval`: every suite in `evals/suites/` is synthesized, tracked and scored; the
//! scorecard is printed, written to `out/eval.json` and compared with `evals/baseline.json`.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::ExitCode;

use cantor_core::{Profile, Report, notes_from_gabc, pitch, render, score, track};
use serde::{Deserialize, Serialize};

use crate::SAMPLE_RATE;

/// A planted offset at least this large counts as a fault to recall.
const PLANTED_CENTS: f32 = 50.0;
/// A measured error at least this large counts as having caught a planted fault.
const CAUGHT_CENTS: f32 = 25.0;
/// A measured error above this on an unplanted note is a false flag.
const FLAG_CENTS: f32 = 50.0;

/// One synthetic suite: a chant, a tempo, a seed and the faults to plant.
#[derive(Debug, Deserialize)]
struct Suite {
    name: String,
    /// The GABC file, relative to the repository root.
    gabc: String,
    pulse_s: f32,
    seed: u64,
    #[serde(flatten)]
    profile: Profile,
}

/// The numbers a suite is judged by.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct Metrics {
    heard_fraction: f32,
    gross_error_rate: f32,
    mean_abs_cents: f32,
    /// Of the notes planted at least `PLANTED_CENTS` off, the fraction heard at least
    /// `CAUGHT_CENTS` off (1 when nothing was planted).
    planted_recall: f32,
    /// Notes with no planted offset heard more than `FLAG_CENTS` off.
    false_flags: u32,
}

impl Metrics {
    fn of(report: &Report, profile: &Profile) -> Metrics {
        let planted = |r: &cantor_core::NoteResult| profile.planted_cents(r.index);
        let faults: Vec<_> = report.notes.iter().filter(|r| planted(r).abs() >= PLANTED_CENTS).collect();
        let caught = faults.iter().filter(|r| r.cents.is_some_and(|c| c.abs() >= CAUGHT_CENTS)).count();
        let planted_recall = if faults.is_empty() {
            1.0
        } else {
            caught as f32 / faults.len() as f32
        };
        let false_flags = report
            .notes
            .iter()
            .filter(|r| planted(r) == 0.0 && r.cents.is_some_and(|c| c.abs() > FLAG_CENTS))
            .count();
        Metrics {
            heard_fraction: report.heard_fraction,
            gross_error_rate: report.gross_error_rate,
            mean_abs_cents: report.mean_abs_cents,
            planted_recall,
            false_flags: false_flags as u32,
        }
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
            "gross_error_rate",
            self.gross_error_rate,
            base.gross_error_rate,
            self.gross_error_rate > base.gross_error_rate + 0.02,
        );
        check(
            "mean_abs_cents",
            self.mean_abs_cents,
            base.mean_abs_cents,
            self.mean_abs_cents > base.mean_abs_cents + 2.0,
        );
        check(
            "planted_recall",
            self.planted_recall,
            base.planted_recall,
            self.planted_recall < base.planted_recall - 0.02,
        );
        check(
            "false_flags",
            self.false_flags as f32,
            base.false_flags as f32,
            self.false_flags > base.false_flags,
        );
        out
    }
}

/// What `out/eval.json` holds for one suite.
#[derive(Serialize)]
struct SuiteOutput {
    name: String,
    metrics: Metrics,
    report: Report,
}

pub fn run(root: &Path, write_baseline: bool) -> Result<ExitCode, String> {
    let suites = load_suites(&root.join("evals/suites"))?;
    let baseline_path = root.join("evals/baseline.json");
    let baseline: BTreeMap<String, Metrics> = match std::fs::read_to_string(&baseline_path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", baseline_path.display()))?,
        Err(_) => BTreeMap::new(),
    };

    let mut outputs = Vec::new();
    let mut scorecard = BTreeMap::new();
    let mut failures = Vec::new();
    println!(
        "{:<14} {:>6} {:>6} {:>8} {:>7} {:>6}",
        "suite", "heard", "gross", "|cents|", "recall", "flags"
    );
    for suite in suites {
        let report = run_suite(root, &suite)?;
        let metrics = Metrics::of(&report, &suite.profile);
        println!(
            "{:<14} {:>6.3} {:>6.3} {:>8.2} {:>7.3} {:>6}",
            suite.name,
            metrics.heard_fraction,
            metrics.gross_error_rate,
            metrics.mean_abs_cents,
            metrics.planted_recall,
            metrics.false_flags
        );
        match baseline.get(&suite.name) {
            Some(base) => failures.extend(metrics.regressions(base).into_iter().map(|r| format!("{}: {r}", suite.name))),
            None => println!("{:<14} (not in the baseline)", ""),
        }
        scorecard.insert(suite.name.clone(), metrics);
        outputs.push(SuiteOutput {
            name: suite.name,
            metrics,
            report,
        });
    }

    let out_dir = root.join("out");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    write_json(&out_dir.join("eval.json"), &outputs)?;
    if write_baseline {
        write_json(&baseline_path, &scorecard)?;
        println!("wrote {}", baseline_path.display());
        return Ok(ExitCode::SUCCESS);
    }
    for f in &failures {
        println!("regression: {f}");
    }
    Ok(if failures.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

fn run_suite(root: &Path, suite: &Suite) -> Result<Report, String> {
    let path = root.join(&suite.gabc);
    let gabc = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let notes = notes_from_gabc(&gabc, suite.pulse_s);
    let samples = render(&notes, &suite.profile, SAMPLE_RATE, suite.seed);
    let hop = (pitch::DEFAULT_HOP_S * SAMPLE_RATE).round() as usize;
    let frames = track(&samples, SAMPLE_RATE, pitch::default_frame(SAMPLE_RATE), hop);
    Ok(score(&notes, &frames))
}

/// Every `*.json` in `dir`, by file name.
fn load_suites(dir: &Path) -> Result<Vec<Suite>, String> {
    let err = |e: std::io::Error| format!("{}: {e}", dir.display());
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .map_err(err)?
        .map(|e| e.map(|e| e.path()))
        .collect::<Result<_, _>>()
        .map_err(err)?;
    paths.retain(|p| p.extension().is_some_and(|x| x == "json"));
    paths.sort();
    paths
        .iter()
        .map(|p| {
            let text = std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?;
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", p.display()))
        })
        .collect()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}
