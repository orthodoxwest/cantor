//! The offline oracle: CREPE's pitch for each note, read at a few points across the part the
//! scorer judges, so the scorer's per-note pitch can be checked against a tracker that
//! shares no tracker with it. Labels are cached under `out/oracle/` by a hash of the model,
//! its decoder, the audio and the times asked for.

use std::path::{Path, PathBuf};

use cantor_core::score::{SKIP_HEAD, SKIP_TAIL};
use cantor_core::{Frame, Note};
use cantor_crepe::Crepe;

/// The points each note is read at.
const POINTS_PER_NOTE: usize = 5;

pub struct Oracle {
    crepe: Crepe,
    cache: PathBuf,
    /// The model's bytes and decoder, hashed, which every cache key starts from.
    model_key: u64,
}

impl Oracle {
    pub fn load(model: &Path, cache: PathBuf) -> Result<Oracle, String> {
        let bytes = std::fs::read(model).map_err(|e| format!("{}: {e}", model.display()))?;
        let model_key = fnv(FNV_OFFSET, bytes.iter().copied().chain(cantor_crepe::DECODER_VERSION.to_le_bytes()));
        let crepe = Crepe::load(model).map_err(|e| format!("{}: {e}", model.display()))?;
        std::fs::create_dir_all(&cache).map_err(|e| format!("{}: {e}", cache.display()))?;
        Ok(Oracle { crepe, cache, model_key })
    }

    /// Frames for the scorer to read: CREPE's pitch at [`POINTS_PER_NOTE`] points evenly
    /// across each note's judged part. A point where the scorer's own nearest frame was
    /// masked by the guide's bleed is masked too, so both are judged on the same audio.
    pub fn label(&self, samples: &[f32], sample_rate: f32, notes: &[Note], heard: &[Frame]) -> Result<Vec<Frame>, String> {
        let times: Vec<f32> = notes
            .iter()
            .flat_map(|n| {
                let from = n.start_s + SKIP_HEAD * n.dur_s;
                let span = (1.0 - SKIP_HEAD - SKIP_TAIL) * n.dur_s;
                (0..POINTS_PER_NOTE).map(move |k| from + span * (k as f32 + 0.5) / POINTS_PER_NOTE as f32)
            })
            .collect();
        let midi = self.pitch_at(samples, sample_rate, &times)?;
        Ok(times
            .iter()
            .zip(midi)
            .map(|(&t, midi)| {
                let masked = nearest(heard, t).is_some_and(|f| f.masked);
                Frame {
                    t,
                    midi: midi.filter(|_| !masked),
                    clarity: 1.0,
                    rms: 0.0,
                    masked,
                    quiet: false,
                    other: None,
                }
            })
            .collect())
    }

    fn pitch_at(&self, samples: &[f32], sample_rate: f32, times: &[f32]) -> Result<Vec<Option<f32>>, String> {
        let name = format!("{:016x}", key(self.model_key, samples, sample_rate, times));
        let path = self.cache.join(format!("{name}.json"));
        if let Some(midi) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<Option<f32>>>(&text).ok())
            .filter(|m| m.len() == times.len())
        {
            return Ok(midi);
        }
        let midi = self
            .crepe
            .pitch_at(samples, sample_rate, times)
            .map_err(|e| format!("CREPE: {e}"))?;
        let text = serde_json::to_string(&midi).map_err(|e| e.to_string())?;
        // Written aside and renamed, so an interrupted run never leaves half a file to read.
        let partial = self.cache.join(format!("{name}.{}.partial", std::process::id()));
        std::fs::write(&partial, text)
            .and_then(|()| std::fs::rename(&partial, &path))
            .map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(midi)
    }
}

/// The frame whose centre is nearest `t`, in frames sorted by time.
fn nearest(frames: &[Frame], t: f32) -> Option<&Frame> {
    let i = frames.partition_point(|f| f.t < t);
    [i.checked_sub(1), Some(i)]
        .into_iter()
        .flatten()
        .filter_map(|i| frames.get(i))
        .min_by(|a, b| (a.t - t).abs().total_cmp(&(b.t - t).abs()))
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

/// FNV-1a over `bytes`, from `h`.
fn fnv(h: u64, bytes: impl IntoIterator<Item = u8>) -> u64 {
    bytes
        .into_iter()
        .fold(h, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// FNV-1a over the model's key, the audio, its rate and the times.
fn key(model_key: u64, samples: &[f32], sample_rate: f32, times: &[f32]) -> u64 {
    let floats = samples.iter().chain([&sample_rate]).chain(times);
    fnv(model_key, floats.flat_map(|x| x.to_bits().to_le_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(t: f32, masked: bool) -> Frame {
        Frame {
            t,
            midi: None,
            clarity: 0.0,
            rms: 0.0,
            masked,
            quiet: false,
            other: None,
        }
    }

    #[test]
    fn the_nearest_frame_is_found_either_side() {
        let frames = [frame(0.0, false), frame(0.03, true), frame(0.06, false)];
        assert_eq!(nearest(&frames, 0.02).map(|f| f.t), Some(0.03));
        assert_eq!(nearest(&frames, 0.04).map(|f| f.t), Some(0.03));
        assert_eq!(nearest(&frames, 0.05).map(|f| f.t), Some(0.06));
        assert_eq!(nearest(&frames, -1.0).map(|f| f.t), Some(0.0));
        assert_eq!(nearest(&frames, 9.0).map(|f| f.t), Some(0.06));
        assert!(nearest(&[], 0.0).is_none());
    }

    #[test]
    fn the_cache_key_changes_with_model_audio_rate_and_times() {
        let k = key(1, &[0.1, 0.2], 16_000.0, &[0.5]);
        assert_ne!(k, key(2, &[0.1, 0.2], 16_000.0, &[0.5]));
        assert_ne!(k, key(1, &[0.1, 0.25], 16_000.0, &[0.5]));
        assert_ne!(k, key(1, &[0.1, 0.2], 44_100.0, &[0.5]));
        assert_ne!(k, key(1, &[0.1, 0.2], 16_000.0, &[0.6]));
        assert_eq!(k, key(1, &[0.1, 0.2], 16_000.0, &[0.5]));
    }
}
