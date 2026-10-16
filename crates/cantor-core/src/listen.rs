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
//! alone is never heard as the singer. A masked note is neither right nor wrong.

use crate::pitch::{self, Frame};

/// A voiced frame must be this many times louder (in amplitude) than the guide's bleed to
/// count as the singer.
pub const MASK_MARGIN: f32 = 2.0;
/// How far back the guide's level is looked for: latency plus most of a room's tail.
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

/// Tracks `samples` at the default frame and hop, masking what the guide's bleed explains.
pub fn listen(samples: &[f32], sample_rate: f32, guide: Option<Guide>) -> Vec<Frame> {
    let frame = pitch::default_frame(sample_rate);
    let hop = (pitch::DEFAULT_HOP_S * sample_rate).round() as usize;
    let mut frames = pitch::track_with(samples, sample_rate, frame, hop, ABSOLUTE_FLOOR);
    let floor = loud_level(&frames) * 10f32.powf(-FLOOR_DB / 20.0);
    for f in &mut frames {
        if f.rms < floor {
            f.midi = None;
        }
    }
    if let Some(guide) = guide {
        let leak = leak(samples, guide, sample_rate);
        if leak > 0.0 {
            mask(&mut frames, guide.samples, leak, frame, hop);
        }
    }
    frames
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

/// The microphone's level over the guide's while the guide plays alone; 0 when the guide
/// is silent there.
pub fn leak(samples: &[f32], guide: Guide, sample_rate: f32) -> f32 {
    let from = ((guide.alone.0 + SETTLE_S) * sample_rate).round().max(0.0) as usize;
    let to = (guide.alone.1 * sample_rate).round() as usize;
    let to = to.min(samples.len()).min(guide.samples.len());
    if to <= from {
        return 0.0;
    }
    let g = rms(&guide.samples[from..to]);
    if g <= 0.0 { 0.0 } else { rms(&samples[from..to]) / g }
}

/// Masks the voiced frames no louder than [`MASK_MARGIN`] times the bleed `leak` times the
/// guide's loudest frame over the last [`BLEED_WINDOW_S`].
fn mask(frames: &mut [Frame], guide: &[f32], leak: f32, frame: usize, hop: usize) {
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
        if f.rms < MASK_MARGIN * leak * loudest {
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
