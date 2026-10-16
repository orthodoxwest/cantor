//! From a take to tracked frames, telling the singer from the guide.
//!
//! A take is judged after it ends, so its loudness floor is set by the take itself: a frame
//! more than [`FLOOR_DB`] below the take's loud frames is too quiet to track, whatever the
//! microphone's gain.
//!
//! While it is sung, the take's loud frames are not yet known, so the live trace has a floor
//! of its own, [`LIVE_MARGIN_DB`] above the room: the quietest the take has been, held over
//! [`LIVE_ROOM_FRAMES`] frames together so that one frame caught at a note's start or end is
//! not taken for it. Exact zeros (a device's warm-up, a gap) are not the room, but a second
//! of them is digital silence, which leaves only [`LIVE_MIN_RMS`] under the floor. Until the
//! room is heard, and when it is louder than [`LIVE_ROOM_MAX`], the floor is the margin over
//! that. A pitch that shows while the singer is silent misleads, so the live floor can be
//! stricter than the take's: a quiet note the result hears may not show live, and a singer
//! under -30 dBFS who starts before the room is heard shows only once it is.
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
/// How far above the room a frame must be to show in the live trace.
pub const LIVE_MARGIN_DB: f32 = 10.0;
/// The live trace's floor never goes below this RMS (-54 dBFS).
pub const LIVE_MIN_RMS: f32 = 2e-3;
/// The room is counted no louder than this RMS (-40 dBFS), so the live floor is at most
/// -30 dBFS: a take begun mid-note has no quiet frames yet, and its voice is not the room.
pub const LIVE_ROOM_MAX: f32 = 1e-2;
/// How many frames together the room is the loudest of (150 ms at the usual hop).
pub const LIVE_ROOM_FRAMES: usize = 5;

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
        if !(self.hop_s.is_finite() && self.hop_s > 0.0 && self.start_s.is_finite()) {
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
/// [`WEAK_CLARITY`] clear is heard when the other agrees with it, in the other's octave, so
/// the second tracker never voices a frame alone or moves its pitch class. Frames are fused
/// before the loudness floor and the guide's mask, which drop fused frames like any other.
pub fn listen_with(samples: &[f32], sample_rate: f32, guide: Option<Guide>, other: Option<&Track>) -> Vec<Frame> {
    let frame = pitch::default_frame(sample_rate);
    let hop = default_hop(sample_rate);
    let frames = pitch::track_with(samples, sample_rate, frame, hop, ABSOLUTE_FLOOR);
    hear(samples, sample_rate, frames, guide, other)
}

fn default_hop(sample_rate: f32) -> usize {
    ((pitch::DEFAULT_HOP_S * sample_rate).round() as usize).max(1)
}

/// What [`listen_with`] does once the take is tracked: what needs the whole take.
fn hear(samples: &[f32], sample_rate: f32, mut frames: Vec<Frame>, guide: Option<Guide>, other: Option<&Track>) -> Vec<Frame> {
    let frame = pitch::default_frame(sample_rate);
    let hop = default_hop(sample_rate);
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
                f.midi = Some(m + 12.0 * ((o - m) / 12.0).round());
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

/// A take heard as it arrives. [`Listening::push`] tracks each frame as soon as its samples
/// are in, and [`Listening::finish`] does what needs the whole take (the second tracker, the
/// loudness floor and the guide's mask), so its frames are [`listen_with`]'s exactly and
/// stopping costs only that.
#[derive(Clone, Debug)]
pub struct Listening {
    sample_rate: f32,
    frame: usize,
    hop: usize,
    samples: Vec<f32>,
    frames: Vec<Frame>,
    /// The room: the quietest the take has been, over runs of [`LIVE_ROOM_FRAMES`].
    room: f32,
    /// The last frames' RMS since the last exact zero, up to [`LIVE_ROOM_FRAMES`].
    run: Vec<f32>,
    /// How many frames of exact zeros have just been heard.
    zeros: usize,
    /// The frames the last push completed, as the live trace shows them.
    live: Vec<Frame>,
}

impl Listening {
    pub fn new(sample_rate: f32) -> Listening {
        Listening {
            sample_rate,
            frame: pitch::default_frame(sample_rate),
            hop: default_hop(sample_rate),
            samples: Vec::new(),
            frames: Vec::new(),
            room: LIVE_ROOM_MAX,
            run: Vec::new(),
            zeros: 0,
            live: Vec::new(),
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    /// The take so far.
    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    /// Adds `samples` to the take and returns the frames they complete for the live trace:
    /// unfused and unmasked, a frame under the live floor quiet (see the module's doc).
    pub fn push(&mut self, samples: &[f32]) -> &[Frame] {
        self.samples.extend_from_slice(samples);
        self.live.clear();
        let margin = 10f32.powf(LIVE_MARGIN_DB / 20.0);
        while self.frames.len() * self.hop + self.frame <= self.samples.len() {
            let start = self.frames.len() * self.hop;
            let f = pitch::frame_at(&self.samples, start, self.sample_rate, self.frame, ABSOLUTE_FLOOR);
            let floor = LIVE_MIN_RMS.max(self.room * margin);
            let mut live = f;
            if live.rms < floor {
                live.midi = None;
                live.quiet = true;
            }
            self.hear_room(f.rms);
            self.live.push(live);
            self.frames.push(f);
        }
        &self.live
    }

    /// Counts a frame of `rms` towards the room (see the module's doc).
    fn hear_room(&mut self, rms: f32) {
        if rms == 0.0 {
            self.run.clear();
            self.zeros += 1;
            if self.zeros * self.hop >= self.sample_rate as usize {
                self.room = 0.0;
            }
            return;
        }
        self.zeros = 0;
        if self.run.len() == LIVE_ROOM_FRAMES {
            self.run.remove(0);
        }
        self.run.push(rms);
        if self.run.len() == LIVE_ROOM_FRAMES {
            self.room = self.room.min(self.run.iter().fold(0.0, |m, x| m.max(*x)));
        }
    }

    /// The take and its frames, heard as [`listen_with`] hears it.
    pub fn finish(self, guide: Option<Guide>, other: Option<&Track>) -> (Vec<f32>, Vec<Frame>) {
        let frames = hear(&self.samples, self.sample_rate, self.frames, guide, other);
        (self.samples, frames)
    }
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
    use crate::synth::{GuideMode, Note, Profile, render_take};
    use crate::{listen, listen_with};

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

    /// A sine at `hz` and RMS `rms` for `seconds` at `sr`, over hiss of RMS `hiss`.
    fn hum(hz: f32, rms: f32, hiss: f32, seconds: f32, sr: f32, state: &mut u32) -> Vec<f32> {
        (0..(seconds * sr) as usize)
            .map(|i| {
                *state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = hiss * 12f32.sqrt() * (*state as f32 / u32::MAX as f32 - 0.5);
                rms * std::f32::consts::SQRT_2 * (std::f32::consts::TAU * hz * i as f32 / sr).sin() + noise
            })
            .collect()
    }

    /// `b` added into `a` from `at_s` seconds on.
    fn add(a: &mut [f32], b: &[f32], at_s: f32, sr: f32) {
        for (x, y) in a[(at_s * sr) as usize..].iter_mut().zip(b) {
            *x += y;
        }
    }

    /// The frames a take shows live, pushed a block at a time, and its frames as tracked.
    fn live(samples: &[f32], sr: f32) -> (Vec<Frame>, Vec<Frame>) {
        let mut listening = Listening::new(sr);
        let mut shown = Vec::new();
        for block in samples.chunks(128) {
            shown.extend_from_slice(listening.push(block));
        }
        (shown, listening.frames)
    }

    fn voiced<'a>(frames: impl IntoIterator<Item = &'a Frame>) -> usize {
        frames.into_iter().filter(|f| f.midi.is_some()).count()
    }

    const RATES: [f32; 3] = [16_000.0, 44_100.0, 48_000.0];

    #[test]
    fn the_live_trace_shows_no_pitch_while_the_singer_is_silent() {
        // A room humming at -46 dBFS after a device's warm-up of zeros, the singer at
        // -20 dBFS from 1 s to 2 s, a gap of zeros, and the hum on.
        for sr in RATES {
            for lead_s in [0.0, 0.2, 0.213, 0.37] {
                let mut state = 5;
                let mut take = vec![0.0; (lead_s * sr) as usize];
                take.extend(hum(110.0, 0.005, 1e-4, 3.0, sr, &mut state));
                add(&mut take, &hum(220.0, 0.1, 0.0, 1.0, sr, &mut state), lead_s + 1.0, sr);
                let gap = (lead_s + 2.4) * sr;
                take[gap as usize..(gap + 0.05 * sr) as usize].fill(0.0);
                let (shown, tracked) = live(&take, sr);
                let silent = |f: &&Frame| {
                    let t = f.t - lead_s;
                    (0.2..0.95).contains(&t) || t > 2.1
                };
                assert!(
                    tracked.iter().filter(silent).all(|f| f.midi.is_some() || f.rms < 0.004),
                    "{sr} {lead_s}: the tracker hears the hum"
                );
                assert_eq!(voiced(shown.iter().filter(silent)), 0, "{sr} {lead_s}: the live trace does not");
                let sung = shown.iter().filter(|f| (1.05..1.95).contains(&(f.t - lead_s)));
                assert!(sung.clone().count() > 20);
                assert!(
                    sung.into_iter().all(|f| f.midi.is_some_and(|m| (m - 57.0).abs() < 0.1)),
                    "{sr} {lead_s}"
                );
            }
        }
    }

    #[test]
    fn a_quiet_singer_in_a_quiet_room_shows_live_as_the_result_hears_them() {
        for sr in RATES {
            // Loudest frames near -39 and -49 dBFS, over the minimum.
            for level_db in [-20.0, -30.0] {
                let profile = Profile {
                    level_db,
                    noise_rms: 2e-4,
                    ..Profile::default()
                };
                let take = render_take(&notes(), &profile, sr, 3);
                let (shown, _) = live(&take.samples, sr);
                let heard = listen(&take.samples, sr, None);
                let (shown, heard) = (voiced(&shown), voiced(&heard));
                assert!(
                    heard > 50 && shown * 10 >= heard * 9,
                    "{sr} {level_db} dB: {shown} shown of {heard} heard"
                );
            }
        }
    }

    #[test]
    fn the_live_trace_is_closed_under_its_minimum() {
        // A hum at -58 dBFS in a room at -70 dBFS: the margin over the room alone would show it.
        for sr in RATES {
            let mut state = 6;
            let mut take = hum(110.0, 0.0, 3.2e-4, 2.0, sr, &mut state);
            add(&mut take, &hum(110.0, 1.26e-3, 0.0, 1.0, sr, &mut state), 0.5, sr);
            add(&mut take, &hum(220.0, 0.05, 0.0, 0.5, sr, &mut state), 1.5, sr);
            let (shown, tracked) = live(&take, sr);
            let hummed = |f: &&Frame| (0.6..1.45).contains(&f.t);
            assert!(voiced(tracked.iter().filter(hummed)) > 20, "{sr}");
            assert_eq!(voiced(shown.iter().filter(hummed)), 0, "{sr}");
            assert!(
                shown.iter().filter(|f| (1.6..1.95).contains(&f.t)).all(|f| f.midi.is_some()),
                "{sr}"
            );
        }
    }

    #[test]
    fn after_a_second_of_digital_silence_only_the_minimum_holds() {
        for sr in RATES {
            let mut state = 7;
            let mut take = vec![0.0; (1.2 * sr) as usize];
            take.extend(hum(220.0, 4e-3, 0.0, 1.0, sr, &mut state));
            let (shown, _) = live(&take, sr);
            assert!(shown.iter().filter(|f| f.t > 1.3).all(|f| f.midi.is_some()), "{sr}");
        }
    }

    #[test]
    fn a_take_begun_mid_note_shows_it_over_the_rooms_cap() {
        for sr in RATES {
            let mut state = 8;
            let (shown, _) = live(&hum(220.0, 0.05, 0.0, 1.0, sr, &mut state), sr);
            assert!(shown.iter().all(|f| f.midi.is_some()), "{sr}");
            let (shown, _) = live(&hum(220.0, 0.02, 0.0, 1.0, sr, &mut state), sr);
            assert_eq!(voiced(&shown), 0, "{sr}: under -30 dBFS, it waits for the room");
        }
    }

    #[test]
    fn a_take_heard_as_it_arrives_is_heard_as_a_whole() {
        for sr in [SR, 48_000.0] {
            let profile = Profile {
                guide: GuideMode::Full,
                bleed_db: -12.0,
                bleed_delay_s: 0.08,
                noise_rms: 0.01,
                ..Profile::default()
            };
            let take = render_take(&notes(), &profile, sr, 3);
            let guide = Guide {
                samples: take.guide.as_deref().expect("guide"),
                alone: (0.2, 1.6),
            };
            let other = track_off(&notes(), 0.0, take.samples.len() as f32 / sr);
            let mut listening = Listening::new(sr);
            let mut tracked = 0;
            for (k, block) in take.samples.chunks(777).enumerate() {
                let new = listening.push(block).len();
                tracked += new;
                if k == 0 {
                    assert_eq!(new, 0, "a block shorter than a frame tracks nothing");
                }
            }
            let (samples, frames) = listening.finish(Some(guide), Some(&other));
            let whole = listen_with(&take.samples, sr, Some(guide), Some(&other));
            assert_eq!(samples, take.samples);
            assert_eq!(tracked, whole.len());
            assert_eq!(frames, whole);
            assert!(voiced_in_notes(&frames) > 0);
        }
    }

    #[test]
    fn a_second_tracker_hearing_the_guide_adds_nothing_the_mask_would_drop() {
        let profile = Profile {
            guide: GuideMode::Full,
            bleed_db: -12.0,
            bleed_delay_s: 0.08,
            singer_silent: true,
            noise_rms: 0.01,
            ..Profile::default()
        };
        let take = render_take(&notes(), &profile, SR, 1);
        let guide = Guide {
            samples: take.guide.as_deref().expect("guide"),
            alone: (0.2, 1.6),
        };
        let len_s = take.samples.len() as f32 / SR;
        let frames = listen_with(&take.samples, SR, Some(guide), Some(&track_off(&notes(), 0.0, len_s)));
        assert_eq!(voiced_in_notes(&frames), 0);
    }

    #[test]
    fn a_fused_frame_takes_the_second_trackers_octave() {
        let profile = Profile {
            noise_rms: 0.06,
            ..Profile::default()
        };
        let take = render_take(&notes(), &profile, SR, 3).samples;
        let len_s = take.len() as f32 / SR;
        let octave_up = listen_with(&take, SR, None, Some(&track_off(&notes(), 1200.0, len_s)));
        let alone = listen(&take, SR, None);
        let fused: Vec<&Frame> = octave_up
            .iter()
            .zip(&alone)
            .filter(|(f, a)| f.midi.is_some() && a.midi.is_none())
            .map(|(f, _)| f)
            .collect();
        assert!(!fused.is_empty());
        assert!(fused.iter().all(|f| (f.midi.unwrap() - f.other.unwrap()).abs() < 0.5), "{fused:?}");
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
