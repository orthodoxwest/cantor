//! Rooms and devices for synthetic takes: a reverberant room, a phone's speaker and a
//! phone's microphone. Each filters samples in place and is deterministic.

/// A Schroeder reverberator: four parallel combs tuned to `rt60_s`, then two allpasses,
/// mixed over the dry signal at `wet`.
pub fn reverb(samples: &mut [f32], sample_rate: f32, rt60_s: f32, wet: f32) {
    if rt60_s <= 0.0 || samples.is_empty() {
        return;
    }
    const COMBS_S: [f32; 4] = [0.0297, 0.0371, 0.0411, 0.0437];
    const ALLPASSES: [(f32, f32); 2] = [(0.005, 0.7), (0.0017, 0.7)];
    let dry = samples.to_vec();
    let mut tail = vec![0.0f32; samples.len()];
    for d in COMBS_S {
        let delay = ((d * sample_rate).round() as usize).max(1);
        // The gain that loses 60 dB in rt60_s.
        let g = 10f32.powf(-3.0 * d / rt60_s);
        let mut line = vec![0.0f32; delay];
        for (i, out) in tail.iter_mut().enumerate() {
            let slot = i % delay;
            let y = line[slot];
            line[slot] = dry[i] + g * y;
            *out += y / COMBS_S.len() as f32;
        }
    }
    for (d, g) in ALLPASSES {
        let delay = ((d * sample_rate).round() as usize).max(1);
        let mut line = vec![0.0f32; delay];
        for (i, x) in tail.iter_mut().enumerate() {
            let slot = i % delay;
            let old = line[slot];
            let v = *x + g * old;
            line[slot] = v;
            *x = old - g * v;
        }
    }
    for (s, t) in samples.iter_mut().zip(&tail) {
        *s += wet * t;
    }
}

/// A phone's microphone: a second-order high-pass at 120 Hz and low-pass at 3.6 kHz.
pub fn phone_mic(samples: &mut [f32], sample_rate: f32) {
    Biquad::high_pass(120.0, sample_rate).run(samples);
    Biquad::low_pass(3600.0, sample_rate).run(samples);
}

/// A phone's speaker: no bass below about 400 Hz, little above 6 kHz.
pub fn speaker(samples: &mut [f32], sample_rate: f32) {
    Biquad::high_pass(400.0, sample_rate).run(samples);
    Biquad::high_pass(400.0, sample_rate).run(samples);
    Biquad::low_pass(6000.0_f32.min(0.45 * sample_rate), sample_rate).run(samples);
}

/// A second-order section from the audio EQ cookbook, Q = 1/sqrt(2).
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
}

impl Biquad {
    fn high_pass(hz: f32, sample_rate: f32) -> Biquad {
        let (cos, alpha) = Self::omega(hz, sample_rate);
        Self::new(
            [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0],
            1.0 + alpha,
            [-2.0 * cos, 1.0 - alpha],
        )
    }

    fn low_pass(hz: f32, sample_rate: f32) -> Biquad {
        let (cos, alpha) = Self::omega(hz, sample_rate);
        Self::new(
            [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0],
            1.0 + alpha,
            [-2.0 * cos, 1.0 - alpha],
        )
    }

    fn omega(hz: f32, sample_rate: f32) -> (f32, f32) {
        let w = 2.0 * std::f32::consts::PI * hz / sample_rate;
        (w.cos(), w.sin() / 2.0f32.sqrt())
    }

    fn new(b: [f32; 3], a0: f32, a: [f32; 2]) -> Biquad {
        Biquad {
            b: b.map(|x| x / a0),
            a: a.map(|x| x / a0),
        }
    }

    fn run(&self, samples: &mut [f32]) {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for s in samples {
            let x = *s;
            let y = self.b[0] * x + self.b[1] * x1 + self.b[2] * x2 - self.a[0] * y1 - self.a[1] * y2;
            (x2, x1, y2, y1) = (x1, x, y1, y);
            *s = y;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 16_000.0;

    fn sine(hz: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / SR).sin()).collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn phone_mic_passes_the_voice_and_cuts_the_rumble() {
        let mut voice = sine(1000.0, 16_000);
        let mut rumble = sine(40.0, 16_000);
        phone_mic(&mut voice, SR);
        phone_mic(&mut rumble, SR);
        assert!((rms(&voice[4000..]) - 0.707).abs() < 0.05);
        assert!(rms(&rumble[4000..]) < 0.1);
    }

    #[test]
    fn reverb_rings_on_after_the_sound_stops() {
        let mut x = sine(220.0, 8000);
        x.resize(32_000, 0.0);
        reverb(&mut x, SR, 1.0, 0.5);
        // 0.25 s after the end the tail is still audible, and by 1.5 s it has died away.
        let at = |s: f32| rms(&x[(s * SR) as usize..(s * SR) as usize + 800]);
        assert!(at(0.75) > 0.01, "{}", at(0.75));
        assert!(at(1.9) < at(0.75) / 20.0, "{} {}", at(1.9), at(0.75));
    }
}
