//! The `cantor` command: offline work on takes. `pitch` tracks a WAV or FLAC file, `synth`
//! renders a chant with planted faults, `eval` runs the listening gates and the baseline.

#![forbid(unsafe_code)]

mod eval;
mod explain;
mod wav;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use cantor_core::{Profile, listen, notes_from_gabc, render};

/// The sample rate synthetic takes are rendered and tracked at.
const SAMPLE_RATE: f32 = 16_000.0;

const USAGE: &str = "usage: cantor pitch FILE.wav
       cantor synth CHANT.gabc --tempo PULSE_SECONDS --seed N [--cents a,b,c...] -o OUT.wav
       cantor eval [--takes DIR] [--write-baseline]
       cantor explain SUITE [--takes DIR]
       cantor version";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("cantor: {e}");
            ExitCode::from(2)
        }
    }
}

fn run(args: &[String]) -> Result<ExitCode, String> {
    let rest = &args[1.min(args.len())..];
    match args.first().map(String::as_str) {
        Some("version") | None => println!("cantor {}", env!("CARGO_PKG_VERSION")),
        Some("pitch") => pitch_cmd(rest)?,
        Some("synth") => synth_cmd(rest)?,
        Some("eval") => return eval_cmd(rest),
        Some("explain") => return explain_cmd(rest),
        Some("-h" | "--help") => println!("{USAGE}"),
        Some(other) => return Err(format!("unknown command: {other}\n{USAGE}")),
    }
    Ok(ExitCode::SUCCESS)
}

/// Tracks a WAV file and prints one JSON frame per line.
fn pitch_cmd(args: &[String]) -> Result<(), String> {
    let [file] = args else { return Err(USAGE.into()) };
    let (samples, rate) = wav::read_mono(Path::new(file))?;
    let mut out = String::new();
    for frame in listen(&samples, rate, None) {
        out.push_str(&serde_json::to_string(&frame).map_err(|e| e.to_string())?);
        out.push('\n');
    }
    print!("{out}");
    Ok(())
}

/// Renders a chant with planted faults to a WAV file.
fn synth_cmd(args: &[String]) -> Result<(), String> {
    let mut chant = None;
    let mut pulse_s = None;
    let mut seed = None;
    let mut out = None;
    let mut profile = Profile::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = || it.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--tempo" => pulse_s = Some(value()?.parse::<f32>().map_err(|e| format!("--tempo: {e}"))?),
            "--seed" => seed = Some(value()?.parse::<u64>().map_err(|e| format!("--seed: {e}"))?),
            "--cents" => {
                profile.cents_offset_per_note = value()?
                    .split(',')
                    .map(|c| c.trim().parse::<f32>().map_err(|e| format!("--cents: {e}")))
                    .collect::<Result<_, _>>()?;
            }
            "-o" | "--out" => out = Some(PathBuf::from(value()?)),
            _ if chant.is_none() && !arg.starts_with('-') => chant = Some(PathBuf::from(arg)),
            _ => return Err(format!("unexpected argument: {arg}\n{USAGE}")),
        }
    }
    let (Some(chant), Some(pulse_s), Some(out)) = (chant, pulse_s, out) else {
        return Err(USAGE.into());
    };
    let gabc = std::fs::read_to_string(&chant).map_err(|e| format!("{}: {e}", chant.display()))?;
    let notes = notes_from_gabc(&gabc, pulse_s);
    let samples = render(&notes, &profile, SAMPLE_RATE, seed.unwrap_or(0));
    wav::write_mono(&out, &samples, SAMPLE_RATE)?;
    eprintln!(
        "{} notes, {:.2} s -> {}",
        notes.len(),
        samples.len() as f32 / SAMPLE_RATE,
        out.display()
    );
    Ok(())
}

fn eval_cmd(args: &[String]) -> Result<ExitCode, String> {
    let mut write_baseline = false;
    let mut takes = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--write-baseline" => write_baseline = true,
            "--takes" => takes = Some(PathBuf::from(it.next().ok_or("--takes needs a directory")?)),
            _ => return Err(format!("unexpected argument: {arg}\n{USAGE}")),
        }
    }
    eval::run(&repo_root(), takes.as_deref(), write_baseline, None)
}

/// Draws every take of one suite (`real-takes` for the takes given with `--takes`) under
/// `out/explain/`, printing the files' paths.
fn explain_cmd(args: &[String]) -> Result<ExitCode, String> {
    let mut suite = None;
    let mut takes = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--takes" => takes = Some(PathBuf::from(it.next().ok_or("--takes needs a directory")?)),
            _ if suite.is_none() && !arg.starts_with('-') => suite = Some(arg.clone()),
            _ => return Err(format!("unexpected argument: {arg}\n{USAGE}")),
        }
    }
    let suite = suite.ok_or_else(|| USAGE.to_string())?;
    eval::run(&repo_root(), takes.as_deref(), false, Some(&suite))
}

/// The repository root: the current directory when it holds the suites, else the checkout
/// this binary was built from.
fn repo_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_default();
    if cwd.join("evals/suites").is_dir() {
        cwd
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }
}
