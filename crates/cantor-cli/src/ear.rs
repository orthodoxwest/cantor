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

    /// Whether this ear listens with the NSDF tracker alone.
    pub fn nsdf_only(&self) -> bool {
        self.swift.is_none()
    }

    pub fn listen(&self, samples: &[f32], sample_rate: f32, guide: Option<Guide>) -> Result<Vec<Frame>, String> {
        let other = self.second(samples, sample_rate)?;
        Ok(listen_with(samples, sample_rate, guide, other.as_ref()))
    }

    /// SwiftF0's track, when it listens.
    fn second(&self, samples: &[f32], sample_rate: f32) -> Result<Option<Track>, String> {
        let Some(swift) = &self.swift else { return Ok(None) };
        swift.track(samples, sample_rate).map(Some).map_err(|e| format!("SwiftF0: {e}"))
    }
}
