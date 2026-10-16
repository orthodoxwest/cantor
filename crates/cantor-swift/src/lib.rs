//! SwiftF0 (MIT, `model/LICENSE`), a small convolutional pitch tracker, the second opinion
//! beside the core's NSDF tracker. The model is the `swift-f0` 0.3.0 release's `model.onnx`,
//! run by `model` in plain Rust (weights read from the file), so it builds anywhere the core
//! does, the browser included; the windowing below follows that release's `detect`. With the
//! `tract` feature, `reference` runs the same file with tract, the reference the port is held
//! to. tract is native only.

#[cfg(all(feature = "tract", target_arch = "wasm32"))]
compile_error!("the tract feature is native only; the browser runs the port");

mod model;
mod onnx;
#[cfg(feature = "tract")]
pub mod reference;

use cantor_core::{Track, hz_to_midi};

pub use crate::model::HOP;
use crate::model::{COLUMN, Model};

const MODEL: &[u8] = include_bytes!("../model/swift-f0.onnx");

/// The only sample rate the model takes.
pub const SAMPLE_RATE: f32 = 16_000.0;
/// A frame is voiced when its confidence is at least this.
pub const VOICED: f32 = 0.5;
/// Frames whose audio peaks below this are digital silence, which the model never saw.
const SILENCE_PEAK: f32 = 1e-3;
/// Long audio runs in windows of this many frames, each with this many frames of context on
/// either side, which reproduces a single run over the whole.
const WINDOW_FRAMES: usize = 1875;
const LEFT_FRAMES: usize = 11;
const LOOKAHEAD_FRAMES: usize = 10;
/// Frames a [`Stream`] runs the network over at once, about half a second.
const STREAM_FRAMES: usize = 32;

/// What the model makes of one frame: its pitch in hertz and its confidence, and whether the
/// frame's audio is digital silence.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Raw {
    pub hz: f32,
    pub confidence: f32,
    pub quiet: bool,
}

impl Raw {
    /// The frame's pitch, when it is voiced: confident, and not digital silence.
    pub fn midi(&self) -> Option<f32> {
        (!self.quiet && self.confidence >= VOICED && self.hz > 0.0).then(|| hz_to_midi(self.hz))
    }
}

/// A loaded model.
pub struct SwiftF0 {
    model: Model,
}

impl SwiftF0 {
    /// Loads the bundled model.
    pub fn new() -> Result<SwiftF0, String> {
        Ok(SwiftF0 {
            model: Model::new(MODEL).map_err(|e| format!("SwiftF0: {e}"))?,
        })
    }

    /// Tracks `samples` at `sample_rate`, resampled to 16 kHz for the model: one frame every
    /// 16 ms, frame `i` centred at `i` hops.
    pub fn track(&self, samples: &[f32], sample_rate: f32) -> Result<Track, String> {
        Ok(track_of(&self.raw(samples, sample_rate)?))
    }

    /// What the model makes of each frame of `samples` at `sample_rate`.
    pub fn raw(&self, samples: &[f32], sample_rate: f32) -> Result<Vec<Raw>, String> {
        windows(samples, sample_rate, &|window| Ok(self.run(window)))
    }

    /// Pitch and confidence for each frame of a window of 16 kHz audio.
    fn run(&self, window: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let (pitch, confidence) = self.model.run(window);
        (pitch.into_iter().map(|hz| hz as f32).collect(), confidence)
    }
}

/// The track of frames `raw`.
pub fn track_of(raw: &[Raw]) -> Track {
    Track {
        start_s: 0.0,
        hop_s: HOP as f32 / SAMPLE_RATE,
        midi: raw.iter().map(Raw::midi).collect(),
    }
}

/// Gives pitch and confidence for each frame of a window of 16 kHz audio.
type Run<'a> = &'a dyn Fn(&[f32]) -> Result<(Vec<f32>, Vec<f32>), String>;

/// `samples` at `sample_rate` resampled to 16 kHz and run a window at a time.
fn windows(samples: &[f32], sample_rate: f32, run: Run) -> Result<Vec<Raw>, String> {
    check_rate(sample_rate)?;
    let resampled;
    let samples = if sample_rate == SAMPLE_RATE {
        samples
    } else {
        resampled = resample(samples, sample_rate, SAMPLE_RATE);
        &resampled[..]
    };
    let mut out = Vec::with_capacity((samples.len() / HOP).max(1));
    rest(samples, &mut out, run)?;
    Ok(out)
}

fn check_rate(sample_rate: f32) -> Result<(), String> {
    if RATES.contains(&sample_rate) && sample_rate.fract() == 0.0 {
        Ok(())
    } else {
        Err(format!("{sample_rate} Hz is not a sample rate SwiftF0 can take"))
    }
}

/// Appends to `out` the frames of 16 kHz `samples` from `out.len()` to the end, a window of
/// at most [`WINDOW_FRAMES`] at a time.
fn rest(samples: &[f32], out: &mut Vec<Raw>, run: Run) -> Result<(), String> {
    let n = (samples.len() / HOP).max(1);
    while out.len() < n {
        let end = (out.len() + WINDOW_FRAMES).min(n);
        let to = if end < n {
            ((end + LOOKAHEAD_FRAMES) * HOP).min(samples.len())
        } else {
            samples.len()
        };
        window(samples, end, to, out, run)?;
    }
    Ok(())
}

/// Appends to `out` the frames of 16 kHz `samples` from `out.len()` to `end`, run as one
/// window from [`LEFT_FRAMES`] before the first to sample `to`.
fn window(samples: &[f32], end: usize, to: usize, out: &mut Vec<Raw>, run: Run) -> Result<(), String> {
    let start = out.len();
    let left = start.saturating_sub(LEFT_FRAMES);
    let window = &samples[left * HOP..to];
    let (pitch, confidence) = run(window)?;
    for i in start - left..end - left {
        out.push(Raw {
            hz: pitch.get(i).copied().unwrap_or(0.0),
            confidence: confidence.get(i).copied().unwrap_or(0.0),
            quiet: quiet(window, i),
        });
    }
    Ok(())
}

/// SwiftF0 over a take as it arrives. Each frame's spectrogram column is made once, as soon
/// as the audio it reaches is in, and each [`push`](Stream::push) runs the network over every
/// [`STREAM_FRAMES`] frames whose columns either side are in, so the work keeps pace with the
/// take; [`finish`](Stream::finish) runs the rest. The frames are those [`SwiftF0::raw`] gives
/// for the whole take: the resampler's output is taken only once its kernel is whole, and the
/// network reads every column a single run's would.
pub struct Stream {
    sample_rate: f32,
    resampler: Resampler,
    input: Vec<f32>,
    /// The take at 16 kHz so far, when it is at another rate.
    resampled: Vec<f32>,
    /// Each frame's column so far.
    columns: Vec<f32>,
    raw: Vec<Raw>,
}

impl Stream {
    pub fn new(sample_rate: f32) -> Result<Stream, String> {
        check_rate(sample_rate)?;
        Ok(Stream {
            sample_rate,
            resampler: Resampler::new(sample_rate, SAMPLE_RATE)?,
            input: Vec::new(),
            resampled: Vec::new(),
            columns: Vec::new(),
            raw: Vec::new(),
        })
    }

    /// The frames run so far.
    pub fn frames(&self) -> usize {
        self.raw.len()
    }

    /// Adds `samples` to the take and runs what they complete.
    pub fn push(&mut self, swift: &SwiftF0, samples: &[f32]) -> Result<(), String> {
        self.input.extend_from_slice(samples);
        if self.sample_rate != SAMPLE_RATE {
            while self.resampler.whole(self.resampled.len(), self.input.len()) {
                self.resampled.push(self.resampler.at(&self.input, self.resampled.len()));
            }
        }
        let audio = if self.sample_rate == SAMPLE_RATE {
            &self.input
        } else {
            &self.resampled
        };
        let model = &swift.model;
        let mut column = [0.0; COLUMN];
        loop {
            let f = self.columns.len() / COLUMN;
            if f * HOP + model.reach() > audio.len() {
                break;
            }
            model.column(audio, f, &mut column);
            self.columns.extend_from_slice(&column);
        }
        while self.columns.len() / COLUMN >= self.raw.len() + STREAM_FRAMES + model.context() {
            let end = self.raw.len() + STREAM_FRAMES;
            network(model, audio, &self.columns, end, &mut self.raw);
        }
        Ok(())
    }

    /// Ends the take: every frame of it.
    pub fn finish(mut self, swift: &SwiftF0) -> Result<Vec<Raw>, String> {
        if self.sample_rate != SAMPLE_RATE {
            let from = self.resampled.len();
            let to = self.resampler.len(self.input.len());
            self.resampled.extend((from..to).map(|j| self.resampler.at(&self.input, j)));
        }
        let audio = if self.sample_rate == SAMPLE_RATE {
            &self.input
        } else {
            &self.resampled
        };
        let n = (audio.len() / HOP).max(1);
        let mut column = [0.0; COLUMN];
        for f in self.columns.len() / COLUMN..n {
            swift.model.column(audio, f, &mut column);
            self.columns.extend_from_slice(&column);
        }
        if self.raw.len() < n {
            network(&swift.model, audio, &self.columns, n, &mut self.raw);
        }
        Ok(self.raw)
    }
}

/// Appends to `raw` the frames from `raw.len()` to `end` of 16 kHz `audio`, the network run
/// over their `columns` and those either side they reach.
fn network(model: &Model, audio: &[f32], columns: &[f32], end: usize, raw: &mut Vec<Raw>) {
    let start = raw.len();
    let from = start.saturating_sub(model.context());
    let to = (end + model.context()).min(columns.len() / COLUMN);
    let (pitch, confidence) = model.network_of(&columns[from * COLUMN..to * COLUMN]);
    raw.extend((start..end).map(|f| Raw {
        hz: pitch[f - from] as f32,
        confidence: confidence[f - from],
        quiet: quiet(audio, f),
    }));
}

/// Whether frame `f`'s hop of `audio` is digital silence.
fn quiet(audio: &[f32], f: usize) -> bool {
    audio
        .get(f * HOP..((f + 1) * HOP).min(audio.len()))
        .is_none_or(|hop| hop.iter().all(|x| x.abs() < SILENCE_PEAK))
}

/// The sample rates `track` takes.
const RATES: std::ops::RangeInclusive<f32> = 4_000.0..=384_000.0;
/// Half the width of the resampler's kernel, in input samples at the lower of the two rates.
const RESAMPLE_HALF: f32 = 16.0;
/// Phases past which a [`Resampler`] makes each output's weights afresh rather than keep them.
const KEPT_PHASES: u64 = 4_096;

/// Resampling between two whole rates: a Hann-windowed sinc whose response is half (-6 dB) at
/// 95% of the lower rate's Nyquist. Positions are whole numbers of the two rates' common step,
/// so long takes stay aligned, and an output's weights depend only on its phase within that
/// step, so each phase's are made once.
pub struct Resampler {
    /// The rates over their greatest common divisor.
    from: u64,
    to: u64,
    cutoff: f32,
    half: f32,
    /// Each phase's first tap, from the input sample at or before the output, and weights,
    /// when there are few enough phases to keep.
    phases: Vec<(i64, Vec<f32>)>,
}

impl Resampler {
    /// From `from` to `to` hertz, whole numbers both.
    pub fn new(from: f32, to: f32) -> Result<Resampler, String> {
        let whole = |r: f32| (r >= 1.0 && r.fract() == 0.0).then_some(r as u64);
        let (Some(from), Some(to)) = (whole(from), whole(to)) else {
            return Err(format!("no resampling from {from} to {to} Hz: rates are whole numbers"));
        };
        let gcd = gcd(from, to);
        // The cutoff, as a fraction of the input's Nyquist, a little under the lower rate's.
        let cutoff = 0.95 * (to as f64 / from as f64).min(1.0) as f32;
        let mut resampler = Resampler {
            from: from / gcd,
            to: to / gcd,
            cutoff,
            half: RESAMPLE_HALF / cutoff,
            phases: Vec::new(),
        };
        if resampler.to <= KEPT_PHASES {
            resampler.phases = (0..resampler.to).map(|p| resampler.kernel(p)).collect();
        }
        Ok(resampler)
    }

    /// The outputs `inputs` samples make.
    pub fn len(&self, inputs: usize) -> usize {
        (inputs as u64 * self.to / self.from) as usize
    }

    /// The input sample at or before output `j`, and `j`'s phase.
    fn place(&self, j: usize) -> (i64, u64) {
        let at = j as u64 * self.from;
        ((at / self.to) as i64, at % self.to)
    }

    /// Phase `p`'s first tap and its weights.
    fn kernel(&self, p: u64) -> (i64, Vec<f32>) {
        let offset = p as f64 / self.to as f64;
        let half = f64::from(self.half);
        let (first, last) = ((offset - half).ceil() as i64, (offset + half).floor() as i64);
        let weights = (first..=last)
            .map(|o| {
                let d = ((o * self.to as i64 - p as i64) as f64 / self.to as f64) as f32;
                let sinc = if d == 0.0 {
                    1.0
                } else {
                    let a = std::f32::consts::PI * self.cutoff * d;
                    a.sin() / a
                };
                sinc * (0.5 + 0.5 * (std::f32::consts::PI * d / self.half).cos())
            })
            .collect();
        (first, weights)
    }

    /// Whether output `j`'s kernel lies within the first `inputs` samples.
    fn whole(&self, j: usize, inputs: usize) -> bool {
        let (at, p) = self.place(j);
        let (first, len) = match self.phases.get(p as usize) {
            Some((first, weights)) => (*first, weights.len()),
            None => {
                let (first, weights) = self.kernel(p);
                (first, weights.len())
            }
        };
        at + first + len as i64 <= inputs as i64
    }

    /// Output `j` of `samples`, read as silence past either end.
    pub fn at(&self, samples: &[f32], j: usize) -> f32 {
        let (at, p) = self.place(j);
        let made;
        let (first, weights) = match self.phases.get(p as usize) {
            Some((first, weights)) => (*first, &weights[..]),
            None => {
                made = self.kernel(p);
                (made.0, &made.1[..])
            }
        };
        let (mut sum, mut weight) = (0.0f32, 0.0f32);
        for (i, w) in (at + first..).zip(weights) {
            if let Some(x) = usize::try_from(i).ok().and_then(|i| samples.get(i)) {
                sum += x * w;
                weight += w;
            }
        }
        if weight == 0.0 { 0.0 } else { sum / weight }
    }
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// `samples` at `from` hertz resampled to `to` (see [`Resampler`]); nothing when the rates are
/// not whole numbers.
pub fn resample(samples: &[f32], from: f32, to: f32) -> Vec<f32> {
    let Ok(r) = Resampler::new(from, to) else { return Vec::new() };
    (0..r.len(samples.len())).map(|j| r.at(samples, j)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hears_a_sung_note_and_not_silence() {
        let sr = SAMPLE_RATE;
        let mut samples: Vec<f32> = (0..16_000)
            .map(|i| {
                let t = i as f32 / sr;
                (1..6)
                    .map(|k| (2.0 * std::f32::consts::PI * 220.0 * k as f32 * t).sin() / k as f32)
                    .sum::<f32>()
                    * 0.1
            })
            .collect();
        samples.resize(32_000, 0.0);
        let track = SwiftF0::new().expect("model").track(&samples, SAMPLE_RATE).expect("run");
        assert_eq!(track.midi.len(), 125);
        let voiced: Vec<f32> = track.midi[10..50].iter().flatten().copied().collect();
        assert!(voiced.len() > 35, "{}", voiced.len());
        assert!(voiced.iter().all(|m| (m - 57.0).abs() < 0.3), "{voiced:?}");
        assert!(track.midi[80..].iter().all(Option::is_none));
    }

    fn tone(hz: f32, sr: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f32 / sr;
                (1..6)
                    .map(|k| (2.0 * std::f32::consts::PI * hz * k as f32 * t).sin() / k as f32)
                    .sum::<f32>()
                    * 0.1
            })
            .collect()
    }

    #[test]
    fn long_audio_tracks_as_one_run_would() {
        // A glissando with noise, long enough for two windows, sounding to the end.
        let sr = SAMPLE_RATE;
        let n = (WINDOW_FRAMES + 300) * HOP + 123;
        let mut state = 1u32;
        let samples: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / sr;
                let hz = 150.0 + 20.0 * t;
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                0.1 * (2.0 * std::f32::consts::PI * hz * t).sin() + 0.02 * (state as f32 / u32::MAX as f32 - 0.5)
            })
            .collect();
        let swift = SwiftF0::new().expect("model");
        let windowed = swift.track(&samples, sr).expect("run").midi;
        let (pitch, confidence) = swift.model.run(&samples);
        assert_eq!(windowed.len(), n / HOP);
        let mut worst = 0.0f32;
        for (i, m) in windowed.iter().enumerate() {
            let whole = (confidence[i] >= VOICED).then(|| hz_to_midi(pitch[i] as f32));
            assert_eq!(m.is_some(), whole.is_some(), "frame {i}");
            if let (Some(a), Some(b)) = (m, whole) {
                worst = worst.max((a - b).abs());
            }
        }
        assert!(worst < 0.001, "{worst}");
    }

    #[test]
    fn a_take_run_as_it_arrives_is_run_as_a_whole() {
        let swift = SwiftF0::new().expect("model");
        for (rate, chunk) in [(SAMPLE_RATE, 1_000), (44_100.0, 1_024), (48_000.0, 4_097)] {
            // Two seconds of a note between silences, then a note sounding to the end.
            let mut samples = vec![0.0; (0.3 * rate) as usize];
            samples.extend(tone(220.0, rate, (2.0 * rate) as usize));
            samples.extend(vec![0.0; (0.5 * rate) as usize]);
            samples.extend(tone(330.0, rate, (1.3 * rate) as usize));
            let whole = swift.raw(&samples, rate).expect("run");
            let mut stream = Stream::new(rate).expect("rate");
            for block in samples.chunks(chunk) {
                stream.push(&swift, block).expect("push");
            }
            assert!(
                stream.frames() > whole.len() / 2,
                "{rate}: {} frames run as it arrived",
                stream.frames()
            );
            assert_eq!(stream.finish(&swift).expect("finish"), whole, "{rate}");
        }
    }

    #[test]
    fn frames_are_centred_on_their_hop() {
        // Silence, then a note from sample 24000: frame 93 (centred at 23808) is before it and
        // frame 95 (24320) inside it.
        let mut samples = vec![0.0f32; 24_000];
        samples.extend(tone(220.0, SAMPLE_RATE, 16_000));
        let track = SwiftF0::new().expect("model").track(&samples, SAMPLE_RATE).expect("run");
        assert_eq!((track.start_s, track.hop_s), (0.0, 0.016));
        let midi = track.midi;
        assert!(midi[..=93].iter().all(Option::is_none), "{:?}", &midi[88..=93]);
        assert!(midi[96..140].iter().all(|m| m.is_some_and(|m| (m - 57.0).abs() < 0.3)));
    }

    #[test]
    fn digital_silence_is_never_voiced() {
        // A note with a stretch of near-silence (peaks under the floor) in its middle.
        let mut samples = tone(220.0, SAMPLE_RATE, 32_000);
        for s in &mut samples[12_800..19_200] {
            *s *= 0.005;
        }
        let midi = SwiftF0::new().expect("model").track(&samples, SAMPLE_RATE).expect("run").midi;
        assert!(midi[51..74].iter().all(Option::is_none), "{:?}", &midi[50..75]);
        assert!(midi[10..45].iter().all(Option::is_some));
    }

    #[test]
    fn long_takes_resample_in_step() {
        // Ten minutes at 44.1 kHz, past 2^24 samples, where f32 positions lose whole samples:
        // the last output samples still land where they should.
        let (from, n, tail) = (44_100.0f64, 26_460_000usize, 4_410usize);
        let hz = 220.0f64;
        let mut samples = vec![0.0f32; n - tail];
        samples.extend((n - tail..n).map(|i| (2.0 * std::f64::consts::PI * hz * i as f64 / from).sin() as f32));
        let resampler = Resampler::new(from as f32, SAMPLE_RATE).expect("rates");
        let len = resampler.len(n);
        assert_eq!(len, 9_600_000);
        let worst = (len - 1_000..len - 100)
            .map(|j| {
                let want = (2.0 * std::f64::consts::PI * hz * j as f64 / SAMPLE_RATE as f64).sin() as f32;
                (resampler.at(&samples, j) - want).abs()
            })
            .fold(0.0f32, f32::max);
        assert!(worst < 0.01, "{worst}");
    }

    #[test]
    fn weights_made_afresh_are_the_kept_ones() {
        let samples = tone(220.0, 44_100.0, 10_000);
        let kept = Resampler::new(44_100.0, SAMPLE_RATE).expect("rates");
        let mut afresh = Resampler::new(44_100.0, SAMPLE_RATE).expect("rates");
        afresh.phases.clear();
        for j in [0, 1, 159, 160, 1_000, kept.len(samples.len()) - 1] {
            assert_eq!(kept.at(&samples, j), afresh.at(&samples, j), "{j}");
            assert_eq!(kept.whole(j, 5_000), afresh.whole(j, 5_000), "{j}");
        }
        assert!(Resampler::new(44_100.5, SAMPLE_RATE).is_err());
    }

    /// The plain model against tract's run of the same file, frame for frame.
    #[cfg(feature = "tract")]
    fn agree_with_tract(samples: &[f32], sample_rate: f32) {
        let ours = SwiftF0::new().expect("model").raw(samples, sample_rate).expect("run");
        let theirs = reference::Reference::new().expect("tract").raw(samples, sample_rate).expect("run");
        assert_eq!(ours.len(), theirs.len());
        let mut worst = (0.0f32, 0.0f32);
        for (i, (a, b)) in ours.iter().zip(&theirs).enumerate() {
            assert_eq!(a.quiet, b.quiet, "frame {i}");
            assert_eq!(a.midi().is_some(), b.midi().is_some(), "frame {i}: {a:?} against {b:?}");
            worst.1 = worst.1.max((a.confidence - b.confidence).abs());
            if let (Some(x), Some(y)) = (a.midi(), b.midi()) {
                worst.0 = worst.0.max((x - y).abs());
            }
        }
        assert!(worst.0 <= 0.001, "{} semitones apart", worst.0);
        assert!(worst.1 <= 1e-4, "confidence {} apart", worst.1);
    }

    /// The port's tables and sums are those tract makes on x86-64 with glibc; elsewhere tract's
    /// own differ, and the port is held to it by [`agree_with_tract`] alone.
    #[cfg(all(feature = "tract", target_arch = "x86_64", target_os = "linux", target_env = "gnu"))]
    #[test]
    fn the_spectrograms_are_tracts_to_the_bit() {
        let swift = SwiftF0::new().expect("model");
        let reference = reference::Reference::new().expect("tract");
        let mut state = 3u32;
        // A quiet chord in noise, whose upper bins are nearly silent, at lengths from under a
        // hop to several seconds.
        for len in [100, HOP, 5 * HOP + 17, 40_000, 100_000] {
            let audio: Vec<f32> = (0..len)
                .map(|i| {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let t = i as f32 / SAMPLE_RATE;
                    let chord = [196.0, 247.0, 294.0]
                        .iter()
                        .map(|hz| (std::f32::consts::TAU * hz * t).sin())
                        .sum::<f32>();
                    0.02 * chord + 1e-4 * (state as f32 / u32::MAX as f32 - 0.5)
                })
                .collect();
            let mut window = audio.clone();
            window.resize(len.max(HOP), 0.0);
            let ours = swift.model.spectrogram(&window).data;
            let theirs = reference.values(&window, &["v352"]).expect("tract").remove(0);
            assert_eq!(ours.len(), theirs.len(), "{len}");
            let differ = ours.iter().zip(&theirs).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
            assert_eq!(differ, 0, "{differ} of {} values differ at {len} samples", ours.len());
        }
    }

    #[cfg(feature = "tract")]
    #[test]
    fn the_port_hears_as_tract_does() {
        let mut state = 7u32;
        let mut noise = || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            state as f32 / u32::MAX as f32 - 0.5
        };
        // A glissando over the model's range with noise, a chord, a short burst and silence.
        let sr = SAMPLE_RATE;
        let mut samples: Vec<f32> = (0..96_000)
            .map(|i| {
                let t = i as f32 / sr;
                0.2 * (std::f32::consts::TAU * 60.0 * (2f32.powf(t * 0.8) - 1.0) / (0.8 * std::f32::consts::LN_2)).sin() + 0.01 * noise()
            })
            .collect();
        samples.extend(tone(220.0, sr, 8_000).iter().zip(tone(277.2, sr, 8_000)).map(|(a, b)| a + b));
        samples.extend(vec![0.0; 3_000]);
        samples.extend((0..200).map(|_| 0.3 * noise()));
        agree_with_tract(&samples, sr);
        agree_with_tract(&samples[..100], sr);
        agree_with_tract(&tone(110.0, 48_000.0, 50_000), 48_000.0);
    }

    #[test]
    fn absurd_rates_are_refused() {
        let swift = SwiftF0::new().expect("model");
        assert!(swift.track(&[0.0; 1_000], 1.0).is_err());
        assert!(swift.track(&[0.0; 1_000], f32::NAN).is_err());
    }

    #[test]
    fn other_rates_are_resampled() {
        let samples = tone(220.0, 48_000.0, 48_000);
        let midi = SwiftF0::new().expect("model").track(&samples, 48_000.0).expect("run").midi;
        assert_eq!(midi.len(), 62);
        let voiced: Vec<f32> = midi[5..55].iter().flatten().copied().collect();
        assert!(voiced.len() > 45 && voiced.iter().all(|m| (m - 57.0).abs() < 0.1), "{voiced:?}");
    }
}
