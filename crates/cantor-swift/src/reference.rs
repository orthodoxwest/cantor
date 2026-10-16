//! The bundled model run with tract, the reference [`crate::model`] is held to. Native only:
//! tract is too large for the browser.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use cantor_core::Track;
use tract_onnx::pb::attribute_proto::AttributeType;
use tract_onnx::pb::tensor_proto::DataType;
use tract_onnx::pb::{AttributeProto, TensorProto};
use tract_onnx::prelude::*;

use crate::model::{FMAX, FMIN, HOP};
use crate::{MODEL, Raw, track_of, windows};

type Plan = Arc<TypedRunnableModel>;

/// The model loaded into tract. tract cannot type the model over a symbolic length, so it is
/// planned once for each length of audio it is given.
pub struct Reference {
    model: InferenceModel,
    plans: Mutex<HashMap<usize, Plan>>,
}

impl Reference {
    /// Loads the bundled model.
    pub fn new() -> TractResult<Reference> {
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
        Ok(Reference {
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

    /// As [`crate::SwiftF0::track`].
    pub fn track(&self, samples: &[f32], sample_rate: f32) -> Result<Track, String> {
        Ok(track_of(&self.raw(samples, sample_rate)?))
    }

    /// As [`crate::SwiftF0::raw`].
    pub fn raw(&self, samples: &[f32], sample_rate: f32) -> Result<Vec<Raw>, String> {
        windows(samples, sample_rate, |window| {
            self.run(window).map_err(|e| format!("SwiftF0 in tract: {e}"))
        })
    }

    /// Pitch and confidence for each frame of `window` (16 kHz).
    pub fn run(&self, window: &[f32]) -> TractResult<(Vec<f32>, Vec<f32>)> {
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
        Ok((values(&out[0])?, values(&out[1])?))
    }

    /// The graph's values named `names` for `window` (16 kHz, at least a hop), each
    /// flattened: a check on the port's steps.
    pub fn values(&self, window: &[f32], names: &[&str]) -> TractResult<Vec<Vec<f32>>> {
        let len = window.len();
        let mut model = self.model.clone();
        model.set_input_fact(0, f32::fact([1, len]).into())?;
        model.set_input_fact(1, f32::scalar_fact().into())?;
        model.set_input_fact(2, f32::scalar_fact().into())?;
        model.select_outputs_by_name(names)?;
        let plan = model.into_optimized()?.into_runnable()?;
        let out = plan.run(tvec!(
            tract_ndarray::Array2::from_shape_vec((1, len), window.to_vec())?.into_tvalue(),
            tensor0(FMIN).into_tvalue(),
            tensor0(FMAX).into_tvalue(),
        ))?;
        out.iter()
            .map(|t| Ok(t.cast_to::<f32>()?.to_plain_array_view::<f32>()?.iter().copied().collect()))
            .collect()
    }
}
