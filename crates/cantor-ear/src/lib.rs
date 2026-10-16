//! The browser's ear, a hand-written C ABI run in a worker beside the page: the take arrives a
//! block at a time while it is sung, and the core tracks each frame as soon as its samples are
//! in ([`Listening`]), so the page can trace the pitch as it comes, while SwiftF0 runs a
//! window at a time behind it ([`Stream`]), so stopping costs only what needs the whole take.
//! The page then asks for the take scored and judged against a chant's notes. It listens with
//! both trackers, as `cantor eval` does. Results and errors are left in the output buffer as
//! JSON or text.

use std::cell::RefCell;

use cantor_core::{Frame, Listening, Note, Report, Verdict, judge, notes_from_gabc, score};
use cantor_swift::{Stream, SwiftF0, track_of};
use serde::Serialize;

/// A sample at least this loud is the take's first sound.
const ONSET_PEAK: f32 = 1e-3;

/// Numbers a frame is sent to the page as, by [`ear_frames`].
pub const FRAME_FIELDS: usize = 4;

/// A take being heard: the core's listening, and SwiftF0 behind it.
pub struct Hearing {
    listening: Listening,
    swift: Stream,
}

/// A take heard: its frames and its first sound, in seconds.
pub struct Heard {
    pub frames: Vec<Frame>,
    pub onset: Option<f32>,
}

impl Hearing {
    /// Starts a take at `sample_rate`.
    pub fn new(sample_rate: f32) -> Result<Hearing, String> {
        if !(sample_rate.is_finite() && sample_rate >= 8_000.0) {
            return Err(format!("no take at {sample_rate} Hz"));
        }
        Ok(Hearing {
            listening: Listening::new(sample_rate),
            swift: with_swift(|_| Stream::new(sample_rate))?,
        })
    }

    /// Adds `samples` to the take: the frames they complete.
    pub fn push(&mut self, samples: &[f32]) -> Result<&[Frame], String> {
        with_swift(|s| self.swift.push(s, samples))?;
        Ok(self.listening.push(samples))
    }

    /// Ends the take and listens to the whole of it.
    pub fn finish(self) -> Result<Heard, String> {
        let sample_rate = self.listening.sample_rate();
        let track = track_of(&with_swift(|s| self.swift.finish(s))?);
        let (samples, frames) = self.listening.finish(None, Some(&track));
        Ok(Heard {
            frames,
            onset: onset(&samples, sample_rate),
        })
    }
}

/// A take being heard, or heard.
enum Take {
    Hearing(Hearing),
    Heard(Heard),
}

thread_local! {
    static SAMPLES: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static BYTES: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static FRAMES: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static TAKE: RefCell<Option<Take>> = const { RefCell::new(None) };
    static SWIFT: Result<SwiftF0, String> = SwiftF0::new();
}

/// `f` with the loaded model, or the reason it would not load.
fn with_swift<T>(f: impl FnOnce(&SwiftF0) -> Result<T, String>) -> Result<T, String> {
    SWIFT.with(|s| f(s.as_ref().map_err(Clone::clone)?))
}

/// A take scored and judged against a chant's notes, as `ear_judge` leaves it as JSON.
#[derive(Serialize)]
pub struct Judged {
    pub notes: Vec<Note>,
    pub report: Report,
    pub verdict: Verdict,
}

/// The notes of `gabc` at `pulse_s` a pulse, the first `offset_s` into the take, scored and
/// judged on its `frames`.
pub fn judge_gabc(gabc: &str, pulse_s: f32, offset_s: f32, frames: &[Frame]) -> Judged {
    let mut notes = notes_from_gabc(gabc, pulse_s);
    for n in &mut notes {
        n.start_s += offset_s;
    }
    let report = score(&notes, frames);
    let verdict = judge(&notes, &report);
    Judged { notes, report, verdict }
}

/// The time of the first sample at least [`ONSET_PEAK`], in seconds.
pub fn onset(samples: &[f32], sample_rate: f32) -> Option<f32> {
    samples.iter().position(|x| x.abs() >= ONSET_PEAK).map(|i| i as f32 / sample_rate)
}

fn fail(message: String) -> i32 {
    OUTPUT.with(|o| *o.borrow_mut() = message.into_bytes());
    -1
}

/// Makes the sample buffer `len` samples long and returns where to write.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_samples(len: u32) -> *mut f32 {
    SAMPLES.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        b.resize(len as usize, 0.0);
        b.as_mut_ptr()
    })
}

/// Makes the byte buffer `len` bytes long and returns where to write.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_bytes(len: u32) -> *mut u8 {
    BYTES.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        b.resize(len as usize, 0);
        b.as_mut_ptr()
    })
}

/// The output buffer and its length.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_output() -> *const u8 {
    OUTPUT.with(|o| o.borrow().as_ptr())
}

#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_output_len() -> u32 {
    OUTPUT.with(|o| o.borrow().len() as u32)
}

/// Frames as the page reads them: [`FRAME_FIELDS`] numbers each, the frame's centre in
/// seconds from the take's start, its pitch (NaN when unvoiced), clarity and RMS.
pub fn frame_fields(frames: &[Frame]) -> Vec<f32> {
    frames
        .iter()
        .flat_map(|f| [f.t, f.midi.unwrap_or(f32::NAN), f.clarity, f.rms])
        .collect()
}

/// Starts a take at `sample_rate`: 0, or -1 with the error in the output buffer.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_start(sample_rate: f32) -> i32 {
    match Hearing::new(sample_rate) {
        Ok(hearing) => {
            TAKE.with(|t| *t.borrow_mut() = Some(Take::Hearing(hearing)));
            0
        }
        Err(e) => fail(e),
    }
}

/// Adds the sample buffer's first `len` samples to the take: how many frames they complete,
/// left in the frame buffer (see [`frame_fields`]), or -1 with the error in the output buffer.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_push(len: u32) -> i32 {
    let pushed = TAKE.with(|t| match t.borrow_mut().as_mut() {
        Some(Take::Hearing(hearing)) => SAMPLES.with(|b| {
            let b = b.borrow();
            let frames = hearing.push(&b[..(len as usize).min(b.len())])?;
            FRAMES.with(|f| *f.borrow_mut() = frame_fields(frames));
            Ok(frames.len() as i32)
        }),
        _ => Err("no take started".to_string()),
    });
    pushed.unwrap_or_else(fail)
}

/// The frame buffer.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_frames() -> *const f32 {
    FRAMES.with(|f| f.borrow().as_ptr())
}

/// Ends the take and listens to it: how many frames it has, or -1 with the error in the
/// output buffer. Only the frames and the first sound are kept.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_stop() -> i32 {
    let heard = TAKE.with(|t| {
        let mut t = t.borrow_mut();
        let hearing = match t.take() {
            Some(Take::Hearing(hearing)) => hearing,
            heard => {
                // Stopped twice: the take heard stays to be judged.
                *t = heard;
                return Err("no take started".to_string());
            }
        };
        let heard = hearing.finish()?;
        let n = heard.frames.len() as i32;
        *t = Some(Take::Heard(heard));
        Ok(n)
    });
    heard.unwrap_or_else(fail)
}

/// The heard take's first sound in seconds, or -1 when it has none.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_onset() -> f32 {
    TAKE.with(|t| match t.borrow().as_ref() {
        Some(Take::Heard(heard)) => heard.onset.unwrap_or(-1.0),
        _ => -1.0,
    })
}

/// Scores and judges the heard take against the notes of the GABC in the byte buffer's first
/// `gabc_len` bytes, at `pulse_s` a pulse, starting `offset_s` into the take: the length of
/// the JSON left in the output buffer, or -1 with the error there.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_judge(gabc_len: u32, pulse_s: f32, offset_s: f32) -> i32 {
    let gabc = BYTES.with(|b| {
        let b = b.borrow();
        String::from_utf8_lossy(&b[..(gabc_len as usize).min(b.len())]).into_owned()
    });
    let json = TAKE.with(|t| match t.borrow().as_ref() {
        Some(Take::Heard(heard)) => serde_json::to_string(&judge_gabc(&gabc, pulse_s, offset_s, &heard.frames)).map_err(|e| e.to_string()),
        _ => Err("no take heard".to_string()),
    });
    match json {
        Ok(json) => {
            let n = json.len() as i32;
            OUTPUT.with(|o| *o.borrow_mut() = json.into_bytes());
            n
        }
        Err(e) => fail(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use cantor_core::{Profile, listen_with, render_take};

    /// Pushes `samples` as the worker does, through the sample buffer; the frames they
    /// complete.
    fn push(samples: &[f32]) -> Vec<f32> {
        ear_samples(samples.len() as u32);
        SAMPLES.with(|b| b.borrow_mut().copy_from_slice(samples));
        let n = ear_push(samples.len() as u32);
        assert!(n >= 0);
        FRAMES.with(|f| {
            let f = f.borrow();
            assert_eq!(f.len(), n as usize * FRAME_FIELDS);
            f.clone()
        })
    }

    #[test]
    fn the_ear_hears_a_take_as_the_core_does() {
        let sr = 48_000.0;
        let gabc = "(c4) Al(f)le(gh)lu(g)ia.(f) (::)";
        let notes: Vec<_> = notes_from_gabc(gabc, 0.5)
            .into_iter()
            .map(|mut n| {
                n.start_s += 1.0;
                n
            })
            .collect();
        let take = render_take(&notes, &Profile::default(), sr, 5);
        let track = SwiftF0::new().expect("model").track(&take.samples, sr).expect("run");
        let whole = listen_with(&take.samples, sr, None, Some(&track));
        assert_eq!(ear_push(1), -1, "nothing is heard before a take starts");
        assert_eq!(ear_start(sr), 0);
        let mut live = Vec::new();
        for block in take.samples.chunks(1_024) {
            live.extend(push(block));
        }
        assert!(whole.iter().filter(|f| f.midi.is_some()).count() > 50);
        assert_eq!(ear_stop() as usize, whole.len());
        assert_eq!(live.len(), whole.len() * FRAME_FIELDS);
        for (f, w) in live.chunks(FRAME_FIELDS).zip(&whole) {
            assert_eq!(f[0], w.t);
            assert_eq!(f[2], w.clarity);
        }
        assert_eq!(ear_onset(), onset(&take.samples, sr).expect("sound"));
        let bytes = gabc.as_bytes();
        ear_bytes(bytes.len() as u32);
        BYTES.with(|b| b.borrow_mut().copy_from_slice(bytes));
        let len = ear_judge(bytes.len() as u32, 0.5, 1.0);
        assert_eq!(len, ear_output_len() as i32);
        let json = OUTPUT.with(|o| String::from_utf8(o.borrow().clone()).expect("JSON"));
        assert_eq!(json, serde_json::to_string(&judge_gabc(gabc, 0.5, 1.0, &whole)).unwrap());
        assert_eq!(ear_stop(), -1, "a take stops once");
        assert_eq!(ear_judge(bytes.len() as u32, 0.5, 1.0), len, "and stays to be judged");
        assert!(json.contains("\"heard_fraction\""));
    }

    #[test]
    fn the_onset_is_the_first_sound() {
        let mut samples = vec![0.0f32; 1_600];
        samples.extend([0.0005, 0.002, 0.5]);
        assert_eq!(onset(&samples, 16_000.0), Some(1_601.0 / 16_000.0));
        assert_eq!(onset(&[0.0; 10], 16_000.0), None);
    }
}
