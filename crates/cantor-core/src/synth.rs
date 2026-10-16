//! A deterministic voice for test takes: a pulse-like waveform with a few harmonics, an
//! attack and release per note, and planted faults from a [`Profile`]. Nothing here reads a
//! clock or a system random source; the seed is an input.

use serde::{Deserialize, Serialize};

use crate::midi_to_hz;

/// One note to sing: a pitch, when it starts and how long it lasts.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Note {
    /// MIDI-style note number (fractional values are allowed).
    pub midi: f32,
    /// Start, in seconds.
    pub start_s: f32,
    /// Duration, in seconds.
    pub dur_s: f32,
}

impl Note {
    /// The end of the note, in seconds.
    pub fn end_s(&self) -> f32 {
        self.start_s + self.dur_s
    }
}

/// The faults planted in a take. Every field has a neutral default so a profile can name
/// only the faults it wants; later faults are added as more fields.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    /// A pitch offset for each note by index, in cents; missing entries and 0 mean none.
    pub cents_offset_per_note: Vec<f32>,
    /// A steady pitch drift applied to every note, in cents per second from the start.
    pub drift_cents_per_second: f32,
    /// White noise mixed over the whole take, by its RMS.
    pub noise_rms: f32,
}

impl Profile {
    /// The offset planted on note `index`, in cents.
    pub fn planted_cents(&self, index: usize) -> f32 {
        self.cents_offset_per_note.get(index).copied().unwrap_or(0.0)
    }
}

/// A xorshift64 generator: tiny, deterministic and good enough for test noise.
#[derive(Clone, Debug)]
pub struct XorShift(u64);

impl XorShift {
    /// A generator from `seed`. The seed is mixed first (one splitmix64 step), so small
    /// seeds do not start with a run of small outputs and a zero seed never sticks at 0.
    pub fn new(seed: u64) -> XorShift {
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        XorShift(if z == 0 { 1 } else { z })
    }

    /// The next 64 bits.
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// A uniform value in `-1.0..1.0`.
    pub fn next_signed(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 23) as f32 - 1.0
    }
}

/// Harmonic amplitudes relative to the fundamental: a gentle rolloff like a sung vowel.
const HARMONICS: [f32; 6] = [1.0, 0.6, 0.4, 0.25, 0.15, 0.08];
const ATTACK_S: f32 = 0.03;
const RELEASE_S: f32 = 0.05;
const PEAK: f32 = 0.3;

/// Renders `notes` at `sample_rate` with the faults of `profile`, seeding the noise with
/// `seed`. The take ends `RELEASE_S` after the last note. The same inputs always give the
/// same samples.
pub fn render(notes: &[Note], profile: &Profile, sample_rate: f32, seed: u64) -> Vec<f32> {
    let end_s = notes.iter().map(Note::end_s).fold(0.0f32, f32::max) + RELEASE_S;
    let len = (end_s * sample_rate).ceil() as usize;
    let mut out = vec![0.0f32; len];
    let total_amp: f32 = HARMONICS.iter().sum();
    for (index, note) in notes.iter().enumerate() {
        let first = (note.start_s * sample_rate).round().max(0.0) as usize;
        let last = ((note.end_s() + RELEASE_S) * sample_rate).round() as usize;
        let offset = profile.planted_cents(index);
        let mut phase = 0.0f32;
        for (i, slot) in out.iter_mut().enumerate().take(last.min(len)).skip(first) {
            let t = i as f32 / sample_rate;
            let since_start = t - note.start_s;
            let env = envelope(since_start, note.dur_s);
            let midi = note.midi + (offset + profile.drift_cents_per_second * t) / 100.0;
            phase = (phase + midi_to_hz(midi) / sample_rate).fract();
            let mut sample = 0.0;
            for (k, amp) in HARMONICS.iter().enumerate() {
                sample += amp * (2.0 * std::f32::consts::PI * (k + 1) as f32 * phase).sin();
            }
            *slot += PEAK * env * sample / total_amp;
        }
    }
    if profile.noise_rms > 0.0 {
        // A uniform value in -1..1 has an RMS of 1/sqrt(3).
        let scale = profile.noise_rms * 3.0f32.sqrt();
        let mut rng = XorShift::new(seed);
        for s in &mut out {
            *s += scale * rng.next_signed();
        }
    }
    out
}

/// A linear attack, a sustain and a linear release after the note's end.
fn envelope(since_start: f32, dur_s: f32) -> f32 {
    if since_start < 0.0 {
        0.0
    } else if since_start < ATTACK_S {
        since_start / ATTACK_S
    } else if since_start < dur_s {
        1.0
    } else {
        (1.0 - (since_start - dur_s) / RELEASE_S).max(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pitch::{DEFAULT_MIN_CLARITY, DEFAULT_MIN_RMS, detect};

    const SR: f32 = 48_000.0;

    #[test]
    fn render_is_deterministic() {
        let notes = [Note {
            midi: 60.0,
            start_s: 0.0,
            dur_s: 0.2,
        }];
        let profile = Profile {
            noise_rms: 0.01,
            ..Profile::default()
        };
        assert_eq!(render(&notes, &profile, SR, 3), render(&notes, &profile, SR, 3));
        assert_ne!(render(&notes, &profile, SR, 3), render(&notes, &profile, SR, 4));
    }

    #[test]
    fn rendered_note_reads_at_its_pitch_plus_offset() {
        let notes = [Note {
            midi: 64.0,
            start_s: 0.0,
            dur_s: 0.3,
        }];
        let profile = Profile {
            cents_offset_per_note: vec![40.0],
            ..Profile::default()
        };
        let take = render(&notes, &profile, SR, 1);
        let d = detect(&take[4800..4800 + 2048], SR, DEFAULT_MIN_RMS, DEFAULT_MIN_CLARITY);
        let cents = (d.midi.expect("voiced") - 64.0) * 100.0;
        assert!((cents - 40.0).abs() < 3.0, "read {cents:.1} cents");
    }

    #[test]
    fn noise_has_the_asked_rms() {
        let profile = Profile {
            noise_rms: 0.05,
            ..Profile::default()
        };
        let take = render(&[], &profile, SR, 9);
        let rms = (take.iter().map(|x| x * x).sum::<f32>() / take.len() as f32).sqrt();
        assert!((rms - 0.05).abs() < 0.005, "rms {rms}");
    }
}
