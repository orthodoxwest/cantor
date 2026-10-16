//! SwiftF0 (MIT, `model/LICENSE`), a small convolutional pitch tracker, run with tract as a
//! second opinion beside the core's NSDF tracker. The model is the `swift-f0` 0.3.0 release's
//! `model.onnx`; the windowing below follows that release's `detect`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use cantor_core::{Track, hz_to_midi};
use tract_onnx::pb::attribute_proto::AttributeType;
use tract_onnx::pb::tensor_proto::DataType;
use tract_onnx::pb::{AttributeProto, TensorProto};
use tract_onnx::prelude::*;

const MODEL: &[u8] = include_bytes!("../model/swift-f0.onnx");

/// The only sample rate the model takes.
pub const SAMPLE_RATE: f32 = 16_000.0;
/// Samples per frame.
const HOP: usize = 256;
/// The model's pitch range, in hertz.
const FMIN: f32 = 46.875;
const FMAX: f32 = 2093.75;
/// A frame is voiced when its confidence is at least this.
pub const VOICED: f32 = 0.5;
/// Frames whose audio peaks below this are digital silence, which the model never saw.
const SILENCE_PEAK: f32 = 1e-3;
/// Long audio runs in windows of this many frames, each with this many frames of context on
/// either side, which reproduces a single run over the whole.
const WINDOW_FRAMES: usize = 1875;
const LEFT_FRAMES: usize = 11;
const LOOKAHEAD_FRAMES: usize = 10;
/// Frames a [`Stream`] runs at once: about a second.
const STREAM_FRAMES: usize = 64;

type Plan = Arc<TypedRunnableModel>;

/// A loaded model. tract cannot type the model over a symbolic length, so it is planned once
/// for each length of audio it is given.
pub struct SwiftF0 {
    model: InferenceModel,
    plans: Mutex<HashMap<usize, Plan>>,
}

impl SwiftF0 {
    /// Loads the bundled model.
    pub fn new() -> TractResult<SwiftF0> {
        let onnx = tract_onnx::onnx();
        let mut proto = onnx.proto_model_for_read(&mut &MODEL[..])?;
        // A ConstantOfShape without a value fills with float32 zeros, but tract fills it
        // with float64 ones' type; give the model's three the value explicitly.
        for node in proto.graph.iter_mut().flat_map(|g| g.node.iter_mut()) {
            if node.op_type == "ConstantOfShape" && !node.attribute.iter().any(|a| a.name == "value") {
                node.attribute.push(AttributeProto {
                    name: "value".into(),
                    r#type: AttributeType::Tensor as i32,
                    t: Some(TensorProto {
                        dims: vec![1],
                        data_type: DataType::Float as i32,
                        float_data: vec![0.0],
                        ..TensorProto::default()
                    }),
                    ..AttributeProto::default()
                });
            }
        }
        let model = onnx.model_for_proto_model(&proto)?;
        Ok(SwiftF0 {
            model,
            plans: Mutex::new(HashMap::new()),
        })
    }

    fn plan(&self, len: usize) -> TractResult<Plan> {
        let plans = || self.plans.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(plan) = plans().get(&len) {
            return Ok(plan.clone());
        }
        // Planned without the lock, so that takes of different lengths plan side by side.
        let mut model = self.model.clone();
        model.set_input_fact(0, f32::fact([1, len]).into())?;
        model.set_input_fact(1, f32::scalar_fact().into())?;
        model.set_input_fact(2, f32::scalar_fact().into())?;
        let plan = model.into_optimized()?.into_runnable()?;
        Ok(plans().entry(len).or_insert(plan).clone())
    }

    /// Tracks `samples` at `sample_rate`, resampled to 16 kHz for the model: one frame every
    /// 16 ms, frame `i` centred at `i` hops.
    pub fn track(&self, samples: &[f32], sample_rate: f32) -> TractResult<Track> {
        if !RATES.contains(&sample_rate) {
            tract_onnx::tract_core::internal::bail!("{sample_rate} Hz is not a sample rate SwiftF0 can take");
        }
        if sample_rate == SAMPLE_RATE {
            self.track_16k(samples)
        } else {
            self.track_16k(&resample(samples, sample_rate, SAMPLE_RATE))
        }
    }

    fn track_16k(&self, samples: &[f32]) -> TractResult<Track> {
        let mut midi = Vec::new();
        self.track_rest(samples, &mut midi)?;
        Ok(track(midi))
    }

    /// Appends to `midi` the frames of 16 kHz `samples` from `midi.len()` to the end.
    fn track_rest(&self, samples: &[f32], midi: &mut Vec<Option<f32>>) -> TractResult<()> {
        let n = (samples.len() / HOP).max(1);
        while midi.len() < n {
            let end = (midi.len() + WINDOW_FRAMES).min(n);
            let to = if end < n {
                ((end + LOOKAHEAD_FRAMES) * HOP).min(samples.len())
            } else {
                samples.len()
            };
            self.window(samples, end, to, midi)?;
        }
        Ok(())
    }

    /// Appends to `midi` the frames from `midi.len()` to `end`, run over 16 kHz `samples`
    /// from [`LEFT_FRAMES`] before the first to sample `to`.
    fn window(&self, samples: &[f32], end: usize, to: usize, midi: &mut Vec<Option<f32>>) -> TractResult<()> {
        let start = midi.len();
        let left = start.saturating_sub(LEFT_FRAMES);
        let window = &samples[left * HOP..to];
        let (pitch, confidence) = self.run(window)?;
        for i in start - left..end - left {
            let quiet = window
                .get(i * HOP..((i + 1) * HOP).min(window.len()))
                .is_none_or(|hop| hop.iter().all(|x| x.abs() < SILENCE_PEAK));
            let voiced = !quiet && confidence.get(i).is_some_and(|c| *c >= VOICED);
            midi.push(
                voiced
                    .then(|| pitch.get(i).copied())
                    .flatten()
                    .filter(|hz| *hz > 0.0)
                    .map(hz_to_midi),
            );
        }
        Ok(())
    }

    fn run(&self, window: &[f32]) -> TractResult<(Vec<f32>, Vec<f32>)> {
        // The model needs at least one hop. Padding changes the frames near the end, so a
        // window is planned at its own length.
        let mut audio = window.to_vec();
        if audio.len() < HOP {
            audio.resize(HOP, 0.0);
        }
        let len = audio.len();
        let out = self.plan(len)?.run(tvec!(
            tract_ndarray::Array2::from_shape_vec((1, len), audio)?.into_tvalue(),
            tensor0(FMIN).into_tvalue(),
            tensor0(FMAX).into_tvalue(),
        ))?;
        let values =
            |t: &TValue| -> TractResult<Vec<f32>> { Ok(t.cast_to::<f32>()?.to_plain_array_view::<f32>()?.iter().copied().collect()) };
        let (pitch, confidence) = (values(&out[0])?, values(&out[1])?);
        Ok((pitch, confidence))
    }
}

fn track(midi: Vec<Option<f32>>) -> Track {
    Track {
        start_s: 0.0,
        hop_s: HOP as f32 / SAMPLE_RATE,
        midi,
    }
}

/// SwiftF0 over audio as it arrives, a take at a time: each [`push`](Stream::push) runs the
/// model over every [`STREAM_FRAMES`] frames whose audio and lookahead have arrived, so the
/// work keeps pace with the take, and [`finish`](Stream::finish) runs the rest. The frames are
/// those [`SwiftF0::track`] gives for the whole take: the resampler's output is taken only
/// once its kernel is whole, and each run has the context a single run would.
pub struct Stream {
    sample_rate: f32,
    input: Vec<f32>,
    /// The input at 16 kHz so far, when it is at another rate.
    resampled: Vec<f32>,
    midi: Vec<Option<f32>>,
}

impl Stream {
    pub fn new(sample_rate: f32) -> TractResult<Stream> {
        if !RATES.contains(&sample_rate) {
            tract_onnx::tract_core::internal::bail!("{sample_rate} Hz is not a sample rate SwiftF0 can take");
        }
        Ok(Stream {
            sample_rate,
            input: Vec::new(),
            resampled: Vec::new(),
            midi: Vec::new(),
        })
    }

    /// The take's sample rate.
    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    /// The take so far, at its own rate.
    pub fn input(&self) -> &[f32] {
        &self.input
    }

    /// The frames tracked so far.
    pub fn frames(&self) -> usize {
        self.midi.len()
    }

    /// Adds `samples` to the take and tracks what they complete.
    pub fn push(&mut self, swift: &SwiftF0, samples: &[f32]) -> TractResult<()> {
        self.input.extend_from_slice(samples);
        let audio = if self.sample_rate == SAMPLE_RATE {
            &self.input
        } else {
            let ratio = SAMPLE_RATE as f64 / self.sample_rate as f64;
            let half = (RESAMPLE_HALF / (0.95 * ratio.min(1.0) as f32)) as f64;
            let whole = |j: usize| ((j as f64 / ratio + half).floor() as usize) < self.input.len().saturating_sub(1);
            while whole(self.resampled.len()) {
                self.resampled.push(resampled_at(&self.input, ratio, self.resampled.len()));
            }
            &self.resampled
        };
        loop {
            let end = self.midi.len() + STREAM_FRAMES;
            let to = (end + LOOKAHEAD_FRAMES) * HOP;
            if to > audio.len() {
                return Ok(());
            }
            swift.window(audio, end, to, &mut self.midi)?;
        }
    }

    /// The whole take, at its own rate, and its track.
    pub fn finish(mut self, swift: &SwiftF0) -> TractResult<(Vec<f32>, Track)> {
        let audio = if self.sample_rate == SAMPLE_RATE {
            &self.input
        } else {
            let ratio = SAMPLE_RATE as f64 / self.sample_rate as f64;
            let len = (self.input.len() as f64 * ratio).floor() as usize;
            for j in self.resampled.len()..len {
                self.resampled.push(resampled_at(&self.input, ratio, j));
            }
            &self.resampled
        };
        swift.track_rest(audio, &mut self.midi)?;
        Ok((self.input, track(self.midi)))
    }
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
        let (pitch, confidence) = swift.run(&samples).expect("run");
        assert_eq!(windowed.len(), n / HOP);
        let mut worst = 0.0f32;
        for (i, m) in windowed.iter().enumerate() {
            let whole = (confidence[i] >= VOICED).then(|| hz_to_midi(pitch[i]));
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

    #[test]
    fn a_stream_tracks_as_the_whole_take_would() {
        // A glissando with noise, pushed in uneven pieces, at the model's rate and another.
        let swift = SwiftF0::new().expect("model");
        for sr in [SAMPLE_RATE, 48_000.0] {
            let n = (5.3 * sr) as usize;
            let mut state = 1u32;
            let samples: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f32 / sr;
                    let hz = 150.0 + 20.0 * t;
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    0.1 * (2.0 * std::f32::consts::PI * hz * t).sin() + 0.02 * (state as f32 / u32::MAX as f32 - 0.5)
                })
                .collect();
            let whole = swift.track(&samples, sr).expect("run").midi;
            let mut stream = Stream::new(sr).expect("rate");
            let mut pushed = 0;
            for (k, piece) in samples.chunks(1_000 + 3_517 * (sr as usize / 16_000)).enumerate() {
                stream.push(&swift, piece).expect("run");
                pushed += piece.len();
                if k == 5 {
                    // Pushed so far, in frames.
                    let heard = (pushed as f32 * SAMPLE_RATE / sr) as usize / HOP;
                    assert!(
                        stream.frames() >= STREAM_FRAMES && stream.frames() < heard,
                        "{} of {heard}",
                        stream.frames()
                    );
                }
            }
            let (input, streamed) = stream.finish(&swift).expect("run");
            assert_eq!(input, samples);
            assert_eq!(streamed.midi.len(), whole.len());
            for (i, (a, b)) in streamed.midi.iter().zip(&whole).enumerate() {
                assert_eq!(a.is_some(), b.is_some(), "frame {i} at {sr} Hz");
                if let (Some(a), Some(b)) = (a, b) {
                    assert!((a - b).abs() < 0.001, "frame {i} at {sr} Hz: {a} {b}");
                }
            }
        }
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
