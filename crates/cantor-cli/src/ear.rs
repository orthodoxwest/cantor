//! How the command listens: the core's NSDF tracker, with SwiftF0's opinion beside it unless
//! asked for the NSDF tracker alone.

use cantor_core::{Frame, Guide, Track, listen_with};
use cantor_swift::SwiftF0;

pub struct Ear {
    swift: Option<SwiftF0>,
}

impl Ear {
    /// Both trackers, or the NSDF tracker alone when `nsdf_only`.
    pub fn new(nsdf_only: bool) -> Result<Ear, String> {
        let swift = if nsdf_only {
            None
        } else {
            Some(SwiftF0::new().map_err(|e| format!("SwiftF0: {e}"))?)
        };
        Ok(Ear { swift })
    }

    pub fn listen(&self, samples: &[f32], sample_rate: f32, guide: Option<Guide>) -> Result<Vec<Frame>, String> {
        let other = self.second(samples, sample_rate)?;
        Ok(listen_with(samples, sample_rate, guide, other.as_ref()))
    }

    /// SwiftF0's track, when it listens; it takes 16 kHz only.
    fn second(&self, samples: &[f32], sample_rate: f32) -> Result<Option<Track>, String> {
        let Some(swift) = &self.swift else { return Ok(None) };
        if sample_rate != cantor_swift::SAMPLE_RATE {
            return Err(format!(
                "SwiftF0 needs {} Hz audio, not {sample_rate}; pass --nsdf-only",
                cantor_swift::SAMPLE_RATE
            ));
        }
        swift.track(samples).map(Some).map_err(|e| format!("SwiftF0: {e}"))
    }
}
