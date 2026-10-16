//! The listening core. No I/O, no platform calls, no wall clock: every function takes its
//! inputs and returns a value, so the same code runs in a browser worklet, on a server and
//! in tests.

#![forbid(unsafe_code)]

/// Frequency in hertz to a MIDI-style note number (69 is A4 at 440 Hz; 0.01 is a cent).
pub fn hz_to_midi(hz: f32) -> f32 {
    69.0 + 12.0 * (hz / 440.0).log2()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a4_is_69() {
        assert!((hz_to_midi(440.0) - 69.0).abs() < 1e-5);
    }
}
