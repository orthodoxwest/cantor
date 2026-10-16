//! When a take's first note starts. The page knows when the note was due: when the cursor
//! reached it, or the guide sang it, as the singer heard it. The singer follows a little late,
//! and the first sound is the truest measure of how late, so the take is timed by it when it
//! falls near where the note was due, and as due otherwise. `cantor eval` times every take
//! both ways and holds the marks to be the same.

use serde::{Deserialize, Serialize};

use crate::Frame;

/// How late the singer's first sound may be from where the first note was due, in seconds,
/// for the take to be timed by it.
pub const ONSET_WINDOW: f32 = 1.0;
/// And how early: a singer who starts early holds the first note until the cursor moves, so
/// an early sound says nothing of when the notes fall.
pub const ONSET_EARLY: f32 = 0.15;
/// Voiced frames in a row that make a first sound, and not a click or a breath.
const VOICED_RUN: usize = 4;
/// How far before the first voiced frame's centre the first loud sample may be and still be
/// where the voice began, in seconds: half a frame and a hop.
const SHARPEN: f32 = 0.1;

/// When a take's first note starts, in seconds of the take: when it was `due`, the singer's
/// first `sound` near it, if any, and where the notes are put (`at`), which is the sound when
/// there is one and `due` otherwise.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub due: f32,
    pub sound: Option<f32>,
    pub at: f32,
}

/// When a take's first note starts, from the frames as the live trace showed them (see
/// [`crate::Listening::push`]), the take's first loud sample (`loud`) and when the note was
/// `due`, all in seconds of the take.
pub fn entry(live: &[Frame], loud: Option<f32>, due: f32) -> Entry {
    let sound = first_sound(live, loud, due - ONSET_EARLY).filter(|&s| s <= due + ONSET_WINDOW);
    Entry {
        due,
        sound,
        at: sound.unwrap_or(due),
    }
}

/// Where the singer first sounded: the first of [`VOICED_RUN`] voiced frames in a row that
/// begin at `from` seconds or later, or the first loud sample (`loud`) when it falls just
/// before. None when nothing was voiced then, or when the voice was already going at `from`
/// (a singer humming the opening notes through the lead), so the take is timed as due.
pub fn first_sound(frames: &[Frame], loud: Option<f32>, from: f32) -> Option<f32> {
    let bound = from.max(0.0);
    let mut run = 0;
    let mut began = 0.0;
    for frame in frames {
        if frame.midi.is_none() {
            run = 0;
            continue;
        }
        if run == 0 {
            began = frame.t;
        }
        run += 1;
        if run < VOICED_RUN {
            continue;
        }
        if began >= bound {
            return Some(match loud {
                Some(l) if l >= bound && l <= began && began - l <= SHARPEN => l,
                _ => began,
            });
        }
        // A voice that began before the bound and holds past it gives no entry.
        if frame.t >= bound {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frames every 30 ms: a click at frame 10, the voice from frame 34 (1.02 s).
    fn frames(voiced: impl Fn(usize) -> bool) -> Vec<Frame> {
        (0..60)
            .map(|i| Frame {
                t: i as f32 * 0.03,
                midi: voiced(i).then_some(57.0),
                clarity: 0.0,
                rms: 0.0,
                masked: false,
                quiet: false,
                other: None,
            })
            .collect()
    }

    fn voice(i: usize) -> bool {
        i == 10 || i >= 34
    }

    fn close(a: Option<f32>, b: f32) -> bool {
        a.is_some_and(|a| (a - b).abs() < 1e-5)
    }

    #[test]
    fn the_take_is_timed_by_the_first_sound_near_where_the_note_was_due() {
        let live = frames(voice);
        let at = |due: f32| entry(&live, None, due).at;
        assert!((at(1.0) - 1.02).abs() < 1e-5);
        assert!((at(0.5) - 1.02).abs() < 1e-5);
        // A little early is the entry too: the singer led the cursor.
        assert!((at(1.1) - 1.02).abs() < 1e-5);
        // Early, the singer holds the first note until the cursor moves; too late, the sound
        // is not the entry.
        assert_eq!(
            entry(&live, None, 1.5),
            Entry {
                due: 1.5,
                sound: None,
                at: 1.5
            }
        );
        assert_eq!(entry(&live, None, 0.01).sound, None);
        assert_eq!(entry(&frames(|_| false), None, 1.0).at, 1.0);
    }

    #[test]
    fn the_first_sound_is_where_the_voice_holds_not_a_click_or_a_breath() {
        let live = frames(voice);
        assert!(close(first_sound(&live, None, 0.0), 1.02));
        // The first loud sample just before the first voiced frame sharpens it; one long before
        // (the room's noise) does not.
        assert_eq!(first_sound(&live, Some(0.96), 0.0), Some(0.96));
        assert!(close(first_sound(&live, Some(0.01), 0.0), 1.02));
        assert_eq!(first_sound(&frames(|_| false), Some(0.5), 0.0), None);
        // Humming through the lead is not the entry; the voice from 1.02 s is, when the first
        // note was due a little before it.
        let hummed = frames(|i| voice(i) || (10..20).contains(&i));
        assert!(close(first_sound(&hummed, None, 0.8), 1.02));
        // A voice already going when the note fell due gives no entry; a flicker across the
        // bound does not hide the entry after it.
        assert_eq!(first_sound(&live, None, 1.1), None);
        let flicker = frames(|i| voice(i) || i == 26 || i == 27);
        assert!(close(first_sound(&flicker, None, 0.8), 1.02));
    }
}
