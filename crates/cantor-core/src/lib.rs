//! The listening core. No I/O, no platform calls, no wall clock: every function takes its
//! inputs and returns a value, so the same code runs in a browser worklet, on a server and
//! in tests.
//!
//! The research loop: [`synth`] renders a take with planted faults through a [`room`],
//! [`listen`] tracks it and masks the guide's bleed, [`score`] measures the track against the
//! notes [`timeline`] read from the chant, timed from the singer's first sound by
//! [`mod@entry`], and [`judge`] decides what the singer is told: [`ribbon`] lays it out note by
//! note for the page to draw, [`mod@grid`] lays out a psalm verse by verse, and [`tell`] puts each
//! mark, the take and its endings off pitch in words.

#![forbid(unsafe_code)]

pub mod diction;
pub mod entry;
pub mod grid;
pub mod judge;
pub mod listen;
pub mod pitch;
pub mod ribbon;
pub mod room;
pub mod score;
pub mod synth;
pub mod tell;
pub mod timeline;
pub mod voice;

pub use diction::{Language, Lyric, Sung, Vowel};
pub use entry::{Entry, entry};
pub use grid::{Called, Cell, Column, Grid, Part, Row, grid};
pub use judge::{Cadence, Mark, MarkKind, Outcome, Verdict, judge, judge_again, judge_part, key_at};
pub use listen::{Guide, Listening, Track, listen, listen_with, live};
pub use pitch::{Frame, track};
pub use ribbon::{Band, ribbon};
pub use score::{NoteResult, Report, score};
pub use synth::{Note, Planted, Profile, Take, render, render_take};
pub use tell::{Ending, again, endings, summary, tell, told, told_again};
pub use timeline::{notes_from_gabc, part_from_gabc};
pub use voice::{Voice, VoiceError, sing};

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
