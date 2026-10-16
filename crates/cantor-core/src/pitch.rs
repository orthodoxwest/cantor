//! Pitch tracking: the normalised square difference method over frames of samples.
//!
//! Each frame's normalised square difference function (NSDF) is scanned, past its zero-lag
//! lobe, for its positive peaks; the first peak at or above 90% of the highest one is the
//! period, refined with a parabola through its neighbours. The peak's height is the frame's
//! clarity, and a frame below the clarity or loudness floor is unvoiced.

use serde::{Deserialize, Serialize};

use crate::hz_to_midi;

/// The lowest pitch the tracker reports, in hertz.
pub const MIN_HZ: f32 = 62.0;
/// The highest pitch the tracker reports, in hertz.
pub const MAX_HZ: f32 = 1100.0;
/// Frames quieter than this RMS are unvoiced.
pub const DEFAULT_MIN_RMS: f32 = 0.008;
/// Frames whose best peak is lower than this are unvoiced.
pub const DEFAULT_MIN_CLARITY: f32 = 0.8;
/// The default spacing of tracked frames, in seconds.
pub const DEFAULT_HOP_S: f32 = 0.03;

/// The smallest power-of-two frame that holds two periods of [`MIN_HZ`] at `sample_rate`
/// (1024 samples at 16 kHz, 2048 at 48 kHz).
pub fn default_frame(sample_rate: f32) -> usize {
    ((2.0 * sample_rate / MIN_HZ).ceil() as usize).next_power_of_two()
}

/// One tracked frame.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    /// The frame's centre, in seconds from the start of the samples.
    pub t: f32,
    /// The pitch heard, as a MIDI-style note number, or `None` when the frame is unvoiced.
    pub midi: Option<f32>,
    /// The height of the NSDF peak taken as the period (0 when none was found).
    pub clarity: f32,
    /// The frame's root mean square.
    pub rms: f32,
    /// The frame was voiced but no louder than the guide's bleed could make it, so its
    /// pitch was dropped (see [`crate::listen`]).
    #[serde(default)]
    pub masked: bool,
}

/// What [`detect`] hears in one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Detection {
    /// The pitch, as a MIDI-style note number, when the frame is voiced.
    pub midi: Option<f32>,
    /// The height of the chosen NSDF peak, 0 when none.
    pub clarity: f32,
    /// The frame's root mean square.
    pub rms: f32,
}

/// Tracks `samples` with frames of `frame` samples every `hop` samples, at the default
/// loudness and clarity floors. A frame's time is its centre.
pub fn track(samples: &[f32], sample_rate: f32, frame: usize, hop: usize) -> Vec<Frame> {
    track_with(samples, sample_rate, frame, hop, DEFAULT_MIN_RMS)
}

/// [`track`] with a loudness floor of `min_rms`.
pub fn track_with(samples: &[f32], sample_rate: f32, frame: usize, hop: usize, min_rms: f32) -> Vec<Frame> {
    let hop = hop.max(1);
    let mut frames = Vec::new();
    if frame == 0 || samples.len() < frame {
        return frames;
    }
    let mut start = 0;
    while start + frame <= samples.len() {
        let d = detect(&samples[start..start + frame], sample_rate, min_rms, DEFAULT_MIN_CLARITY);
        frames.push(Frame {
            t: (start as f32 + frame as f32 / 2.0) / sample_rate,
            midi: d.midi,
            clarity: d.clarity,
            rms: d.rms,
            masked: false,
        });
        start += hop;
    }
    frames
}

/// The pitch of one frame. A frame quieter than `min_rms`, with no NSDF peak, whose chosen
/// peak is lower than `min_clarity`, or whose pitch falls outside [`MIN_HZ`]..[`MAX_HZ`] is
/// unvoiced; its clarity and rms are still reported.
pub fn detect(buf: &[f32], sample_rate: f32, min_rms: f32, min_clarity: f32) -> Detection {
    let n = buf.len();
    let rms = if n == 0 {
        0.0
    } else {
        (buf.iter().map(|x| x * x).sum::<f32>() / n as f32).sqrt()
    };
    let unvoiced = |clarity| Detection { midi: None, clarity, rms };
    if rms < min_rms || n < 4 {
        return unvoiced(0.0);
    }
    let max_tau = ((sample_rate / MIN_HZ).floor() as usize).min(n / 2);
    if max_tau < 2 {
        return unvoiced(0.0);
    }
    // The NSDF is computed from lag 0, not from the shortest period of interest: at a high
    // pitch that lag can already lie inside the true peak's lobe, which would then be
    // skipped along with the zero-lag lobe. A peak shorter than the shortest period gives a
    // pitch above `MAX_HZ`, rejected below.
    let nsdf = nsdf(buf, max_tau);

    // Skip the zero-lag lobe, then take the highest point of each later positive run as a
    // candidate peak.
    let mut tau = 0;
    while tau <= max_tau && nsdf[tau] > 0.0 {
        tau += 1;
    }
    let mut peaks: Vec<(usize, f32)> = Vec::new();
    let mut max_val = 0.0f32;
    while tau <= max_tau {
        while tau <= max_tau && nsdf[tau] <= 0.0 {
            tau += 1;
        }
        let mut best = (0usize, -1.0f32);
        while tau <= max_tau && nsdf[tau] > 0.0 {
            if nsdf[tau] > best.1 {
                best = (tau, nsdf[tau]);
            }
            tau += 1;
        }
        if best.0 > 0 {
            peaks.push(best);
            max_val = max_val.max(best.1);
        }
    }
    let Some(&(peak_tau, clarity)) = peaks.iter().find(|p| p.1 >= 0.9 * max_val) else {
        return unvoiced(0.0);
    };

    // Parabolic refinement through the peak's neighbours.
    let mut period = peak_tau as f32;
    if peak_tau > 0 && peak_tau < max_tau {
        let (a, b, c) = (nsdf[peak_tau - 1], nsdf[peak_tau], nsdf[peak_tau + 1]);
        let den = a - 2.0 * b + c;
        if den != 0.0 {
            period += 0.5 * (a - c) / den;
        }
    }
    if clarity < min_clarity {
        return unvoiced(clarity);
    }
    let hz = sample_rate / period;
    if !(MIN_HZ..=MAX_HZ).contains(&hz) {
        return unvoiced(clarity);
    }
    Detection {
        midi: Some(hz_to_midi(hz)),
        clarity,
        rms,
    }
}

/// The normalised square difference function for lags `0..=max_tau`, indexed by lag.
fn nsdf(buf: &[f32], max_tau: usize) -> Vec<f32> {
    let n = buf.len();
    let mut out = vec![0.0f32; max_tau + 1];
    for (tau, slot) in out.iter_mut().enumerate() {
        let mut acf = 0.0f32;
        let mut m = 0.0f32;
        for (&a, &b) in buf[..n - tau].iter().zip(&buf[tau..]) {
            acf += a * b;
            m += a * a + b * b;
        }
        *slot = if m > 0.0 { 2.0 * acf / m } else { 0.0 };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midi_to_hz;

    const SR: f32 = 48_000.0;
    const N: usize = 2048;

    fn sine(hz: f32) -> Vec<f32> {
        (0..N)
            .map(|i| 0.3 * (2.0 * std::f32::consts::PI * hz * i as f32 / SR).sin())
            .collect()
    }

    fn cents_off(hz: f32, midi: f32) -> f32 {
        (midi - hz_to_midi(hz)) * 100.0
    }

    #[test]
    fn sines_within_two_cents() {
        for hz in [82.4, 110.0, 196.0, 261.6, 440.0, 659.3, 880.0] {
            let d = detect(&sine(hz), SR, DEFAULT_MIN_RMS, DEFAULT_MIN_CLARITY);
            let midi = d.midi.unwrap_or_else(|| panic!("{hz} Hz unvoiced"));
            let off = cents_off(hz, midi);
            assert!(off.abs() < 2.0, "{hz} Hz read {off:.2} cents off");
            assert!(d.clarity > 0.9, "{hz} Hz clarity {}", d.clarity);
        }
    }

    #[test]
    fn sawtooth_reads_the_fundamental() {
        let hz = 220.0;
        let buf: Vec<f32> = (0..N)
            .map(|i| {
                let phase = (hz * i as f32 / SR).fract();
                0.3 * (2.0 * phase - 1.0)
            })
            .collect();
        let d = detect(&buf, SR, DEFAULT_MIN_RMS, DEFAULT_MIN_CLARITY);
        let midi = d.midi.expect("voiced");
        assert!(cents_off(hz, midi).abs() < 5.0, "read {:.1} Hz", midi_to_hz(midi));
    }

    #[test]
    fn silence_is_unvoiced() {
        let d = detect(&vec![0.0; N], SR, DEFAULT_MIN_RMS, DEFAULT_MIN_CLARITY);
        assert_eq!(d.midi, None);
        assert_eq!(d.rms, 0.0);
    }

    #[test]
    fn noise_is_unvoiced() {
        let mut rng = crate::synth::XorShift::new(7);
        let buf: Vec<f32> = (0..N).map(|_| 0.3 * rng.next_signed()).collect();
        let d = detect(&buf, SR, DEFAULT_MIN_RMS, DEFAULT_MIN_CLARITY);
        assert_eq!(d.midi, None, "noise read as {:?} with clarity {}", d.midi, d.clarity);
    }

    #[test]
    fn default_frame_holds_two_periods() {
        assert_eq!(default_frame(16_000.0), 1024);
        assert_eq!(default_frame(48_000.0), 2048);
    }

    #[test]
    fn track_times_frame_centres() {
        let frames = track(&sine(440.0), SR, 1024, 512);
        assert_eq!(frames.len(), 3);
        assert!((frames[0].t - 512.0 / SR).abs() < 1e-6);
        assert!((frames[1].t - 1024.0 / SR).abs() < 1e-6);
        assert!(frames.iter().all(|f| f.midi.is_some()));
    }
}
