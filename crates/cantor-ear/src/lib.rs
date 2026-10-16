//! The browser's ear, a hand-written C ABI run in a worker beside the page: the take arrives a
//! block at a time while it is sung and SwiftF0 tracks it as it comes, so its work keeps pace
//! with the take; when the take stops, the core listens with the NSDF tracker and SwiftF0's
//! track beside it, as `cantor eval` does. The page then asks for the take scored and judged
//! against a chant's notes. Results and errors are left in the output buffer as JSON or text.

use std::cell::RefCell;

use cantor_core::{Frame, Note, Report, Verdict, judge, listen_with, notes_from_gabc, score};
use cantor_swift::{Stream, SwiftF0};
use serde::Serialize;

/// A sample at least this loud is the take's first sound.
const ONSET_PEAK: f32 = 1e-3;

/// A take being heard, or heard.
enum Take {
    Hearing(Stream),
    Heard {
        samples: Vec<f32>,
        sample_rate: f32,
        frames: Vec<Frame>,
    },
}

thread_local! {
    static SAMPLES: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static BYTES: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static SWIFT: RefCell<Option<SwiftF0>> = const { RefCell::new(None) };
    static TAKE: RefCell<Option<Take>> = const { RefCell::new(None) };
}

/// The take scored and judged, as `ear_judge` leaves it.
#[derive(Serialize)]
pub struct Judged<'a> {
    pub notes: &'a [Note],
    pub report: Report,
    pub verdict: Verdict,
}

/// `notes` from `gabc` at `pulse_s` a pulse, `offset_s` later, scored and judged on `frames`.
pub fn judge_gabc(gabc: &str, pulse_s: f32, offset_s: f32, frames: &[Frame]) -> String {
    let mut notes = notes_from_gabc(gabc, pulse_s);
    for n in &mut notes {
        n.start_s += offset_s;
    }
    let report = score(&notes, frames);
    let verdict = judge(&notes, &report);
    serde_json::to_string(&Judged {
        notes: &notes,
        report,
        verdict,
    })
    .unwrap_or_default()
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

/// Starts a take at `sample_rate`, loading SwiftF0 the first time: 0, or -1 with the error
/// in the output buffer.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_start(sample_rate: f32) -> i32 {
    let loaded = SWIFT.with(|s| {
        let mut s = s.borrow_mut();
        if s.is_none() {
            *s = Some(SwiftF0::new().map_err(|e| format!("SwiftF0: {e}"))?);
        }
        Ok::<(), String>(())
    });
    if let Err(e) = loaded {
        return fail(e);
    }
    match Stream::new(sample_rate) {
        Ok(stream) => {
            TAKE.with(|t| *t.borrow_mut() = Some(Take::Hearing(stream)));
            0
        }
        Err(e) => fail(format!("SwiftF0: {e}")),
    }
}

/// Adds the sample buffer's first `len` samples to the take: the frames SwiftF0 has tracked
/// so far, or -1 with the error in the output buffer.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_push(len: u32) -> i32 {
    let pushed = SWIFT.with(|s| {
        let s = s.borrow();
        let swift = s.as_ref().ok_or("no take started")?;
        TAKE.with(|t| match t.borrow_mut().as_mut() {
            Some(Take::Hearing(stream)) => SAMPLES.with(|b| {
                let b = b.borrow();
                stream
                    .push(swift, &b[..(len as usize).min(b.len())])
                    .map_err(|e| format!("SwiftF0: {e}"))?;
                Ok(stream.frames() as i32)
            }),
            _ => Err("no take started".to_string()),
        })
    });
    pushed.unwrap_or_else(fail)
}

/// Ends the take and listens to it: the core's frames, or -1 with the error in the output
/// buffer.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_stop() -> i32 {
    let heard = SWIFT.with(|s| {
        let s = s.borrow();
        let swift = s.as_ref().ok_or("no take started")?;
        let Some(Take::Hearing(stream)) = TAKE.with(|t| t.borrow_mut().take()) else {
            return Err("no take started".to_string());
        };
        let sample_rate = stream.sample_rate();
        let (samples, track) = stream.finish(swift).map_err(|e| format!("SwiftF0: {e}"))?;
        let frames = listen_with(&samples, sample_rate, None, Some(&track));
        let n = frames.len() as i32;
        TAKE.with(|t| {
            *t.borrow_mut() = Some(Take::Heard {
                samples,
                sample_rate,
                frames,
            })
        });
        Ok(n)
    });
    heard.unwrap_or_else(fail)
}

/// The heard take's first sound in seconds, or -1 when it has none.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_onset() -> f32 {
    TAKE.with(|t| match t.borrow().as_ref() {
        Some(Take::Heard { samples, sample_rate, .. }) => onset(samples, *sample_rate).unwrap_or(-1.0),
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
        Some(Take::Heard { frames, .. }) => Some(judge_gabc(&gabc, pulse_s, offset_s, frames)),
        _ => None,
    });
    match json {
        Some(json) => {
            let n = json.len() as i32;
            OUTPUT.with(|o| *o.borrow_mut() = json.into_bytes());
            n
        }
        None => fail("no take heard".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_onset_is_the_first_sound() {
        let mut samples = vec![0.0f32; 1_600];
        samples.extend([0.0005, 0.002, 0.5]);
        assert_eq!(onset(&samples, 16_000.0), Some(1_601.0 / 16_000.0));
        assert_eq!(onset(&[0.0; 10], 16_000.0), None);
    }
}
