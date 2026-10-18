//! Synthetic singers: a deterministic take from the notes it should contain and a
//! [`Profile`] of the singer, the room and the guide. Every fault the profile plants is
//! labelled ([`Profile::planted`]), so a scorer's marks can be checked against what was sung.
//! Nothing here reads a clock or a system random source; the seed is an input.

use serde::{Deserialize, Serialize};

use crate::grid::Part;
use crate::midi_to_hz;
use crate::room;

/// One note to sing: a pitch, when it starts and how long it lasts, and where it falls in
/// the chant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Note {
    /// MIDI-style note number (fractional values are allowed).
    pub midi: f32,
    /// Start, in seconds.
    pub start_s: f32,
    /// Duration, in seconds.
    pub dur_s: f32,
    /// The verse: advances after each full or double bar.
    #[serde(default)]
    pub verse: u32,
    /// The phrase: advances after every bar, mediant and flex.
    #[serde(default)]
    pub phrase: u32,
    /// Where it falls in a psalm verse sung to a tone.
    #[serde(default)]
    pub part: Part,
    /// The vowel the syllable is sung on, when known.
    #[serde(default)]
    pub vowel: Option<char>,
    /// Sung on a reciting tone, at speech pace.
    #[serde(default)]
    pub recitation: bool,
}

impl Note {
    /// A note in verse 0, phrase 0, with no vowel.
    pub fn new(midi: f32, start_s: f32, dur_s: f32) -> Note {
        Note {
            midi,
            start_s,
            dur_s,
            ..Note::default()
        }
    }

    /// The end of the note, in seconds.
    pub fn end_s(&self) -> f32 {
        self.start_s + self.dur_s
    }
}

/// An inclusive range of note indices.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub first: usize,
    pub last: usize,
}

impl Span {
    pub fn contains(&self, index: usize) -> bool {
        (self.first..=self.last).contains(&index)
    }
}

/// Notes sung off by the same amount: a verse a tone high.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct RangeOffset {
    pub first: usize,
    pub last: usize,
    pub cents: f32,
}

/// Notes sung at the pitch of the note `by` places later (or earlier when negative): a
/// cadence moved a syllable early is a shift of 1 over the syllables before it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Shift {
    pub first: usize,
    pub last: usize,
    pub by: i32,
}

/// A note that starts off and is corrected while it is held: `cents` off at its start,
/// gliding to `residual_cents` off over `fix_s` seconds (0 residual is a full correction).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LateFix {
    pub note: usize,
    pub cents: f32,
    pub fix_s: f32,
    #[serde(default)]
    pub residual_cents: f32,
}

/// The waveform the singer sings with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Voice {
    /// A pulse with six harmonics and a gentle rolloff: no formants, no vowels.
    #[default]
    Pulse,
    /// A glottal source through the formants of each note's vowel (an adult male voice), with
    /// harmonics up to 4 kHz. Low voices put more energy in the second and third harmonics
    /// than in the fundamental, as real ones do.
    Vowel,
}

/// What the guide plays while the singer sings, and so what can bleed into the microphone.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GuideMode {
    /// No guide.
    #[default]
    None,
    /// The first note as a cue during the lead-in, then silence.
    Cue,
    /// The cue, then every note in unison with the singer.
    Full,
}

/// The singer, the room and the guide. Every field has a neutral default, so a profile names
/// only what it changes. Faults are relative to the key the singer chose (`key_cents`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Profile {
    // The singer.
    /// The key the singer chose, in cents from the score's: not a fault.
    pub key_cents: f32,
    /// A pitch offset for each note by index, in cents; missing entries and 0 mean none.
    pub cents_offset_per_note: Vec<f32>,
    /// Runs of notes sung off by the same amount.
    pub ranges: Vec<RangeOffset>,
    /// Runs of notes sung at another note's pitch.
    pub shifts: Vec<Shift>,
    /// Runs of notes not sung at all.
    pub silent: Vec<Span>,
    /// Notes started off and corrected while held.
    pub late_fixes: Vec<LateFix>,
    /// A steady pitch drift, in cents per second from the start of the take.
    pub drift_cents_per_second: f32,
    /// Every note starts this many cents below its pitch and glides up over `scoop_s`.
    pub scoop_cents: f32,
    pub scoop_s: f32,
    /// Vibrato depth (peak, in cents) and rate.
    pub vibrato_cents: f32,
    pub vibrato_hz: f32,
    /// A slow random wander of the pitch, by its RMS in cents.
    pub wander_cents: f32,
    pub voice: Voice,
    /// The singer's level in dB from the default.
    pub level_db: f32,
    /// The singer is silent: the take holds only the guide, the room and the noise.
    pub singer_silent: bool,

    // The room and the device.
    /// Reverberation time; 0 is a dry room.
    pub reverb_rt60_s: f32,
    /// The reverberation's level against the direct sound.
    pub reverb_wet: f32,
    /// A phone microphone's band-pass.
    pub phone: bool,
    /// White noise mixed over the whole take, by its RMS.
    pub noise_rms: f32,

    // The guide.
    pub guide: GuideMode,
    /// The key the guide plays in, in cents from the score's; `None` is the singer's key.
    pub guide_key_cents: Option<f32>,
    /// The guide's level at the microphone in dB from the singer's.
    pub bleed_db: f32,
    /// How late the guide reaches the microphone.
    pub bleed_delay_s: f32,
}

/// What a profile planted on one note, relative to the singer's key.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Planted {
    /// The deliberate offset over the note's sustained part, in cents (drift, scoops,
    /// vibrato and wander are not faults and are not counted).
    pub cents: f32,
    /// The note was not sung.
    pub silent: bool,
}

impl Profile {
    /// The offset `cents_offset_per_note` plants on note `index`, in cents.
    pub fn planted_cents(&self, index: usize) -> f32 {
        self.cents_offset_per_note.get(index).copied().unwrap_or(0.0)
    }

    /// What was planted on each of `notes`. A late fix counts by where it sits over the
    /// note's sustained part (the middle 70%), the part a scorer judges.
    pub fn planted(&self, notes: &[Note]) -> Vec<Planted> {
        (0..notes.len())
            .map(|i| {
                let silent = self.silent.iter().any(|s| s.contains(i));
                let note = &notes[i];
                let fix = self.late_fixes.iter().find(|f| f.note == i).map_or(0.0, |f| {
                    let from = 0.2 * note.dur_s;
                    let to = 0.9 * note.dur_s;
                    let mid = (from + to) / 2.0;
                    fix_offset(f, mid)
                });
                Planted {
                    cents: self.fault_cents(notes, i) + fix,
                    silent,
                }
            })
            .collect()
    }

    /// The fixed offset on note `index`: per-note, range and shift faults.
    fn fault_cents(&self, notes: &[Note], index: usize) -> f32 {
        let mut cents = self.planted_cents(index);
        for r in &self.ranges {
            if (r.first..=r.last).contains(&index) {
                cents += r.cents;
            }
        }
        for s in &self.shifts {
            if (s.first..=s.last).contains(&index) {
                let to = index as i64 + s.by as i64;
                if let Some(other) = usize::try_from(to).ok().and_then(|t| notes.get(t)) {
                    cents += (other.midi - notes[index].midi) * 100.0;
                }
            }
        }
        cents
    }

    /// The planted drift over a span of `seconds`, in cents.
    pub fn drift_over(&self, seconds: f32) -> f32 {
        self.drift_cents_per_second * seconds
    }
}

/// The offset of a late fix `t` seconds into its note.
fn fix_offset(f: &LateFix, t: f32) -> f32 {
    if f.fix_s <= 0.0 || t >= f.fix_s {
        f.residual_cents
    } else {
        f.cents + (f.residual_cents - f.cents) * t / f.fix_s
    }
}

/// A rendered take: what the microphone captured, and what the guide played (before the
/// speaker and the room), which a scorer may use to tell the guide from the singer.
#[derive(Clone, Debug, PartialEq)]
pub struct Take {
    pub samples: Vec<f32>,
    /// The guide's signal as played, on the take's clock; `None` when no guide played.
    pub guide: Option<Vec<f32>>,
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

/// Harmonic amplitudes of the pulse voice relative to the fundamental.
const PULSE_HARMONICS: [f32; 6] = [1.0, 0.6, 0.4, 0.25, 0.15, 0.08];
/// The highest harmonic frequency the vowel voice renders.
const VOWEL_TOP_HZ: f32 = 4000.0;
const ATTACK_S: f32 = 0.03;
const RELEASE_S: f32 = 0.05;
/// A note's RMS at the default level.
const NOTE_RMS: f32 = 0.1;
/// The cue ends this long before the first note.
const CUE_GAP_S: f32 = 0.4;
/// The cue starts this long after the take does.
const CUE_START_S: f32 = 0.2;

/// Renders the singer of `notes` alone, at `sample_rate`, with the faults of `profile` and
/// none of its room, device or guide: [`render_take`] without them. The take ends
/// `RELEASE_S` after the last note. The same inputs always give the same samples.
pub fn render(notes: &[Note], profile: &Profile, sample_rate: f32, seed: u64) -> Vec<f32> {
    let dry = Profile {
        reverb_rt60_s: 0.0,
        phone: false,
        guide: GuideMode::None,
        ..profile.clone()
    };
    render_take(notes, &dry, sample_rate, seed).samples
}

/// Renders a whole take: the singer (unless silent) through the room and the device, the
/// guide through its speaker and the room at `bleed_db` from the singer, and the noise.
pub fn render_take(notes: &[Note], profile: &Profile, sample_rate: f32, seed: u64) -> Take {
    let end_s = notes.iter().map(Note::end_s).fold(0.0f32, f32::max)
        + RELEASE_S
        + if profile.guide == GuideMode::None {
            0.0
        } else {
            profile.bleed_delay_s
        };
    let len = (end_s * sample_rate).ceil() as usize;
    let mut out = vec![0.0f32; len];
    let level = 10f32.powf(profile.level_db / 20.0);

    if !profile.singer_silent {
        let wander = wander_track(profile, len, sample_rate, seed);
        for (index, note) in notes.iter().enumerate() {
            if profile.silent.iter().any(|s| s.contains(index)) {
                continue;
            }
            let fixed = profile.fault_cents(notes, index);
            let fix = profile.late_fixes.iter().find(|f| f.note == index);
            let amps = harmonics(profile.voice, note, profile.key_cents + fixed);
            let pitch = |t: f32| {
                let since = t - note.start_s;
                let mut cents = profile.key_cents + fixed + profile.drift_cents_per_second * t;
                if let Some(f) = fix {
                    cents += fix_offset(f, since);
                }
                if profile.scoop_s > 0.0 && since < profile.scoop_s {
                    cents -= profile.scoop_cents * (1.0 - since / profile.scoop_s);
                }
                if profile.vibrato_cents > 0.0 {
                    cents += profile.vibrato_cents * (2.0 * std::f32::consts::PI * profile.vibrato_hz * since).sin();
                }
                note.midi + cents / 100.0
            };
            add_note(&mut out, note, &amps, level, sample_rate, |i, t| pitch(t) + wander[i] / 100.0);
        }
        if profile.reverb_rt60_s > 0.0 {
            room::reverb(&mut out, sample_rate, profile.reverb_rt60_s, profile.reverb_wet);
        }
    }

    let guide = (profile.guide != GuideMode::None && !notes.is_empty()).then(|| {
        let played = render_guide(notes, profile, len, sample_rate);
        // The guide reaches the microphone through the phone's speaker, late, and through the
        // room; its level is set against the singer's.
        let mut heard = played.clone();
        room::speaker(&mut heard, sample_rate);
        let delay = (profile.bleed_delay_s * sample_rate).round() as usize;
        if delay > 0 {
            heard.rotate_right(delay.min(len));
            heard[..delay.min(len)].fill(0.0);
        }
        if profile.reverb_rt60_s > 0.0 {
            room::reverb(&mut heard, sample_rate, profile.reverb_rt60_s, profile.reverb_wet);
        }
        let gain = 10f32.powf(profile.bleed_db / 20.0) * NOTE_RMS * level / rms_while_sounding(&heard);
        for (o, h) in out.iter_mut().zip(&heard) {
            *o += gain * h;
        }
        played
    });

    if profile.phone {
        room::phone_mic(&mut out, sample_rate);
    }
    if profile.noise_rms > 0.0 {
        // A uniform value in -1..1 has an RMS of 1/sqrt(3).
        let scale = profile.noise_rms * 3.0f32.sqrt();
        let mut rng = XorShift::new(seed);
        for s in &mut out {
            *s += scale * rng.next_signed();
        }
    }
    Take { samples: out, guide }
}

/// The guide as played: the pulse voice at its key, with no faults, the first note as a cue
/// before the take and, in [`GuideMode::Full`], every note.
fn render_guide(notes: &[Note], profile: &Profile, len: usize, sample_rate: f32) -> Vec<f32> {
    let key = profile.guide_key_cents.unwrap_or(profile.key_cents);
    let mut out = vec![0.0f32; len];
    if let Some((start, end)) = cue_span(notes) {
        let cue = Note {
            start_s: start,
            dur_s: end - start,
            ..notes[0]
        };
        let amps = harmonics(Voice::Pulse, &cue, key);
        add_note(&mut out, &cue, &amps, 1.0, sample_rate, |_, _| cue.midi + key / 100.0);
    }
    if profile.guide == GuideMode::Full {
        for note in notes {
            let amps = harmonics(Voice::Pulse, note, key);
            add_note(&mut out, note, &amps, 1.0, sample_rate, |_, _| note.midi + key / 100.0);
        }
    }
    out
}

/// When the guide's cue sounds, if the lead-in before the first note leaves room for one:
/// from [`CUE_START_S`] to [`CUE_GAP_S`] before the first note.
pub fn cue_span(notes: &[Note]) -> Option<(f32, f32)> {
    let end = notes.first()?.start_s - CUE_GAP_S;
    (end > CUE_START_S + 0.2).then_some((CUE_START_S, end))
}

/// The RMS of the samples louder than a hundredth of the peak: the level of a signal while it
/// sounds, not counting its silences.
fn rms_while_sounding(samples: &[f32]) -> f32 {
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    let floor = peak / 100.0;
    let (sum, n) = samples
        .iter()
        .filter(|s| s.abs() > floor)
        .fold((0.0f64, 0usize), |(sum, n), s| (sum + (*s as f64).powi(2), n + 1));
    if n == 0 { 1.0 } else { ((sum / n as f64).sqrt() as f32).max(1e-9) }
}

/// Adds one note to `out`: harmonics `amps` (by harmonic number from 1), a linear attack and
/// release, at the pitch `midi_at(sample index, time)`.
fn add_note(out: &mut [f32], note: &Note, amps: &[f32], level: f32, sample_rate: f32, midi_at: impl Fn(usize, f32) -> f32) {
    let len = out.len();
    let first = (note.start_s * sample_rate).round().max(0.0) as usize;
    let last = (((note.end_s() + RELEASE_S) * sample_rate).round() as usize).min(len);
    // Each harmonic's amplitude is scaled so the note's steady RMS is `NOTE_RMS`.
    let power: f32 = amps.iter().map(|a| a * a / 2.0).sum();
    let scale = if power > 0.0 { NOTE_RMS * level / power.sqrt() } else { 0.0 };
    let mut phase = 0.0f64;
    for (i, slot) in out.iter_mut().enumerate().take(last).skip(first) {
        let t = i as f32 / sample_rate;
        let env = envelope(t - note.start_s, note.dur_s);
        let hz = midi_to_hz(midi_at(i, t)) as f64;
        phase = (phase + hz / sample_rate as f64).fract();
        let mut sample = 0.0f32;
        let theta = (2.0 * std::f64::consts::PI * phase) as f32;
        for (k, amp) in amps.iter().enumerate() {
            if *amp != 0.0 {
                sample += amp * ((k + 1) as f32 * theta).sin();
            }
        }
        *slot += scale * env * sample;
    }
}

/// The harmonic amplitudes for `note` sung `cents` from its written pitch.
fn harmonics(voice: Voice, note: &Note, cents: f32) -> Vec<f32> {
    match voice {
        Voice::Pulse => PULSE_HARMONICS.to_vec(),
        Voice::Vowel => {
            let f0 = midi_to_hz(note.midi + cents / 100.0);
            let formants = formants(note.vowel);
            let count = (VOWEL_TOP_HZ / f0).floor().max(1.0) as usize;
            (1..=count)
                .map(|k| {
                    let f = k as f32 * f0;
                    // A glottal source falls 12 dB an octave and the lips lift 6 dB an octave.
                    let source = 1.0 / k as f32;
                    source * formants.iter().map(|&(fc, bw)| resonance(f, fc, bw)).product::<f32>()
                })
                .collect()
        }
    }
}

/// The gain of a two-pole resonance at `fc` with bandwidth `bw` at frequency `f`, 1 at 0 Hz.
fn resonance(f: f32, fc: f32, bw: f32) -> f32 {
    let r = f / fc;
    1.0 / ((1.0 - r * r).powi(2) + (f * bw / (fc * fc)).powi(2)).sqrt()
}

/// The first three formants (centre, bandwidth) of an adult male voice for a vowel letter;
/// an unknown or missing vowel sings as a neutral "ah".
fn formants(vowel: Option<char>) -> [(f32, f32); 3] {
    match vowel.map(|c| c.to_ascii_lowercase()) {
        Some('e') => [(530.0, 70.0), (1840.0, 100.0), (2480.0, 120.0)],
        Some('i' | 'y') => [(300.0, 60.0), (2250.0, 100.0), (3000.0, 120.0)],
        Some('o') => [(570.0, 70.0), (840.0, 80.0), (2410.0, 120.0)],
        Some('u' | 'w') => [(320.0, 60.0), (870.0, 80.0), (2240.0, 120.0)],
        _ => [(730.0, 80.0), (1090.0, 90.0), (2440.0, 120.0)],
    }
}

/// A slow random wander for every sample, in cents: a random walk sampled every 50 ms,
/// pulled back towards 0, scaled to the profile's RMS and interpolated between steps.
fn wander_track(profile: &Profile, len: usize, sample_rate: f32, seed: u64) -> Vec<f32> {
    if profile.wander_cents <= 0.0 || len == 0 {
        return vec![0.0; len];
    }
    const STEP_S: f32 = 0.05;
    // An AR(1) process with a correlation time near half a second.
    const PULL: f32 = 0.9;
    let steps = (len as f32 / sample_rate / STEP_S).ceil() as usize + 2;
    let mut rng = XorShift::new(seed ^ 0x5741_4e44_4552);
    let mut value = 0.0f32;
    let walk: Vec<f32> = (0..steps)
        .map(|_| {
            value = PULL * value + rng.next_signed();
            value
        })
        .collect();
    // The stationary RMS of x' = a x + u, u uniform in -1..1, is sqrt(1/3 / (1 - a^2)).
    let rms = (1.0 / 3.0 / (1.0 - PULL * PULL)).sqrt();
    let scale = profile.wander_cents / rms;
    (0..len)
        .map(|i| {
            let x = i as f32 / sample_rate / STEP_S;
            let j = x.floor() as usize;
            let frac = x - j as f32;
            scale * (walk[j] * (1.0 - frac) + walk[j + 1] * frac)
        })
        .collect()
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

    fn read_cents(take: &[f32], at: usize, midi: f32) -> f32 {
        let d = detect(&take[at..at + 2048], SR, DEFAULT_MIN_RMS, DEFAULT_MIN_CLARITY);
        (d.midi.expect("voiced") - midi) * 100.0
    }

    #[test]
    fn render_is_deterministic() {
        let notes = [Note::new(60.0, 0.0, 0.2)];
        let profile = Profile {
            noise_rms: 0.01,
            wander_cents: 10.0,
            ..Profile::default()
        };
        assert_eq!(render(&notes, &profile, SR, 3), render(&notes, &profile, SR, 3));
        assert_ne!(render(&notes, &profile, SR, 3), render(&notes, &profile, SR, 4));
    }

    #[test]
    fn rendered_note_reads_at_its_pitch_plus_offset() {
        let notes = [Note::new(64.0, 0.0, 0.3)];
        let profile = Profile {
            cents_offset_per_note: vec![40.0],
            ..Profile::default()
        };
        let cents = read_cents(&render(&notes, &profile, SR, 1), 4800, 64.0);
        assert!((cents - 40.0).abs() < 3.0, "read {cents:.1} cents");
    }

    #[test]
    fn key_ranges_and_shifts_move_the_pitch() {
        let notes = [Note::new(60.0, 0.0, 0.3), Note::new(64.0, 0.3, 0.3), Note::new(67.0, 0.6, 0.3)];
        let profile = Profile {
            key_cents: -500.0,
            ranges: vec![RangeOffset {
                first: 1,
                last: 1,
                cents: 200.0,
            }],
            shifts: vec![Shift { first: 0, last: 0, by: 2 }],
            ..Profile::default()
        };
        let take = render(&notes, &profile, SR, 1);
        // Note 0 is sung at note 2's pitch, note 1 a tone high, all a fourth down.
        assert!((read_cents(&take, 4800, 67.0) + 500.0).abs() < 3.0);
        assert!((read_cents(&take, 4800 + 14_400, 64.0) + 300.0).abs() < 3.0);
        let planted = profile.planted(&notes);
        assert_eq!(planted[0].cents, 700.0);
        assert_eq!(planted[1].cents, 200.0);
        assert_eq!(planted[2].cents, 0.0);
    }

    #[test]
    fn silent_notes_are_not_sung() {
        let notes = [Note::new(60.0, 0.0, 0.3), Note::new(62.0, 0.4, 0.3)];
        let profile = Profile {
            silent: vec![Span { first: 1, last: 1 }],
            ..Profile::default()
        };
        let take = render(&notes, &profile, SR, 1);
        assert!(take[(0.45 * SR) as usize..].iter().all(|s| *s == 0.0));
        assert!(profile.planted(&notes)[1].silent);
    }

    #[test]
    fn late_fix_is_planted_by_its_sustained_part() {
        let notes = [Note::new(60.0, 0.0, 1.0)];
        let quick = Profile {
            late_fixes: vec![LateFix {
                note: 0,
                cents: -200.0,
                fix_s: 0.1,
                residual_cents: 0.0,
            }],
            ..Profile::default()
        };
        assert_eq!(quick.planted(&notes)[0].cents, 0.0);
        let half = Profile {
            late_fixes: vec![LateFix {
                note: 0,
                cents: -200.0,
                fix_s: 0.1,
                residual_cents: -100.0,
            }],
            ..Profile::default()
        };
        assert_eq!(half.planted(&notes)[0].cents, -100.0);
    }

    #[test]
    fn vowel_voice_reads_at_its_pitch() {
        for (midi, vowel) in [(48.0, 'a'), (53.0, 'i'), (57.0, 'o'), (62.0, 'u'), (45.0, 'e')] {
            let notes = [Note {
                vowel: Some(vowel),
                ..Note::new(midi, 0.0, 0.4)
            }];
            let profile = Profile {
                voice: Voice::Vowel,
                ..Profile::default()
            };
            let cents = read_cents(&render(&notes, &profile, SR, 1), 4800, midi);
            assert!(cents.abs() < 5.0, "{vowel} at {midi}: {cents:.1} cents");
        }
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

    #[test]
    fn guide_bleeds_at_its_level() {
        let notes = [Note::new(60.0, 2.0, 1.0)];
        let profile = Profile {
            guide: GuideMode::Full,
            bleed_db: -20.0,
            singer_silent: true,
            ..Profile::default()
        };
        let take = render_take(&notes, &profile, SR, 1);
        let played = take.guide.expect("guide");
        assert!(played[(0.5 * SR) as usize].abs() > 0.0 || played[(0.51 * SR) as usize].abs() > 0.0);
        let mid = &take.samples[(2.3 * SR) as usize..(2.8 * SR) as usize];
        let rms = (mid.iter().map(|x| x * x).sum::<f32>() / mid.len() as f32).sqrt();
        assert!((rms / NOTE_RMS - 0.1).abs() < 0.03, "bleed at {:.3} of the singer", rms / NOTE_RMS);
    }

    #[test]
    fn the_guide_plays_in_its_own_key() {
        let notes = [Note::new(60.0, 2.0, 1.0)];
        let profile = Profile {
            guide: GuideMode::Full,
            key_cents: -300.0,
            guide_key_cents: Some(400.0),
            ..Profile::default()
        };
        let played = render_take(&notes, &profile, SR, 1).guide.expect("guide");
        let (cue, _) = cue_span(&notes).expect("a cue");
        for t in [cue + 0.1, 2.3] {
            let at = &played[(t * SR) as usize..(t * SR) as usize + 2048];
            let midi = crate::pitch::detect(at, SR, 1e-4, 0.8).midi.expect("voiced");
            assert!((midi - 64.0).abs() < 0.1, "{midi} at {t} s");
        }
    }
}
