//! The `cantor` command: offline work on takes. `pitch` tracks a WAV or FLAC file, `synth`
//! renders a chant with planted faults, `sing` renders it with the guide voice, `diction`
//! lists the vowels it would sing, `eval` runs the listening gates and the baseline.

#![forbid(unsafe_code)]

mod ear;
mod eval;
mod explain;
mod wav;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use cantor_core::{Profile, Voice, notes_from_gabc, part_from_gabc, render, voice};

use crate::ear::Ear;

/// The sample rate synthetic takes are rendered and tracked at.
const SAMPLE_RATE: f32 = 16_000.0;

const USAGE: &str = "usage: cantor pitch FILE.wav [--nsdf-only]
       cantor synth CHANT.gabc --tempo PULSE_SECONDS --seed N [--cents a,b,c...] -o OUT.wav
       cantor sing CHANT.gabc [--voice VOICE.cvox] --tempo PULSE_SECONDS [--transpose SEMITONES] [--rate HZ] -o OUT.wav
       cantor diction CHANT.gabc
       cantor eval [--takes DIR] [--write-baseline] [--nsdf-only]
       cantor explain SUITE [--takes DIR] [--nsdf-only]
       cantor version

Listening uses the NSDF tracker with SwiftF0's opinion beside it; --nsdf-only drops SwiftF0.";

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
        Some("sing") => sing_cmd(rest)?,
        Some("diction") => diction_cmd(rest)?,
        Some("eval") => return eval_cmd(rest),
        Some("explain") => return explain_cmd(rest),
        Some("-h" | "--help") => println!("{USAGE}"),
        Some(other) => return Err(format!("unknown command: {other}\n{USAGE}")),
    }
    Ok(ExitCode::SUCCESS)
}

/// Tracks a WAV file and prints one JSON frame per line.
fn pitch_cmd(args: &[String]) -> Result<(), String> {
    let (nsdf_only, args) = nsdf_only(args);
    let [file] = &args[..] else { return Err(USAGE.into()) };
    let (samples, rate) = wav::read_mono(Path::new(file))?;
    let mut out = String::new();
    for frame in Ear::new(nsdf_only)?.listen(&samples, rate, None)? {
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

/// Sings a chant with a voice file, or the neutral voice, to a WAV file. Notes are timed as
/// `notes_from_gabc` times them, recitation quickened; the web guide keeps the timeline's own
/// timing, so a psalm here runs faster than the guide sings it.
fn sing_cmd(args: &[String]) -> Result<(), String> {
    let mut chant = None;
    let mut voice_path = None;
    let mut pulse_s = None;
    let mut transpose = 0.0f32;
    let mut rate = 48_000u32;
    let mut out = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = || it.next().ok_or_else(|| format!("{arg} needs a value"));
        let number = |v: &String| v.parse::<f32>().map_err(|e| format!("{arg}: {e}"));
        match arg.as_str() {
            "--voice" => voice_path = Some(PathBuf::from(value()?)),
            "--tempo" => pulse_s = Some(number(value()?)?),
            "--transpose" => transpose = number(value()?)?,
            "--rate" => rate = value()?.parse().map_err(|e| format!("{arg}: {e}"))?,
            "-o" | "--out" => out = Some(PathBuf::from(value()?)),
            _ if chant.is_none() && !arg.starts_with('-') => chant = Some(PathBuf::from(arg)),
            _ => return Err(format!("unexpected argument: {arg}\n{USAGE}")),
        }
    }
    let (Some(chant), Some(pulse_s), Some(out)) = (chant, pulse_s, out) else {
        return Err(USAGE.into());
    };
    if !pulse_s.is_finite() || pulse_s <= 0.0 {
        return Err("--tempo must be a positive number of seconds".into());
    }
    if !(8_000..=384_000).contains(&rate) {
        return Err("--rate must be a whole number of hertz from 8000 to 384000".into());
    }
    let rate = rate as f32;
    let gabc = std::fs::read_to_string(&chant).map_err(|e| format!("{}: {e}", chant.display()))?;
    let voice = match voice_path {
        Some(path) => {
            let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            Voice::parse(&bytes).map_err(|e| format!("{}: {e}", path.display()))?
        }
        None => Voice::neutral(),
    };
    let mut part = part_from_gabc(&gabc, pulse_s);
    for s in &mut part {
        s.note.midi += transpose;
    }
    let silent = part.iter().filter(|s| !voice::singable(s)).count();
    if silent > 0 {
        eprintln!("warning: {silent} notes are out of the voice's range or past an hour and are left silent");
    }
    let samples = voice::sing(&voice, &part, rate, 0, voice::length(&part, rate));
    wav::write_mono(&out, &samples, rate)?;
    eprintln!("{} notes, {:.2} s -> {}", part.len(), samples.len() as f32 / rate, out.display());
    Ok(())
}

/// Prints each syllable of a chant with the vowel it is sung on, one per line.
fn diction_cmd(args: &[String]) -> Result<(), String> {
    let [file] = args else { return Err(USAGE.into()) };
    let gabc = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
    let part = part_from_gabc(&gabc, 1.0);
    let lyrics = cantor_core::timeline::lyrics_from_gabc(&gabc, 1.0);
    let mut out = String::new();
    for (s, l) in part.iter().zip(&lyrics) {
        if s.new_syllable {
            let d = s.diction;
            let glide = d.glide.map_or(String::new(), |g| format!(" {}", g.symbol()));
            out.push_str(&format!("{}\t{}\t{}{glide}\n", l.word, l.text, d.vowel.symbol()));
        }
    }
    print!("{out}");
    Ok(())
}

fn eval_cmd(args: &[String]) -> Result<ExitCode, String> {
    let (nsdf_only, args) = nsdf_only(args);
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
    eval::run(&repo_root(), &Ear::new(nsdf_only)?, takes.as_deref(), write_baseline, None)
}

/// Draws every take of one suite (`real-takes` for the takes given with `--takes`) under
/// `out/explain/` (`out/explain-nsdf/` with `--nsdf-only`), printing the files' paths.
fn explain_cmd(args: &[String]) -> Result<ExitCode, String> {
    let (nsdf_only, args) = nsdf_only(args);
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
    eval::run(&repo_root(), &Ear::new(nsdf_only)?, takes.as_deref(), false, Some(&suite))
}

/// Whether `--nsdf-only` is among `args`, and the other arguments.
fn nsdf_only(args: &[String]) -> (bool, Vec<String>) {
    let rest: Vec<String> = args.iter().filter(|a| *a != "--nsdf-only").cloned().collect();
    (rest.len() < args.len(), rest)
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
