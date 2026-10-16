//! The guide voice. A voice is a few sung vowels, each a short steady stretch of voice with
//! its pitch periods marked; [`sing`] moves them to any pitch and length by
//! pitch-synchronous overlap-add (TD-PSOLA), which keeps each vowel's formants where they
//! were. [`Voice::neutral`] is made here from textbook formants and sings every syllable on
//! one vowel; recorded voices are built elsewhere and read from voice files. Any stretch of
//! a part renders on its own, so a player can schedule the guide in chunks.
//!
//! A voice file is little-endian: the magic `CVOX`, a u16 version (1), a u16 unit count and
//! a u32 sample rate, then per unit a u8 name length and the name (an ARPAbet vowel; units
//! with other names are skipped), an f32 pitch (MIDI), a u32 mark count, a u32 sample count,
//! the marks as u32 sample indices (one per pitch period, increasing) and the samples as
//! i16.

use std::fmt;

use crate::diction::{Consonants, Sung, Vowel};
use crate::midi_to_hz;

/// The first bytes of a voice file.
pub const MAGIC: &[u8; 4] = b"CVOX";
/// The voice file version this module reads and writes.
pub const VERSION: u16 = 1;

/// The RMS every unit is scaled to, so vowels sing at one loudness.
const UNIT_RMS: f32 = 0.1;
/// Notes closer together than this are sung legato, in one breath.
const LEGATO_GAP_S: f64 = 0.03;
const ATTACK_S: f64 = 0.04;
/// How long the voice takes to die away after a phrase's last note.
pub const RELEASE_S: f64 = 0.08;
/// The longest pitch period a unit may have, so grains never reach far past their mark.
const MAX_PERIOD_S: f64 = 0.025;
/// The longest pitch glide between two notes.
const GLIDE_S: f64 = 0.05;
/// The longest consonant dip between two syllables, and the vowel crossfade inside it.
const DIP_S: f64 = 0.07;
/// The longest closing glide of a diphthong.
const DIPHTHONG_S: f64 = 0.12;
/// The pitches a voice sings (MIDI): outside them a note is left silent.
const SINGABLE: std::ops::RangeInclusive<f32> = 12.0..=108.0;
/// The latest a note may start or the longest it may last, in seconds (an hour): beyond
/// that a part is not a chant, and is left silent rather than rendered for ever.
const LONGEST_S: f32 = 3600.0;
/// Below this RMS a unit is silent, and refused rather than amplified.
const SILENT_RMS: f32 = 1e-3;
/// The neutral vowel, a schwa: formant centres and bandwidths in hertz.
const NEUTRAL_FORMANTS: [(f64, f64); 4] = [(500.0, 80.0), (1500.0, 100.0), (2500.0, 140.0), (3500.0, 200.0)];
/// The neutral voice's pitch: middle C, the guide's DO.
const NEUTRAL_MIDI: f32 = 60.0;
const NEUTRAL_RATE: f32 = 24_000.0;

/// One sung vowel: a steady stretch of voice and its pitch marks.
#[derive(Clone, Debug, PartialEq)]
pub struct Unit {
    pub vowel: Vowel,
    /// The pitch it was sung at.
    pub midi: f32,
    /// One sample index per pitch period, increasing.
    pub marks: Vec<u32>,
    pub samples: Vec<f32>,
}

/// A set of units at one sample rate.
#[derive(Clone, Debug, PartialEq)]
pub struct Voice {
    sample_rate: f32,
    units: Vec<Unit>,
    /// Per unit, the gain that brings it to [`UNIT_RMS`].
    gains: Vec<f32>,
}

/// Why bytes are not a voice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceError {
    /// The bytes end early.
    Truncated,
    /// The magic is missing.
    NotAVoice,
    /// A version this code does not read.
    Version(u16),
    /// A unit, by index, breaks a rule: why.
    Unit(usize, &'static str),
    /// A voice file has no vowel this code sings.
    NoVowels,
    /// More units than a voice file holds.
    TooManyUnits,
    /// The sample rate is not positive.
    SampleRate,
}

impl fmt::Display for VoiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VoiceError::Truncated => write!(f, "voice file ends early"),
            VoiceError::NotAVoice => write!(f, "not a voice file"),
            VoiceError::Version(v) => write!(f, "voice file version {v} is not supported"),
            VoiceError::Unit(i, why) => write!(f, "voice unit {i}: {why}"),
            VoiceError::SampleRate => write!(f, "voice sample rate must be positive"),
            VoiceError::NoVowels => write!(f, "voice file has no vowel to sing"),
            VoiceError::TooManyUnits => write!(f, "a voice holds at most 65535 units"),
        }
    }
}

impl std::error::Error for VoiceError {}

impl Unit {
    /// A vowel made rather than recorded: the harmonics of `midi`, falling 6 dB an octave,
    /// shaped by resonances at `formants` (centre and bandwidth in hertz), 0.3 s long at
    /// `sample_rate`, with a mark on every period's peak.
    pub fn synthetic(vowel: Vowel, midi: f32, formants: &[(f64, f64)], sample_rate: f32) -> Unit {
        let (f0, sr) = (midi_to_hz(midi) as f64, sample_rate as f64);
        let n = (0.3 * sr) as usize;
        let mut amps = Vec::new();
        let mut k = 1.0;
        while k * f0 < sr / 2.0 {
            let f = k * f0;
            let mut amp = 1.0 / k;
            for &(fc, bw) in formants {
                amp /= (1.0 + ((f - fc) / (bw / 2.0)).powi(2)).sqrt();
            }
            amps.push(amp);
            k += 1.0;
        }
        let mut samples: Vec<f32> = (0..n)
            .map(|i| {
                let w = 2.0 * std::f64::consts::PI * f0 * i as f64 / sr;
                amps.iter().enumerate().map(|(k, a)| a * (w * (k + 1) as f64).cos()).sum::<f64>() as f32
            })
            .collect();
        let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        if peak > 0.0 {
            samples.iter_mut().for_each(|s| *s *= 0.5 / peak);
        }
        let period = sr / f0;
        let marks = (1..)
            .map(|k| (k as f64 * period).round() as u32)
            .take_while(|&m| (m as usize) < n.saturating_sub(1))
            .collect();
        Unit {
            vowel,
            midi,
            marks,
            samples,
        }
    }
}

impl Voice {
    /// The neutral voice: one made vowel, a schwa, that every syllable is sung on. It needs
    /// no recording, so it ships with the app and guides until a recorded voice is given.
    pub fn neutral() -> Voice {
        let unit = Unit::synthetic(Vowel::Ah, NEUTRAL_MIDI, &NEUTRAL_FORMANTS, NEUTRAL_RATE);
        Voice::new(NEUTRAL_RATE, vec![unit]).expect("the neutral unit is a valid unit")
    }

    /// A voice from units, checked: each needs a finite pitch, at least three marks,
    /// increasing, at most 25 ms apart and inside its samples, and some sound between them.
    pub fn new(sample_rate: f32, units: Vec<Unit>) -> Result<Voice, VoiceError> {
        if !sample_rate.is_finite() || sample_rate <= 0.0 {
            return Err(VoiceError::SampleRate);
        }
        if units.len() > u16::MAX as usize {
            return Err(VoiceError::TooManyUnits);
        }
        let mut gains = Vec::with_capacity(units.len());
        for (i, u) in units.iter().enumerate() {
            if !u.midi.is_finite() {
                return Err(VoiceError::Unit(i, "pitch is not finite"));
            }
            if u.marks.len() < 3 {
                return Err(VoiceError::Unit(i, "fewer than three pitch marks"));
            }
            if u.marks.windows(2).any(|w| w[1] <= w[0]) {
                return Err(VoiceError::Unit(i, "pitch marks do not increase"));
            }
            if u.marks.windows(2).any(|w| (w[1] - w[0]) as f64 > MAX_PERIOD_S * sample_rate as f64) {
                return Err(VoiceError::Unit(i, "pitch marks further apart than 25 ms"));
            }
            if u.marks.last().is_some_and(|&m| m as usize >= u.samples.len()) {
                return Err(VoiceError::Unit(i, "a pitch mark lies past the samples"));
            }
            if u.samples.iter().any(|s| !s.is_finite()) {
                return Err(VoiceError::Unit(i, "a sample is not finite"));
            }
            let (a, b) = (u.marks[0] as usize, u.marks[u.marks.len() - 1] as usize);
            let span = &u.samples[a..=b];
            let rms = (span.iter().map(|x| x * x).sum::<f32>() / span.len() as f32).sqrt();
            if rms <= SILENT_RMS {
                return Err(VoiceError::Unit(i, "silent"));
            }
            gains.push(UNIT_RMS / rms);
        }
        Ok(Voice { sample_rate, units, gains })
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    pub fn units(&self) -> &[Unit] {
        &self.units
    }

    /// The middle of the pitches the units were sung at: where the voice is at home. `None`
    /// for a voice without units.
    pub fn centre(&self) -> Option<f32> {
        let mut m: Vec<f32> = self.units.iter().map(|u| u.midi).collect();
        m.sort_by(f32::total_cmp);
        m.get(m.len() / 2).copied()
    }

    /// Reads a voice file; one without a vowel this code sings is refused.
    pub fn parse(bytes: &[u8]) -> Result<Voice, VoiceError> {
        let mut r = Reader { bytes, at: 0 };
        if r.take(4)? != MAGIC {
            return Err(VoiceError::NotAVoice);
        }
        let version = r.u16()?;
        if version != VERSION {
            return Err(VoiceError::Version(version));
        }
        let count = r.u16()? as usize;
        let sample_rate = r.u32()? as f32;
        let mut units = Vec::with_capacity(count);
        for _ in 0..count {
            let name_len = r.take(1)?[0] as usize;
            let name = std::str::from_utf8(r.take(name_len)?).unwrap_or("");
            let vowel = Vowel::from_symbol(name);
            let midi = f32::from_le_bytes(r.array()?);
            let mark_count = r.u32()? as usize;
            let sample_count = r.u32()? as usize;
            let marks: Vec<u32> = r
                .take(mark_count.checked_mul(4).ok_or(VoiceError::Truncated)?)?
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| u32::from_le_bytes(*c))
                .collect();
            let samples: Vec<f32> = r
                .take(sample_count.checked_mul(2).ok_or(VoiceError::Truncated)?)?
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| i16::from_le_bytes(*c) as f32 / 32768.0)
                .collect();
            if let Some(vowel) = vowel {
                units.push(Unit {
                    vowel,
                    midi,
                    marks,
                    samples,
                });
            }
        }
        if units.is_empty() {
            return Err(VoiceError::NoVowels);
        }
        Voice::new(sample_rate, units)
    }

    /// The voice as a file; samples are clamped to -1..1 and stored as 16-bit.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&(self.units.len() as u16).to_le_bytes());
        out.extend_from_slice(&(self.sample_rate.round() as u32).to_le_bytes());
        for u in &self.units {
            let name = u.vowel.symbol().as_bytes();
            out.push(name.len() as u8);
            out.extend_from_slice(name);
            out.extend_from_slice(&u.midi.to_le_bytes());
            out.extend_from_slice(&(u.marks.len() as u32).to_le_bytes());
            out.extend_from_slice(&(u.samples.len() as u32).to_le_bytes());
            for m in &u.marks {
                out.extend_from_slice(&m.to_le_bytes());
            }
            for s in &u.samples {
                out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
            }
        }
        out
    }

    /// The unit to sing `vowel` with near `midi`: of the units for that vowel (or, when the
    /// voice has none, for its stand-ins in turn), the one sung nearest that pitch. `None`
    /// only for a voice without units.
    pub fn unit_for(&self, vowel: Vowel, midi: f32) -> Option<usize> {
        let mut want = Some(vowel);
        while let Some(v) = want {
            let best = self
                .units
                .iter()
                .enumerate()
                .filter(|(_, u)| u.vowel == v)
                .min_by(|(_, a), (_, b)| (a.midi - midi).abs().total_cmp(&(b.midi - midi).abs()));
            if let Some((i, _)) = best {
                return Some(i);
            }
            want = v.stand_in();
        }
        (!self.units.is_empty()).then_some(0)
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], VoiceError> {
        let end = self.at.checked_add(n).ok_or(VoiceError::Truncated)?;
        let out = self.bytes.get(self.at..end).ok_or(VoiceError::Truncated)?;
        self.at = end;
        Ok(out)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], VoiceError> {
        let mut a = [0; N];
        a.copy_from_slice(self.take(N)?);
        Ok(a)
    }

    fn u16(&mut self) -> Result<u16, VoiceError> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, VoiceError> {
        Ok(u32::from_le_bytes(self.array()?))
    }
}

/// The number of samples a whole part lasts at `sample_rate`, release and the last grain
/// included.
pub fn length(part: &[Sung], sample_rate: f32) -> usize {
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return 0;
    }
    let end = part
        .iter()
        .filter(|s| singable(s))
        .map(|s| s.note.end_s() as f64 + RELEASE_S + MAX_PERIOD_S)
        .fold(0.0, f64::max);
    (end * sample_rate as f64).ceil() as usize
}

/// Whether a note is sung at all: a singable pitch, a length, and a start and length short
/// of an hour.
pub fn singable(s: &Sung) -> bool {
    let n = &s.note;
    SINGABLE.contains(&n.midi) && n.dur_s > 0.0 && n.dur_s <= LONGEST_S && n.start_s.abs() <= LONGEST_S
}

/// Sings `part` with `voice` at `sample_rate`, returning `len` samples starting at sample
/// `from`. Any stretch is rendered on its own and matches the same stretch of the whole, so
/// chunks laid end to end play as one. The same inputs always give the same samples.
pub fn sing(voice: &Voice, part: &[Sung], sample_rate: f32, from: usize, len: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; len];
    if voice.units.is_empty() || len == 0 || !sample_rate.is_finite() || sample_rate <= 0.0 {
        return out;
    }
    let mut notes: Vec<&Sung> = part.iter().filter(|s| singable(s)).collect();
    notes.sort_by(|a, b| a.note.start_s.total_cmp(&b.note.start_s));
    let sr_out = sample_rate as f64;
    let window = (from as f64 / sr_out, (from + len) as f64 / sr_out);
    let mut first = 0;
    while first < notes.len() {
        let mut last = first;
        while last + 1 < notes.len() && (notes[last + 1].note.start_s as f64) < notes[last].note.end_s() as f64 + LEGATO_GAP_S {
            last += 1;
        }
        let phrase = Phrase::new(voice, &notes[first..=last]);
        if phrase.end > window.0 - 0.1 && phrase.start < window.1 + 0.1 {
            phrase.render(voice, sr_out, from, &mut out);
        }
        first = last + 1;
    }
    out
}

/// A syllable inside a phrase: when it starts and ends, the units it is held on and closes
/// with, and the dip that leads into it.
struct Syllable {
    start: f64,
    end: f64,
    unit: usize,
    close: usize,
    glide_s: f64,
    /// The center of the consonant dip before it, and its half-width and depth.
    dip_at: f64,
    dip_half: f64,
    dip_depth: f32,
}

/// Notes sung in one breath.
struct Phrase<'a> {
    notes: &'a [&'a Sung],
    syllables: Vec<Syllable>,
    start: f64,
    /// When the last note ends.
    last_end: f64,
    /// When the release has died away.
    end: f64,
}

impl<'a> Phrase<'a> {
    fn new(voice: &Voice, notes: &'a [&'a Sung]) -> Phrase<'a> {
        let start = notes[0].note.start_s as f64;
        let last_end = notes.iter().map(|n| n.note.end_s() as f64).fold(start, f64::max);
        // Group notes into syllables: a new one at each first note of a syllable.
        let mut groups: Vec<(usize, usize)> = Vec::new();
        for (i, n) in notes.iter().enumerate() {
            if i == 0 || n.new_syllable {
                groups.push((i, i));
            } else if let Some(g) = groups.last_mut() {
                g.1 = i;
            }
        }
        let mut syllables: Vec<Syllable> = Vec::with_capacity(groups.len());
        for (k, &(a, b)) in groups.iter().enumerate() {
            let first = notes[a];
            let s_start = first.note.start_s as f64;
            let s_end = notes[a..=b].iter().map(|n| n.note.end_s() as f64).fold(s_start, f64::max);
            let mut pitches: Vec<f32> = notes[a..=b].iter().map(|n| n.note.midi).collect();
            pitches.sort_by(f32::total_cmp);
            let midi = pitches[pitches.len() / 2];
            let d = first.diction;
            let unit = voice.unit_for(d.vowel, midi).unwrap_or(0);
            let close = d.glide.and_then(|g| voice.unit_for(g, midi)).unwrap_or(unit);
            let glide_s = if close == unit {
                0.0
            } else {
                DIPHTHONG_S.min(0.3 * (s_end - s_start))
            };
            let (dip_half, dip_depth, dip_at) = if k == 0 {
                (0.0, 0.0, s_start)
            } else {
                let prev = &notes[groups[k - 1].1];
                let room = (prev.note.dur_s as f64).min(first.note.dur_s as f64);
                let half = (DIP_S / 2.0).min(0.35 * room);
                let coda = notes[groups[k - 1].0].diction.coda;
                let depth = match (coda, d.onset) {
                    (Consonants::Unvoiced, _) | (_, Consonants::Unvoiced) => 0.85,
                    (Consonants::Voiced, _) | (_, Consonants::Voiced) => 0.5,
                    _ => 0.25,
                };
                // Consonants come just before the beat, so the dip leans early.
                (half, depth, s_start - 0.4 * half)
            };
            syllables.push(Syllable {
                start: s_start,
                end: s_end,
                unit,
                close,
                glide_s,
                dip_at,
                dip_half,
                dip_depth,
            });
        }
        Phrase {
            notes,
            syllables,
            start,
            last_end,
            end: last_end + RELEASE_S,
        }
    }

    /// The pitch at `t`: each note's own, with a short raised-cosine glide between
    /// neighbours that touch.
    fn midi(&self, t: f64) -> f64 {
        let i = self.notes.partition_point(|n| (n.note.start_s as f64) <= t).saturating_sub(1);
        let here = &self.notes[i].note;
        let mut m = here.midi as f64;
        if let Some(next) = self.notes.get(i + 1) {
            let b = next.note.start_s as f64;
            let g = GLIDE_S.min(0.5 * (here.dur_s as f64).min(next.note.dur_s as f64));
            if g > 0.0 && t > b - g / 2.0 {
                let x = smooth((t - (b - g / 2.0)) / g);
                m += x * (next.note.midi as f64 - m);
            }
        }
        if i > 0 {
            let prev = &self.notes[i - 1].note;
            let b = here.start_s as f64;
            let g = GLIDE_S.min(0.5 * (prev.dur_s as f64).min(here.dur_s as f64));
            if g > 0.0 && t < b + g / 2.0 {
                let x = smooth((t - (b - g / 2.0)) / g);
                m = prev.midi as f64 + x * (m - prev.midi as f64);
            }
        }
        m
    }

    /// The loudness at `t`: attack, release and consonant dips.
    fn gain(&self, t: f64) -> f32 {
        let mut a = smooth((t - self.start) / ATTACK_S) * (1.0 - smooth((t - self.last_end) / RELEASE_S));
        for s in &self.syllables {
            if s.dip_half > 0.0 && (t - s.dip_at).abs() < s.dip_half {
                let x = (t - s.dip_at) / s.dip_half;
                a *= 1.0 - s.dip_depth as f64 * 0.5 * (1.0 + (std::f64::consts::PI * x).cos());
            }
        }
        a as f32
    }

    /// The units sounding at `t` and their weights (at most four, summing to 1).
    fn mix(&self, t: f64, out: &mut Vec<(usize, f32)>) {
        out.clear();
        let k = self.syllables.partition_point(|s| s.start <= t).saturating_sub(1);
        let own = |k: usize, w: f64, out: &mut Vec<(usize, f32)>| {
            let s = &self.syllables[k];
            let x = if s.glide_s > 0.0 {
                smooth((t - (s.end - s.glide_s)) / s.glide_s)
            } else {
                0.0
            };
            push(out, s.unit, (w * (1.0 - x)) as f32);
            push(out, s.close, (w * x) as f32);
        };
        // The crossfade into syllable j spans its dip.
        let fade = |j: usize| -> f64 {
            let s = &self.syllables[j];
            if s.dip_half > 0.0 {
                smooth((t - (s.dip_at - s.dip_half)) / (2.0 * s.dip_half))
            } else {
                1.0
            }
        };
        let x = fade(k);
        if x < 1.0 && k > 0 {
            own(k - 1, 1.0 - x, out);
            own(k, x, out);
        } else if k + 1 < self.syllables.len() && fade(k + 1) > 0.0 {
            let y = fade(k + 1);
            own(k, 1.0 - y, out);
            own(k + 1, y, out);
        } else {
            own(k, 1.0, out);
        }
    }

    fn render(&self, voice: &Voice, sr_out: f64, from: usize, out: &mut [f32]) {
        let sr_a = voice.sample_rate as f64;
        let lo = from as f64 / sr_out;
        let hi = (from + out.len()) as f64 / sr_out;
        let mut mix = Vec::with_capacity(4);
        let mut t = self.start;
        // The longest grain reaches two analysis periods either side (at most 50 ms), so
        // marks far outside the window are skipped, and the walk ends past it.
        while t < self.end && t < hi + 0.05 {
            let period = 1.0 / midi_to_hz(self.midi(t) as f32) as f64;
            if t > lo - 0.05 {
                let a = self.gain(t);
                if a > 0.0 {
                    self.mix(t, &mut mix);
                    for &(u, w) in &mix {
                        if w > 0.0 {
                            grain(voice, u, t - self.start, t, period, a * w, sr_a, sr_out, from, out);
                        }
                    }
                }
            }
            t += period;
        }
    }
}

fn push(out: &mut Vec<(usize, f32)>, unit: usize, w: f32) {
    if w <= 0.0 {
        return;
    }
    match out.iter_mut().find(|(u, _)| *u == unit) {
        Some(e) => e.1 += w,
        None => out.push((unit, w)),
    }
}

/// 0 below 0, 1 above 1, a raised-cosine step between.
fn smooth(x: f64) -> f64 {
    if x <= 0.0 {
        0.0
    } else if x >= 1.0 {
        1.0
    } else {
        0.5 - 0.5 * (std::f64::consts::PI * x).cos()
    }
}

/// Adds one grain of unit `u` centered at output time `t`: the two analysis periods around
/// the mark nearest `pos` seconds into the unit (the unit plays forward and back), under
/// a Hann window, scaled for the output period so loudness does not follow pitch.
#[allow(clippy::too_many_arguments)]
fn grain(voice: &Voice, u: usize, pos: f64, t: f64, period: f64, w: f32, sr_a: f64, sr_out: f64, from: usize, out: &mut [f32]) {
    let unit = &voice.units[u];
    let marks = &unit.marks;
    let n = marks.len();
    let (first, last) = (marks[1] as f64, marks[n - 2] as f64);
    let span = (last - first) / sr_a;
    let p = if span > 0.0 {
        let q = pos.rem_euclid(2.0 * span);
        if q > span { 2.0 * span - q } else { q }
    } else {
        0.0
    };
    let target = first + p * sr_a;
    let j = {
        let i = marks.partition_point(|&m| (m as f64) < target).clamp(1, n - 2);
        if i > 1 && target - marks[i - 1] as f64 <= marks[i] as f64 - target {
            i - 1
        } else {
            i
        }
    };
    let (left, mid, right) = (marks[j - 1] as f64, marks[j] as f64, marks[j + 1] as f64);
    let (l, r) = (mid - left, right - mid);
    let scale = (period * sr_a / ((l + r) / 2.0)).clamp(0.25, 2.0) as f32;
    let gain = w * scale * voice.gains[u];
    let start = (((t - l / sr_a) * sr_out).ceil() as i64).max(from as i64);
    let stop = (((t + r / sr_a) * sr_out).floor() as i64).min((from + out.len()) as i64 - 1);
    let samples = &unit.samples;
    for k in start..=stop {
        let tau = (k as f64 / sr_out - t) * sr_a;
        let win = if tau < 0.0 {
            0.5 * (1.0 + (std::f64::consts::PI * tau / l).cos())
        } else {
            0.5 * (1.0 + (std::f64::consts::PI * tau / r).cos())
        };
        let x = (mid + tau).max(0.0);
        let i = x.floor() as usize;
        let frac = (x - i as f64) as f32;
        let a = samples[i];
        let b = samples.get(i + 1).copied().unwrap_or(a);
        out[(k - from as i64) as usize] += gain * win as f32 * (a + frac * (b - a));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diction::Diction;
    use crate::pitch::{DEFAULT_MIN_CLARITY, DEFAULT_MIN_RMS, detect};
    use crate::synth::Note;

    const SR: f32 = 24_000.0;

    fn formant_unit(vowel: Vowel, midi: f32, formants: &[(f64, f64)]) -> Unit {
        Unit::synthetic(vowel, midi, formants, SR)
    }

    fn test_voice() -> Voice {
        Voice::new(
            SR,
            vec![
                formant_unit(Vowel::Aa, 55.0, &[(700.0, 100.0), (1150.0, 120.0), (2500.0, 200.0)]),
                formant_unit(Vowel::Iy, 55.0, &[(300.0, 80.0), (2300.0, 150.0), (3000.0, 200.0)]),
            ],
        )
        .expect("valid voice")
    }

    fn sung(midi: f32, start_s: f32, dur_s: f32, vowel: Vowel, new_syllable: bool) -> Sung {
        Sung {
            note: Note::new(midi, start_s, dur_s),
            diction: Diction {
                onset: Consonants::Unvoiced,
                vowel,
                glide: None,
                coda: Consonants::None,
            },
            new_syllable,
        }
    }

    fn whole(voice: &Voice, part: &[Sung]) -> Vec<f32> {
        sing(voice, part, SR, 0, length(part, SR))
    }

    /// Energy share of the band `lo..hi` hertz in `x`, by a plain DFT.
    fn band_share(x: &[f32], lo: f32, hi: f32) -> f32 {
        let n = x.len();
        let mut band = 0.0;
        let mut total = 0.0;
        for k in 1..n / 2 {
            let f = k as f32 * SR / n as f32;
            if f > 4000.0 {
                break;
            }
            let (mut re, mut im) = (0.0f32, 0.0f32);
            for (i, &v) in x.iter().enumerate() {
                let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos();
                let ph = 2.0 * std::f32::consts::PI * (k * i) as f32 / n as f32;
                re += w * v * ph.cos();
                im -= w * v * ph.sin();
            }
            let e = re * re + im * im;
            total += e;
            if f >= lo && f < hi {
                band += e;
            }
        }
        band / total
    }

    #[test]
    fn file_round_trip() {
        let v = test_voice();
        let back = Voice::parse(&v.to_bytes()).expect("parses");
        assert_eq!(back.units.len(), 2);
        assert_eq!(back.units[0].marks, v.units[0].marks);
        assert_eq!(back.units[1].vowel, Vowel::Iy);
        let err = back.units[0]
            .samples
            .iter()
            .zip(&v.units[0].samples)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max);
        assert!(err < 1e-4, "{err}");
    }

    #[test]
    fn bad_files_are_refused() {
        let bytes = test_voice().to_bytes();
        assert_eq!(Voice::parse(b"RIFF"), Err(VoiceError::NotAVoice));
        assert_eq!(Voice::parse(&bytes[..bytes.len() - 1]), Err(VoiceError::Truncated));
        let mut v2 = bytes.clone();
        v2[4] = 2;
        assert_eq!(Voice::parse(&v2), Err(VoiceError::Version(2)));
        let unit = Unit {
            vowel: Vowel::Aa,
            midi: 50.0,
            marks: vec![3, 2, 9],
            samples: vec![0.0; 10],
        };
        assert!(matches!(Voice::new(SR, vec![unit]), Err(VoiceError::Unit(0, _))));
        let mut quiet = test_voice().units[0].clone();
        quiet.samples.iter_mut().for_each(|s| *s *= 1e-3);
        assert_eq!(Voice::new(SR, vec![quiet]), Err(VoiceError::Unit(0, "silent")));
        let mut empty = bytes[..12].to_vec();
        empty[6..8].copy_from_slice(&0u16.to_le_bytes());
        assert_eq!(Voice::parse(&empty), Err(VoiceError::NoVowels));
    }

    #[test]
    fn unknown_units_are_skipped_and_missing_vowels_stand_in() {
        let v = test_voice();
        let mut bytes = v.to_bytes();
        // Rename the second unit "IY" to "ZZ", a name no vowel has.
        let at = bytes.windows(2).rposition(|w| w == b"IY").expect("name");
        bytes[at..at + 2].copy_from_slice(b"ZZ");
        let back = Voice::parse(&bytes).expect("parses");
        assert_eq!(back.units.len(), 1);
        let first = bytes.windows(2).position(|w| w == b"AA").expect("name");
        bytes[first..first + 2].copy_from_slice(b"ZZ");
        assert_eq!(Voice::parse(&bytes), Err(VoiceError::NoVowels));
        assert_eq!(v.unit_for(Vowel::Ay, 55.0), Some(0), "AY stands in with AA");
        assert_eq!(v.unit_for(Vowel::Ih, 55.0), Some(1), "IH stands in with IY");
        assert_eq!(v.centre(), Some(55.0));
    }

    #[test]
    fn sings_at_the_asked_pitch() {
        let v = test_voice();
        for midi in [48.0, 55.0, 62.0] {
            let take = whole(&v, &[sung(midi, 0.0, 0.6, Vowel::Aa, true)]);
            let d = detect(&take[4800..4800 + 2048], SR, DEFAULT_MIN_RMS, DEFAULT_MIN_CLARITY);
            let cents = (d.midi.expect("voiced") - midi) * 100.0;
            assert!(cents.abs() < 10.0, "at {midi}: {cents:.1} cents");
        }
    }

    #[test]
    fn formants_stay_put_when_the_pitch_moves() {
        let v = test_voice();
        for midi in [47.0, 55.0, 63.0] {
            let a = whole(&v, &[sung(midi, 0.0, 0.5, Vowel::Aa, true)]);
            let i = whole(&v, &[sung(midi, 0.0, 0.5, Vowel::Iy, true)]);
            let (a, i) = (&a[3000..3000 + 4096], &i[3000..3000 + 4096]);
            // /a/ is loud around its first two formants; /i/ around its second.
            let a_low = band_share(a, 550.0, 1300.0);
            let i_low = band_share(i, 550.0, 1300.0);
            let a_high = band_share(a, 2000.0, 3200.0);
            let i_high = band_share(i, 2000.0, 3200.0);
            assert!(a_low > 0.5 && i_low < 0.2, "at {midi}: low band a {a_low:.2} i {i_low:.2}");
            assert!(i_high > 3.0 * a_high, "at {midi}: high band a {a_high:.3} i {i_high:.3}");
        }
    }

    #[test]
    fn loudness_does_not_follow_pitch() {
        let v = test_voice();
        let rms = |midi: f32| {
            let take = whole(&v, &[sung(midi, 0.0, 0.5, Vowel::Aa, true)]);
            let s = &take[2400..9600];
            (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt()
        };
        let (low, mid, high) = (rms(45.0), rms(55.0), rms(65.0));
        assert!(
            (low / mid - 1.0).abs() < 0.35 && (high / mid - 1.0).abs() < 0.35,
            "{low} {mid} {high}"
        );
    }

    #[test]
    fn chunks_match_the_whole() {
        let v = test_voice();
        let part = [
            sung(55.0, 0.0, 0.3, Vowel::Aa, true),
            sung(57.0, 0.3, 0.3, Vowel::Iy, true),
            sung(59.0, 0.6, 0.2, Vowel::Iy, false),
            sung(52.0, 1.2, 0.4, Vowel::Aa, true),
        ];
        let all = whole(&v, &part);
        let mut joined = Vec::new();
        let mut at = 0;
        for chunk in [1000, 4321, 7, 12000, 100_000] {
            joined.extend(sing(&v, &part, SR, at, chunk));
            at += chunk;
        }
        assert_eq!(&joined[..all.len()], &all[..]);
        assert!(joined[all.len()..].iter().all(|&s| s == 0.0));
        assert_eq!(all, whole(&v, &part), "deterministic");
    }

    #[test]
    fn consonants_dip_and_rests_are_silent() {
        let v = test_voice();
        let part = [
            sung(55.0, 0.0, 0.4, Vowel::Aa, true),
            sung(55.0, 0.4, 0.4, Vowel::Iy, true),
            sung(55.0, 1.2, 0.3, Vowel::Aa, true),
        ];
        let take = whole(&v, &part);
        let rms = |a: f32, b: f32| {
            let s = &take[(a * SR) as usize..(b * SR) as usize];
            (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt()
        };
        let steady = rms(0.15, 0.3);
        assert!(rms(0.375, 0.395) < 0.5 * steady, "dip {} vs {steady}", rms(0.375, 0.395));
        assert!(rms(0.95, 1.15) < 1e-6, "rest {}", rms(0.95, 1.15));
        assert!(rms(1.25, 1.4) > 0.5 * steady);
    }

    #[test]
    fn the_neutral_voice_sings_every_vowel_on_one() {
        let v = Voice::neutral();
        assert_eq!(v.units().len(), 1);
        assert_eq!(v.centre(), Some(60.0));
        for vowel in [Vowel::Aa, Vowel::Iy, Vowel::Uw, Vowel::Oy] {
            assert_eq!(v.unit_for(vowel, 50.0), Some(0));
        }
        // A 24 kHz voice sung at 48 kHz, on pitch, loudest around the schwa's first formant.
        let sr = 48_000.0;
        for midi in [50.0, 60.0, 70.0] {
            let part = [sung(midi, 0.0, 0.6, Vowel::Iy, true)];
            let take = sing(&v, &part, sr, 0, length(&part, sr));
            let d = detect(&take[9600..9600 + 4096], sr, DEFAULT_MIN_RMS, DEFAULT_MIN_CLARITY);
            let cents = (d.midi.expect("voiced") - midi) * 100.0;
            assert!(cents.abs() < 10.0, "at {midi}: {cents:.1} cents");
        }
        let take = whole(&v, &[sung(55.0, 0.0, 0.5, Vowel::Aa, true)]);
        let low = band_share(&take[3000..3000 + 4096], 350.0, 700.0);
        assert!(low > 0.4, "{low:.2}");
    }

    #[test]
    fn an_empty_voice_or_part_is_silent() {
        let empty = Voice::new(SR, vec![]).expect("valid");
        let part = [sung(55.0, 0.0, 0.4, Vowel::Aa, true)];
        assert!(sing(&empty, &part, SR, 0, 1000).iter().all(|&s| s == 0.0));
        assert!(sing(&test_voice(), &[], SR, 0, 1000).iter().all(|&s| s == 0.0));
        assert_eq!(length(&[], SR), 0);
    }

    #[test]
    fn unsingable_notes_are_silent_and_quick() {
        let v = test_voice();
        for (midi, start_s, dur_s) in [(2000.0, 0.0, 1.0), (-500.0, 0.0, 1.0), (55.0, -1e30, 2e30), (55.0, 0.0, 1e7)] {
            let part = [sung(midi, start_s, dur_s, Vowel::Aa, true)];
            assert_eq!(length(&part, SR), 0, "{midi} {start_s} {dur_s}");
            assert!(sing(&v, &part, SR, 0, 1000).iter().all(|&s| s == 0.0));
        }
        let part = [sung(55.0, 0.0, 1.0, Vowel::Aa, true)];
        assert_eq!(length(&part, f32::INFINITY), 0);
        assert!(sing(&v, &part, f32::INFINITY, 0, 8).iter().all(|&s| s == 0.0));
    }
}
