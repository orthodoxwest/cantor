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
/// Audio is planned in whole multiples of this many samples (128 frames).
const BUCKET: usize = 128 * HOP;

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
        let mut plans = self.plans.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(plan) = plans.get(&len) {
            return Ok(plan.clone());
        }
        let mut model = self.model.clone();
        model.set_input_fact(0, f32::fact([1, len]).into())?;
        model.set_input_fact(1, f32::scalar_fact().into())?;
        model.set_input_fact(2, f32::scalar_fact().into())?;
        let plan = model.into_optimized()?.into_runnable()?;
        plans.insert(len, plan.clone());
        Ok(plan)
    }

    /// Tracks 16 kHz `samples`: one frame every 16 ms, frame `i` centred at `i` hops.
    pub fn track(&self, samples: &[f32]) -> TractResult<Track> {
        let n = (samples.len() / HOP).max(1);
        let mut midi = Vec::with_capacity(n);
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
            start = end;
        }
        Ok(Track {
            start_s: 0.0,
            hop_s: HOP as f32 / SAMPLE_RATE,
            midi,
        })
    }

    fn run(&self, window: &[f32]) -> TractResult<(Vec<f32>, Vec<f32>)> {
        // Planning takes longer than running, so the audio is padded with silence to a whole
        // number of buckets and fewer lengths are planned; the padding's frames are past the
        // end and dropped, and the model pads with silence itself.
        let mut audio = window.to_vec();
        audio.resize(window.len().max(1).div_ceil(BUCKET) * BUCKET, 0.0);
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
        let track = SwiftF0::new().expect("model").track(&samples).expect("run");
        assert_eq!(track.midi.len(), 125);
        let voiced: Vec<f32> = track.midi[10..50].iter().flatten().copied().collect();
        assert!(voiced.len() > 35, "{}", voiced.len());
        assert!(voiced.iter().all(|m| (m - 57.0).abs() < 0.3), "{voiced:?}");
        assert!(track.midi[80..].iter().all(Option::is_none));
    }
}
