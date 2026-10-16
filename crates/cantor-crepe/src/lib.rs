//! CREPE (full), an offline pitch oracle: a large convolutional tracker, too slow to listen
//! with, run to label takes so the scorer can be checked against a tracker not its own. The
//! model is built by `scripts/crepe.py` from torchcrepe's MIT-licensed weights and
//! is never committed; it is loaded from a path.

use std::path::Path;

use cantor_core::hz_to_midi;
use cantor_swift::resample;
use tract_onnx::prelude::*;

/// The only sample rate the model takes.
const SAMPLE_RATE: f32 = 16_000.0;
/// Samples per frame.
const WINDOW: usize = 1024;
/// The model's 360 bins are this many cents apart, bin 0 this many cents above 10 Hz.
const BINS: usize = 360;
const CENTS_PER_BIN: f32 = 20.0;
const BIN0_CENTS: f32 = 1_997.379_4;
/// The pitch is the activation-weighted mean of the bins this close to the strongest.
const SPREAD: usize = 4;
/// A frame is voiced when its strongest activation is at least this.
pub const VOICED: f32 = 0.5;
/// Changes when the same model and audio would give different labels (the framing, the
/// resampling, the decoding), so caches of labels can key on it.
pub const LABELS_VERSION: u32 = 1;
/// Frames whose audio peaks below this are digital silence, which the model never saw.
const SILENCE_PEAK: f32 = 1e-3;

/// A loaded model. A frame costs tens of milliseconds, so the oracle is asked for the times
/// it is needed at, not run over whole takes.
pub struct Crepe {
    plan: Arc<TypedRunnableModel>,
}

impl Crepe {
    /// Loads the model `scripts/crepe.py` built.
    pub fn load(path: &Path) -> TractResult<Crepe> {
        Crepe::read(&std::fs::read(path)?)
    }

    /// Loads the model from its bytes.
    pub fn read(model: &[u8]) -> TractResult<Crepe> {
        let plan = tract_onnx::onnx()
            .model_for_read(&mut &model[..])?
            .with_input_fact(0, f32::fact([1, WINDOW]).into())?
            .into_optimized()?
            .into_runnable()?;
        Ok(Crepe { plan })
    }

    /// The pitch of `samples` at `sample_rate` in the frame centred at each of `times`, in
    /// seconds, as a MIDI-style note number, or `None` where the frame is unvoiced. The audio
    /// is resampled to 16 kHz and read as silence past either end.
    pub fn pitch_at(&self, samples: &[f32], sample_rate: f32, times: &[f32]) -> TractResult<Vec<Option<f32>>> {
        let resampled;
        let samples = if sample_rate == SAMPLE_RATE {
            samples
        } else {
            resampled = resample(samples, sample_rate, SAMPLE_RATE);
            &resampled
        };
        times
            .iter()
            .map(|t| {
                let centre = (t * SAMPLE_RATE).round() as i64;
                let frame: Vec<f32> = (0..WINDOW as i64)
                    .map(|k| {
                        usize::try_from(centre - WINDOW as i64 / 2 + k)
                            .ok()
                            .and_then(|j| samples.get(j))
                            .copied()
                            .unwrap_or(0.0)
                    })
                    .collect();
                if frame.iter().all(|x| x.abs() < SILENCE_PEAK) {
                    return Ok(None);
                }
                let input = tract_ndarray::Array2::from_shape_vec((1, WINDOW), normalized(&frame))?;
                let out = self.plan.run(tvec!(input.into_tvalue()))?;
                let activations = out[0].to_plain_array_view::<f32>()?;
                if activations.len() != BINS {
                    tract_onnx::tract_core::internal::bail!("the model gave {} activations, not {BINS}", activations.len());
                }
                Ok(decode(&activations.iter().copied().collect::<Vec<f32>>()))
            })
            .collect()
    }
}

/// `frame` less its mean, scaled to unit (sample) deviation, as the model was trained.
fn normalized(frame: &[f32]) -> Vec<f32> {
    let n = frame.len() as f32;
    let mean = frame.iter().sum::<f32>() / n;
    let var = frame.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / (n - 1.0);
    let std = var.sqrt().max(1e-10);
    frame.iter().map(|x| (x - mean) / std).collect()
}

/// The pitch one frame's activations name, when it is voiced.
fn decode(activations: &[f32]) -> Option<f32> {
    if activations.len() != BINS {
        return None;
    }
    let (peak, strongest) = activations.iter().copied().enumerate().max_by(|a, b| a.1.total_cmp(&b.1))?;
    if strongest < VOICED {
        return None;
    }
    let near = peak.saturating_sub(SPREAD)..(peak + SPREAD + 1).min(activations.len());
    let (mut sum, mut weight) = (0.0, 0.0);
    for b in near {
        sum += activations[b] * (BIN0_CENTS + CENTS_PER_BIN * b as f32);
        weight += activations[b];
    }
    let cents = sum / weight;
    Some(hz_to_midi(10.0 * 2f32.powf(cents / 1200.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peak_decodes_to_its_bins_pitch() {
        // Bin b is 10 Hz * 2^((1997.38 + 20 b) / 1200); A3 (220 Hz) sits near bin 168.
        let mut a = vec![0.0f32; BINS];
        let b = 168;
        a[b] = 0.9;
        let cents = BIN0_CENTS + CENTS_PER_BIN * b as f32;
        let want = hz_to_midi(10.0 * 2f32.powf(cents / 1200.0));
        assert!((decode(&a).expect("voiced") - want).abs() < 1e-4);
        // A neighbour pulls the pitch towards it in proportion.
        a[b + 1] = 0.9;
        assert!((decode(&a).expect("voiced") - want - 0.1).abs() < 1e-3);
        // Far bins do not.
        a[b + 40] = 0.3;
        assert!((decode(&a).expect("voiced") - want - 0.1).abs() < 1e-3);
        assert_eq!(decode(&[0.4; BINS]), None);
        assert_eq!(decode(&[0.9; 10]), None);
    }

    #[test]
    fn frames_are_scaled_to_unit_deviation() {
        let f: Vec<f32> = (0..WINDOW).map(|i| 3.0 + (i as f32 * 0.1).sin() * 0.01).collect();
        let n = normalized(&f);
        let mean = n.iter().sum::<f32>() / n.len() as f32;
        let var = n.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / (n.len() - 1) as f32;
        assert!(mean.abs() < 1e-3 && (var - 1.0).abs() < 1e-3, "{mean} {var}");
    }

    /// Needs the model: `make oracle`, then `cargo test -p cantor-crepe -- --ignored`.
    #[test]
    #[ignore]
    fn hears_a_sung_note() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/crepe/full.onnx");
        let crepe = Crepe::load(&path).expect("model");
        let sr = 48_000.0;
        let mut samples: Vec<f32> = (0..48_000)
            .map(|i| {
                let t = i as f32 / sr;
                (1..6)
                    .map(|k| (2.0 * std::f32::consts::PI * 220.0 * k as f32 * t).sin() / k as f32)
                    .sum::<f32>()
                    * 0.1
            })
            .collect();
        samples.resize(96_000, 0.0);
        let midi = crepe.pitch_at(&samples, sr, &[0.1, 0.5, 0.9, 1.5, -1.0, 9.0]).expect("run");
        assert!(midi[..3].iter().all(|m| m.is_some_and(|m| (m - 57.0).abs() < 0.1)), "{midi:?}");
        assert!(midi[3..].iter().all(Option::is_none), "{midi:?}");
    }
}
