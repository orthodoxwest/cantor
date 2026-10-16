//! The listening core. No I/O, no platform calls, no wall clock: every function takes its
//! inputs and returns a value, so the same code runs in a browser worklet, on a server and
//! in tests.
//!
//! The research loop this crate skeletons: [`synth`] renders a take with planted faults,
//! [`pitch`] tracks it, and [`score`] measures the track against the notes [`timeline`] read
//! from the chant.

#![forbid(unsafe_code)]

pub mod pitch;
pub mod score;
pub mod synth;
pub mod timeline;

pub use pitch::{Frame, track};
pub use score::{NoteResult, Report, score};
pub use synth::{Note, Profile, render};
pub use timeline::notes_from_gabc;

/// Frequency in hertz to a MIDI-style note number (69 is A4 at 440 Hz; 0.01 is a cent).
pub fn hz_to_midi(hz: f32) -> f32 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

/// MIDI-style note number to hertz; the inverse of [`hz_to_midi`].
pub fn midi_to_hz(midi: f32) -> f32 {
    440.0 * ((midi - 69.0) / 12.0).exp2()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a4_is_69() {
        assert!((hz_to_midi(440.0) - 69.0).abs() < 1e-5);
        assert!((midi_to_hz(69.0) - 440.0).abs() < 1e-3);
        assert!((midi_to_hz(hz_to_midi(261.63)) - 261.63).abs() < 1e-2);
    }
}
