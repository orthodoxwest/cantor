//! SwiftF0 (MIT, `model/LICENSE`), a small convolutional pitch tracker, the second opinion
//! beside the core's NSDF tracker. The model is the `swift-f0` 0.3.0 release's `model.onnx`,
//! run by [`model`] in plain Rust (weights read from the file), so it builds anywhere the core
//! does, the browser included; the windowing below follows that release's `detect`. With the
//! `tract` feature, [`reference`] runs the same file with tract, the reference the port is
//! held to.

mod model;
mod onnx;
#[cfg(feature = "tract")]
pub mod reference;

use cantor_core::{Track, hz_to_midi};

pub use crate::model::HOP;
use crate::model::Model;

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
        windows(samples, sample_rate, |window| {
            let (pitch, confidence) = self.model.run(window);
            Ok((pitch.into_iter().map(|hz| hz as f32).collect(), confidence))
        })
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

/// `samples` at `sample_rate` resampled to 16 kHz and run a window at a time, with `run`
/// giving pitch and confidence for each frame of a window.
fn windows(samples: &[f32], sample_rate: f32, run: impl Fn(&[f32]) -> Result<(Vec<f32>, Vec<f32>), String>) -> Result<Vec<Raw>, String> {
    if !RATES.contains(&sample_rate) {
        return Err(format!("{sample_rate} Hz is not a sample rate SwiftF0 can take"));
    }
    let resampled;
    let samples = if sample_rate == SAMPLE_RATE {
        samples
    } else {
        resampled = resample(samples, sample_rate, SAMPLE_RATE);
        &resampled[..]
    };
    let n = (samples.len() / HOP).max(1);
    let mut out = Vec::with_capacity(n);
    let mut start = 0;
    while start < n {
        let end = (start + WINDOW_FRAMES).min(n);
        let left = start.saturating_sub(LEFT_FRAMES);
        let to = if end < n {
            ((end + LOOKAHEAD_FRAMES) * HOP).min(samples.len())
        } else {
            samples.len()
        };
        let window = &samples[left * HOP..to];
        let (pitch, confidence) = run(window)?;
        for i in start - left..end - left {
            let quiet = window
                .get(i * HOP..((i + 1) * HOP).min(window.len()))
                .is_none_or(|hop| hop.iter().all(|x| x.abs() < SILENCE_PEAK));
            out.push(Raw {
                hz: pitch.get(i).copied().unwrap_or(0.0),
                confidence: confidence.get(i).copied().unwrap_or(0.0),
                quiet,
            });
        }
        start = end;
    }
    Ok(out)
}

/// The sample rates `track` takes.
const RATES: std::ops::RangeInclusive<f32> = 4_000.0..=384_000.0;
/// Half the width of the resampler's kernel, in input samples at the lower of the two rates.
const RESAMPLE_HALF: f32 = 16.0;

/// `samples` at `to` hertz: a Hann-windowed sinc whose response is half (-6 dB) at 95% of the
/// lower rate's Nyquist. Positions are kept in f64, so long takes stay aligned.
pub fn resample(samples: &[f32], from: f32, to: f32) -> Vec<f32> {
    if samples.is_empty() || from <= 0.0 || to <= 0.0 {
        return Vec::new();
    }
    let ratio = to as f64 / from as f64;
    let len = (samples.len() as f64 * ratio).floor() as usize;
    (0..len).map(|j| resampled_at(samples, ratio, j)).collect()
}

/// Output sample `j` of [`resample`] at `ratio` output samples per input sample.
fn resampled_at(samples: &[f32], ratio: f64, j: usize) -> f32 {
    // The cutoff, as a fraction of the input's Nyquist, a little under the lower rate's.
    let cutoff = 0.95 * ratio.min(1.0) as f32;
    let half = RESAMPLE_HALF / cutoff;
    let centre = j as f64 / ratio;
    let first = (centre - half as f64).ceil().max(0.0) as usize;
    let last = ((centre + half as f64).floor() as usize).min(samples.len() - 1);
    let (mut sum, mut weight) = (0.0f32, 0.0f32);
    for (i, x) in samples.iter().enumerate().take(last + 1).skip(first) {
        let d = (i as f64 - centre) as f32;
        let sinc = if d == 0.0 {
            1.0
        } else {
            let a = std::f32::consts::PI * cutoff * d;
            a.sin() / a
        };
        let hann = 0.5 + 0.5 * (std::f32::consts::PI * d / half).cos();
        let w = sinc * hann;
        sum += x * w;
        weight += w;
    }
    if weight == 0.0 { 0.0 } else { sum / weight }
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
        let ratio = SAMPLE_RATE as f64 / from;
        let len = (n as f64 * ratio).floor() as usize;
        let worst = (len - 1_000..len - 100)
            .map(|j| {
                let want = (2.0 * std::f64::consts::PI * hz * j as f64 / SAMPLE_RATE as f64).sin() as f32;
                (resampled_at(&samples, ratio, j) - want).abs()
            })
            .fold(0.0f32, f32::max);
        assert!(worst < 0.01, "{worst}");
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

    #[cfg(feature = "tract")]
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
                let hz = 60.0 * 2f32.powf(t * 0.8);
                0.2 * (std::f32::consts::TAU * 60.0 * (2f32.powf(t * 0.8) - 1.0) / (0.8 * std::f32::consts::LN_2)).sin() * (hz / hz)
                    + 0.01 * noise()
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
