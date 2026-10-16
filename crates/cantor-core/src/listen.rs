//! From a take to tracked frames, telling the singer from the guide.
//!
//! A take is judged after it ends, so its loudness floor is set by the take itself: a frame
//! more than [`FLOOR_DB`] below the take's loud frames is too quiet to track, whatever the
//! microphone's gain.
//!
//! When a guide plays while the microphone listens, some of it reaches the microphone. The
//! app knows what it played, so its bleed is measured once, over a cue the guide plays alone
//! before the singer starts, as the ratio of the microphone's level to the guide's. After
//! that, a voiced frame no more than [`MASK_MARGIN`] times louder than the bleed the guide
//! could put there (its loudest level over the last [`BLEED_WINDOW_S`], which covers the
//! speaker's latency and the room's tail) is masked: its pitch is dropped whatever it is, so
//! a singer in unison with the guide and a singer off it are treated alike, and the guide
//! alone is never heard as the singer. A masked note is neither right nor wrong. When the
//! bleed cannot be measured (no cue, or a cue too short), every voiced frame while the guide
//! sounds is masked: without a measurement nothing heard then can be told from the guide.
//!
//! The window is a little longer than a phone's output latency plus the start of a room's
//! tail; a long tail decays below the margin within it, but not below the take's floor, so in
//! a very live room the guide's last notes ring on into pauses, where no note is scored.

use crate::pitch::{self, Frame};

/// A voiced frame must be this many times louder (in amplitude) than the guide's bleed to
/// count as the singer.
pub const MASK_MARGIN: f32 = 2.0;
/// How far back the guide's level is looked for: latency plus the start of a room's tail.
pub const BLEED_WINDOW_S: f32 = 0.5;
/// How far below the take's loud frames (its 95th percentile of frame RMS) a frame may be
/// and still be tracked.
pub const FLOOR_DB: f32 = 20.0;
/// The loudness floor never goes below this RMS, so digital silence is never tracked.
const ABSOLUTE_FLOOR: f32 = 5e-4;

/// The start of the cue window skipped, while the bleed and the room build up.
const SETTLE_S: f32 = 0.3;

/// The guide the app played during a take.
#[derive(Clone, Copy, Debug)]
pub struct Guide<'a> {
    /// The guide as played, on the take's clock.
    pub samples: &'a [f32],
    /// A span of the take, in seconds, when the guide plays and the singer does not.
    pub alone: (f32, f32),
}

/// Another tracker's pitches on the take's clock: frame `i` is centred at
/// `start_s + i * hop_s`, `None` where it heard no pitch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Track {
    pub start_s: f32,
    pub hop_s: f32,
    pub midi: Vec<Option<f32>>,
}

impl Track {
    /// The median of the voiced pitches whose centres lie within `half_s` of `t`, when at
    /// least half of those frames are voiced.
    fn at(&self, t: f32, half_s: f32) -> Option<f32> {
        if self.hop_s <= 0.0 {
            return None;
        }
        let first = ((t - half_s - self.start_s) / self.hop_s).ceil().max(0.0) as usize;
        let last = ((t + half_s - self.start_s) / self.hop_s).floor();
        if last < 0.0 {
            return None;
        }
        let window = self.midi.get(first..=(last as usize).min(self.midi.len().saturating_sub(1)))?;
        let mut voiced: Vec<f32> = window.iter().flatten().copied().collect();
        if voiced.is_empty() || 2 * voiced.len() < window.len() {
            return None;
        }
        voiced.sort_by(f32::total_cmp);
        Some(voiced[voiced.len() / 2])
    }
}

/// Two trackers agree on a frame when their pitches, folded into one octave, lie within this
/// many cents.
pub const AGREE_CENTS: f32 = 50.0;
/// With a second tracker, a frame whose NSDF peak is at least this clear, though below the
/// usual floor, is heard when the second tracker agrees with it.
pub const WEAK_CLARITY: f32 = 0.5;

/// Tracks `samples` at the default frame and hop, masking what the guide's bleed explains.
pub fn listen(samples: &[f32], sample_rate: f32, guide: Option<Guide>) -> Vec<Frame> {
    listen_with(samples, sample_rate, guide, None)
}

/// [`listen`] with a second tracker's opinion, `other`, recorded on each frame. A frame the
/// NSDF tracker finds clear keeps its pitch whatever the other says; one it finds only
/// [`WEAK_CLARITY`] clear is heard when the other agrees with it, so neither tracker alone
/// can add a pitch the other contradicts.
pub fn listen_with(samples: &[f32], sample_rate: f32, guide: Option<Guide>, other: Option<&Track>) -> Vec<Frame> {
    let frame = pitch::default_frame(sample_rate);
    let hop = (pitch::DEFAULT_HOP_S * sample_rate).round() as usize;
    let mut frames = pitch::track_with(samples, sample_rate, frame, hop, ABSOLUTE_FLOOR);
    if let Some(other) = other {
        let half_s = pitch::DEFAULT_HOP_S / 2.0;
        for (j, f) in frames.iter_mut().enumerate() {
            f.other = other.at(f.t, half_s);
            let Some(o) = f.other else { continue };
            if f.midi.is_some() || f.quiet {
                continue;
            }
            let start = j * hop;
            let weak = pitch::detect(&samples[start..start + frame], sample_rate, ABSOLUTE_FLOOR, WEAK_CLARITY);
            if let Some(m) = weak.midi
                && agree(m, o)
            {
                f.midi = Some(m);
                f.clarity = weak.clarity;
            }
        }
    }
    let floor = loud_level(&frames) * 10f32.powf(-FLOOR_DB / 20.0);
    for f in &mut frames {
        if f.rms < floor {
            f.midi = None;
            f.quiet = true;
        }
    }
    if let Some(guide) = guide {
        let leak = leak(samples, guide, sample_rate);
        mask(&mut frames, guide.samples, leak, frame, hop);
    }
    frames
}

/// Whether two pitches agree to within [`AGREE_CENTS`], octaves aside.
pub fn agree(a: f32, b: f32) -> bool {
    crate::score::fold((a - b) * 100.0).abs() <= AGREE_CENTS
}

/// The 95th percentile of the frames' RMS.
fn loud_level(frames: &[Frame]) -> f32 {
    let mut levels: Vec<f32> = frames.iter().map(|f| f.rms).collect();
    if levels.is_empty() {
        return 0.0;
    }
    levels.sort_by(f32::total_cmp);
    levels[(levels.len() - 1) * 95 / 100]
}

/// The shortest stretch of guide alone, after [`SETTLE_S`], that the bleed is measured over.
const MIN_ALONE_S: f32 = 0.2;

/// The microphone's level over the guide's while the guide plays alone, or `None` when it
/// cannot be measured: the span is too short or the guide is silent there.
pub fn leak(samples: &[f32], guide: Guide, sample_rate: f32) -> Option<f32> {
    let from = ((guide.alone.0 + SETTLE_S) * sample_rate).round().max(0.0) as usize;
    let to = (guide.alone.1 * sample_rate).round() as usize;
    let to = to.min(samples.len()).min(guide.samples.len());
    if to < from + (MIN_ALONE_S * sample_rate) as usize {
        return None;
    }
    let g = rms(&guide.samples[from..to]);
    (g > 0.0).then(|| rms(&samples[from..to]) / g)
}

/// Masks the voiced frames no louder than [`MASK_MARGIN`] times the bleed `leak` times the
/// guide's loudest frame over the last [`BLEED_WINDOW_S`]; with no leak, every voiced frame
/// the guide could reach.
fn mask(frames: &mut [Frame], guide: &[f32], leak: Option<f32>, frame: usize, hop: usize) {
    let levels: Vec<f32> = (0..frames.len())
        .map(|j| {
            let start = j * hop;
            guide.get(start..start + frame).map_or(0.0, rms)
        })
        .collect();
    let window = ((BLEED_WINDOW_S / pitch::DEFAULT_HOP_S).ceil() as usize).max(1);
    for (j, f) in frames.iter_mut().enumerate() {
        if f.midi.is_none() {
            continue;
        }
        let loudest = levels[j.saturating_sub(window)..=j].iter().fold(0.0f32, |m, x| m.max(*x));
        let covered = match leak {
            Some(leak) => f.rms < MASK_MARGIN * leak * loudest,
            None => loudest > 0.0,
        };
        if covered {
            f.midi = None;
            f.masked = true;
        }
    }
}

fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        0.0
    } else {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt() as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::listen_with;
    use crate::synth::{GuideMode, Note, Profile, render_take};

    const SR: f32 = 16_000.0;

    fn notes() -> Vec<Note> {
        (0..6).map(|i| Note::new(57.0 + i as f32, 2.0 + 0.5 * i as f32, 0.5)).collect()
    }

    fn voiced_in_notes(frames: &[Frame]) -> usize {
        frames.iter().filter(|f| f.t > 2.1 && f.midi.is_some()).count()
    }

    #[test]
    fn a_quiet_take_is_heard_and_its_quiet_tail_is_not() {
        let profile = Profile {
            level_db: -30.0,
            ..Profile::default()
        };
        let mut take = render_take(&notes(), &profile, SR, 1).samples;
        assert!(
            voiced_in_notes(&pitch::track(&take, SR, 1024, 480)) == 0,
            "the absolute floor is deaf to it"
        );
        assert!(voiced_in_notes(&listen(&take, SR, None)) > 40);
        // A note 30 dB below the rest is under the take's floor.
        let quiet = (4.6 * SR) as usize;
        for s in &mut take[quiet..] {
            *s *= 0.03;
        }
        let frames = listen(&take, SR, None);
        assert!(frames.iter().filter(|f| f.t > 4.7 && f.midi.is_some()).count() == 0);
    }

    #[test]
    fn the_guide_alone_is_not_heard() {
        let profile = Profile {
            guide: GuideMode::Full,
            bleed_db: -12.0,
            bleed_delay_s: 0.08,
            singer_silent: true,
            reverb_rt60_s: 0.8,
            reverb_wet: 0.3,
            ..Profile::default()
        };
        let take = render_take(&notes(), &profile, SR, 1);
        let guide = take.guide.as_deref().expect("guide");
        let unguarded = listen(&take.samples, SR, None);
        assert!(voiced_in_notes(&unguarded) > 20, "the bleed should be loud enough to track");
        let frames = listen(
            &take.samples,
            SR,
            Some(Guide {
                samples: guide,
                alone: (0.2, 1.6),
            }),
        );
        assert_eq!(voiced_in_notes(&frames), 0);
    }

    #[test]
    fn with_no_cue_nothing_is_heard_while_the_guide_plays() {
        let profile = Profile {
            guide: GuideMode::Full,
            bleed_db: -12.0,
            ..Profile::default()
        };
        let take = render_take(&notes(), &profile, SR, 1);
        let guide = take.guide.as_deref().expect("guide");
        for alone in [(0.0, 0.0), (0.0, 0.4), (1.0, 1.2)] {
            let frames = listen(&take.samples, SR, Some(Guide { samples: guide, alone }));
            assert_eq!(voiced_in_notes(&frames), 0, "{alone:?}");
        }
    }

    /// A track that hears `cents` away from each note, every 16 ms.
    fn track_off(notes: &[Note], cents: f32, len_s: f32) -> Track {
        let hop_s = 0.016;
        let midi = (0..(len_s / hop_s) as usize)
            .map(|i| {
                let t = i as f32 * hop_s;
                notes
                    .iter()
                    .find(|n| t >= n.start_s && t < n.end_s())
                    .map(|n| n.midi + cents / 100.0)
            })
            .collect();
        Track { start_s: 0.0, hop_s, midi }
    }

    #[test]
    fn a_second_tracker_hears_unclear_frames_only_when_it_agrees() {
        let profile = Profile {
            noise_rms: 0.06,
            ..Profile::default()
        };
        let take = render_take(&notes(), &profile, SR, 3).samples;
        let len_s = take.len() as f32 / SR;
        let alone = voiced_in_notes(&listen(&take, SR, None));
        let agreeing = listen_with(&take, SR, None, Some(&track_off(&notes(), 0.0, len_s)));
        let disagreeing = listen_with(&take, SR, None, Some(&track_off(&notes(), 300.0, len_s)));
        assert!(voiced_in_notes(&agreeing) > alone + 10, "{alone} -> {}", voiced_in_notes(&agreeing));
        assert_eq!(voiced_in_notes(&disagreeing), alone);
        assert!(agreeing.iter().filter(|f| f.t > 2.1).all(|f| f.other.is_some() || f.t > 4.9));
    }

    #[test]
    fn a_track_is_read_at_the_frames_time() {
        let track = Track {
            start_s: 0.0,
            hop_s: 0.016,
            midi: vec![None, Some(60.0), Some(60.2), Some(59.9), None, None, None],
        };
        assert_eq!(track.at(0.032, 0.015), Some(60.2));
        assert_eq!(track.at(0.08, 0.015), None);
        assert_eq!(track.at(1.0, 0.015), None);
    }

    #[test]
    fn the_singer_over_the_guide_is_heard() {
        let profile = Profile {
            guide: GuideMode::Full,
            bleed_db: -12.0,
            bleed_delay_s: 0.08,
            ..Profile::default()
        };
        let take = render_take(&notes(), &profile, SR, 1);
        let guide = take.guide.as_deref().expect("guide");
        let frames = listen(
            &take.samples,
            SR,
            Some(Guide {
                samples: guide,
                alone: (0.2, 1.6),
            }),
        );
        let masked = frames.iter().filter(|f| f.t > 2.1 && f.t < 4.9 && f.masked).count();
        assert_eq!(masked, 0);
    }
}
