//! The browser's ear, a hand-written C ABI run in a worker beside the page: the take arrives a
//! block at a time while it is sung, and the core tracks each frame as soon as its samples are
//! in ([`Listening`]), so the page can trace the pitch as it comes, while SwiftF0 runs a
//! window at a time behind it ([`Stream`]), so stopping costs only what needs the whole take.
//! The page then asks for the take scored and judged against a chant's notes. It listens with
//! both trackers, as `cantor eval` does. Results and errors are left in the output buffer as
//! JSON or text.

use std::cell::RefCell;

use cantor_core::{
    Band, Ending, Frame, Listening, Note, Report, Verdict, again, endings, entry, judge_again, judge_part, key_at, notes_from_gabc, ribbon,
    score, summary, told, told_again,
};
use cantor_swift::{Stream, SwiftF0, track_of};
use serde::{Deserialize, Serialize};

/// A sample at least this loud is the take's first loud sample.
const ONSET_PEAK: f32 = 1e-3;

/// Numbers a frame is sent to the page as, by [`ear_frames`].
pub const FRAME_FIELDS: usize = 4;

/// A take being heard: the core's listening, and SwiftF0 behind it.
pub struct Hearing {
    listening: Listening,
    swift: Stream,
    live: Vec<Frame>,
}

/// A take heard: its frames, its frames as the live trace showed them, and its first loud
/// sample, in seconds.
pub struct Heard {
    pub frames: Vec<Frame>,
    pub live: Vec<Frame>,
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
            live: Vec::new(),
        })
    }

    /// Adds `samples` to the take: the frames they complete, as the live trace shows them
    /// (under the live floor, unvoiced; see [`Listening::push`]).
    pub fn push(&mut self, samples: &[f32]) -> Result<&[Frame], String> {
        with_swift(|s| self.swift.push(s, samples))?;
        let live = self.listening.push(samples);
        self.live.extend_from_slice(live);
        Ok(live)
    }

    /// Ends the take and listens to the whole of it.
    pub fn finish(self) -> Result<Heard, String> {
        let sample_rate = self.listening.sample_rate();
        let track = track_of(&with_swift(|s| self.swift.finish(s))?);
        let (samples, frames) = self.listening.finish(None, Some(&track));
        Ok(Heard {
            frames,
            live: self.live,
            onset: onset(&samples, sample_rate),
        })
    }
}

/// A take being heard, or heard.
enum Take {
    Hearing(Box<Hearing>),
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
    /// The take note by note, as the page draws it.
    pub ribbon: Vec<Band>,
    /// Each of the verdict's marks in words.
    pub told: Vec<String>,
    /// The take as a whole in two sentences, or none when it was not heard.
    pub summary: Vec<String>,
    /// The phrase endings the second sentence tells of as off pitch, each in words.
    pub endings: Vec<Ending>,
}

/// The notes of `gabc` at `pulse_s` a pulse, the first `offset_s` into the take, scored and
/// judged on its `frames`; given `through`, the last note sung whole in a take stopped short,
/// only to the end of the last phrase finished there (see [`finished`]).
pub fn judge_gabc(gabc: &str, pulse_s: f32, offset_s: f32, frames: &[Frame], through: Option<usize>) -> Judged {
    let mut notes = notes_from_gabc(gabc, pulse_s);
    for n in &mut notes {
        n.start_s += offset_s;
    }
    judge_notes(notes, frames, through)
}

/// How many of `notes` a take is judged on when `through` is the last note sung whole before
/// it was stopped: those to the end of the last phrase finished there, none if none was. A
/// phrase cut short would be judged as if it ended there, and its notes not sung would count
/// as not heard. A take not stopped, or stopped on or past its last note, is judged whole.
pub fn finished(notes: &[Note], through: Option<usize>) -> usize {
    let Some(i) = through.filter(|&i| i + 1 < notes.len()) else {
        return notes.len();
    };
    let at = notes[i].phrase;
    if notes[i + 1].phrase > at {
        i + 1
    } else {
        notes.iter().position(|n| n.phrase == at).unwrap_or(0)
    }
}

/// `notes`, timed on the take's clock, scored and judged on its `frames`, as [`judge_gabc`]
/// judges a chant's: given `through`, only the [`finished`] ones, with the phrase endings the
/// whole chant has ([`judge_part`]). `cantor eval` judges takes stopped short with it, so the
/// gates hold what the page is shown.
pub fn judge_notes(mut notes: Vec<Note>, frames: &[Frame], through: Option<usize>) -> Judged {
    let judged = finished(&notes, through);
    let report = score(&notes[..judged], frames);
    let verdict = judge_part(&notes, judged, &report);
    let summary = summary(&notes, &verdict);
    notes.truncate(judged);
    let ribbon = ribbon(&notes, frames, &report, &verdict);
    let told = told(&verdict);
    let endings = endings(&verdict);
    Judged {
        notes,
        report,
        verdict,
        ribbon,
        told,
        summary,
        endings,
    }
}

/// The notes `first..=last` of `gabc` at `pulse_s` a pulse sung again, the first due `offset_s`
/// into the take, scored and judged on its `frames` in `key_cents`, the key the guide sang them
/// in, beside the take of the whole chant they were sung after, judged `before`: as
/// [`judge_again_notes`] judges them.
pub fn judge_again_gabc(
    gabc: &str,
    pulse_s: f32,
    offset_s: f32,
    run: (usize, usize),
    key_cents: f32,
    before: &Verdict,
    frames: &[Frame],
) -> Judged {
    let mut notes = notes_from_gabc(gabc, pulse_s);
    let at = notes.get(run.0).map_or(0.0, |n| n.start_s);
    for n in &mut notes {
        n.start_s += offset_s - at;
    }
    judge_again_notes(notes, run.0..run.1.saturating_add(1), key_cents, before, frames)
}

/// The chant's `notes`, timed on the take's clock, of which those of `run` were sung again,
/// scored and judged on its `frames` in `key_cents` ([`judge_again`]): its notes are the run's,
/// its report theirs from the run's first, while its verdict, bands and endings are of the
/// chant's notes by index, so that they are drawn and told where the take's are. Its summary
/// tells of the run beside the take it was sung after, judged `before` ([`again`]).
pub fn judge_again_notes(mut notes: Vec<Note>, run: std::ops::Range<usize>, key_cents: f32, before: &Verdict, frames: &[Frame]) -> Judged {
    let start = run.start.min(notes.len());
    let run = start..run.end.clamp(start, notes.len());
    let report = score(&notes[run.clone()], frames);
    let verdict = judge_again(&notes, run.clone(), &report, key_cents);
    let summary = again(before, &verdict, run.clone());
    let ribbon = ribbon(&notes[run.clone()], frames, &report, &verdict.within(run.clone()))
        .into_iter()
        .map(|mut band| {
            band.index += run.start;
            band
        })
        .collect();
    let told = told_again(&verdict, &notes);
    let endings = endings(&verdict);
    notes.truncate(run.end);
    notes.drain(..run.start);
    Judged {
        notes,
        report,
        verdict,
        ribbon,
        told,
        summary,
        endings,
    }
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
/// seconds from the take's start, its pitch (NaN when unvoiced, or under the live floor),
/// clarity and RMS.
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
            TAKE.with(|t| *t.borrow_mut() = Some(Take::Hearing(Box::new(hearing))));
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
/// output buffer. Only the frames, whole and live, and the first loud sample are kept.
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

/// The heard take's first loud sample in seconds, or -1 when it has none.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_onset() -> f32 {
    TAKE.with(|t| match t.borrow().as_ref() {
        Some(Take::Heard(heard)) => heard.onset.unwrap_or(-1.0),
        _ => -1.0,
    })
}

/// When the heard take's first note starts, its first note due `due_s` seconds into the take
/// (see [`mod@cantor_core::entry`]): the length of the JSON left in the output buffer, or -1 with
/// the error there.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_entry(due_s: f32) -> i32 {
    let json = TAKE.with(|t| match t.borrow().as_ref() {
        Some(Take::Heard(_)) if !due_s.is_finite() => Err(format!("no note is due at {due_s} s")),
        Some(Take::Heard(heard)) => serde_json::to_string(&entry(&heard.live, heard.onset, due_s)).map_err(|e| e.to_string()),
        _ => Err("no take heard".to_string()),
    });
    output_json(json)
}

/// Scores and judges the heard take against the notes of the GABC in the byte buffer's first
/// `gabc_len` bytes, at `pulse_s` a pulse, starting `offset_s` into the take; when `through` is
/// not negative (the take was stopped with that note the last sung whole), only to the end of the
/// last phrase finished there ([`finished`]): the length of the JSON left in the output buffer,
/// or -1 with the error there.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_judge(gabc_len: u32, pulse_s: f32, offset_s: f32, through: i32) -> i32 {
    let gabc = BYTES.with(|b| {
        let b = b.borrow();
        String::from_utf8_lossy(&b[..(gabc_len as usize).min(b.len())]).into_owned()
    });
    let json = TAKE.with(|t| match t.borrow().as_ref() {
        Some(Take::Heard(heard)) => {
            serde_json::to_string(&judge_gabc(&gabc, pulse_s, offset_s, &heard.frames, usize::try_from(through).ok()))
                .map_err(|e| e.to_string())
        }
        _ => Err("no take heard".to_string()),
    });
    output_json(json)
}

/// Scores and judges the heard take as the notes `first..=last` of a chant sung again, in
/// `key_cents`, beside the take of the whole chant they were sung after: the byte buffer holds
/// the chant's GABC in its first `gabc_len` bytes, then that take as JSON (a [`Before`], as
/// [`ear_again_key`] reads it) in the next `before_len`; the notes are at `pulse_s` a pulse, the
/// first due `offset_s` into the take ([`judge_again_gabc`]). The length of the JSON left in the
/// output buffer, or -1 with the error there: for no key to judge in (NaN, as
/// [`ear_again_key`] gives for a take with none), or notes not of the chant.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_judge_again(
    gabc_len: u32,
    before_len: u32,
    pulse_s: f32,
    offset_s: f32,
    first: u32,
    last: u32,
    key_cents: f32,
) -> i32 {
    let (gabc, before) = BYTES.with(|b| {
        let b = b.borrow();
        let split = (gabc_len as usize).min(b.len());
        let end = split.saturating_add(before_len as usize).min(b.len());
        (
            String::from_utf8_lossy(&b[..split]).into_owned(),
            serde_json::from_slice::<Before>(&b[split..end]),
        )
    });
    let len = notes_from_gabc(&gabc, pulse_s).len();
    let (first, last) = (first as usize, last as usize);
    let json = match before {
        Err(e) => Err(format!("the take before could not be read: {e}")),
        Ok(_) if !key_cents.is_finite() => Err("no key to judge the notes sung again in".to_string()),
        Ok(_) if first > last || last >= len => Err(format!("notes {first} to {last} are not of the chant's {len}")),
        Ok(before) => TAKE.with(|t| match t.borrow().as_ref() {
            Some(Take::Heard(heard)) => serde_json::to_string(&judge_again_gabc(
                &gabc,
                pulse_s,
                offset_s,
                (first, last),
                key_cents,
                &before.verdict,
                &heard.frames,
            ))
            .map_err(|e| e.to_string()),
            _ => Err("no take heard".to_string()),
        }),
    };
    output_json(json)
}

/// A take a run is sung again after, as the page has it: its verdict and its report.
#[derive(Deserialize)]
pub struct Before {
    pub verdict: Verdict,
    pub report: Report,
}

/// The key the take in the byte buffer's first `len` bytes (a [`Before`], as JSON) was in at its
/// notes `first..=last`, in cents, for them to be sung again in, and judged in by
/// [`ear_judge_again`] ([`key_at`]); NaN when it had none, could not be read, or the notes are
/// not of its chant.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn ear_again_key(len: u32, first: u32, last: u32) -> f32 {
    BYTES.with(|b| {
        let b = b.borrow();
        let (first, last) = (first as usize, last as usize);
        serde_json::from_slice::<Before>(&b[..(len as usize).min(b.len())])
            .ok()
            .filter(|before| first <= last && last < before.verdict.relative.len())
            .and_then(|before| key_at(&before.verdict, &before.report, first..last + 1))
            .unwrap_or(f32::NAN)
    })
}

/// Leaves `json` in the output buffer and returns its length, or -1 with the error there.
fn output_json(json: Result<String, String>) -> i32 {
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

    use cantor_core::{Entry, Profile, listen_with, render_take};

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
        let len = ear_judge(bytes.len() as u32, 0.5, 1.0, -1);
        assert_eq!(len, ear_output_len() as i32);
        let json = OUTPUT.with(|o| String::from_utf8(o.borrow().clone()).expect("JSON"));
        assert_eq!(json, serde_json::to_string(&judge_gabc(gabc, 0.5, 1.0, &whole, None)).unwrap());
        // The take is timed from the frames the live trace showed, as the core hears them
        // pushed at once: its first note where the voice began.
        assert_eq!(ear_entry(f32::NAN), -1);
        let n = ear_entry(1.0);
        let timed = OUTPUT.with(|o| String::from_utf8(o.borrow().clone()).expect("JSON"));
        assert_eq!(n as usize, timed.len());
        let want = entry(&cantor_core::live(&take.samples, sr), onset(&take.samples, sr), 1.0);
        assert_eq!(serde_json::from_str::<Entry>(&timed).unwrap(), want);
        let sound = want.sound.expect("an entry");
        assert!((sound - 1.0).abs() < 0.1, "entry at {sound}");
        assert_eq!(ear_stop(), -1, "a take stops once");
        assert_eq!(ear_judge(bytes.len() as u32, 0.5, 1.0, -1), len, "and stays to be judged");
        assert!(json.contains("\"heard_fraction\""));
        // Its notes 1 to 3 sung again are judged as the ear's own judge_again_gabc judges them,
        // in the key the core reads the take was in there, from the take's verdict and report;
        // the same take is handed to both.
        let judged = judge_gabc(gabc, 0.5, 1.0, &whole, None);
        let before = format!(
            "{{\"verdict\":{},\"report\":{}}}",
            serde_json::to_string(&judged.verdict).unwrap(),
            serde_json::to_string(&judged.report).unwrap()
        );
        ear_bytes(before.len() as u32);
        BYTES.with(|b| b.borrow_mut().copy_from_slice(before.as_bytes()));
        let key = ear_again_key(before.len() as u32, 1, 3);
        assert_eq!(key, key_at(&judged.verdict, &judged.report, 1..4).expect("a key"));
        assert!(ear_again_key(3, 1, 3).is_nan(), "a take that cannot be read has no key");
        assert!(
            ear_again_key(before.len() as u32, 3, 1).is_nan(),
            "nor notes that end before they begin"
        );
        assert!(ear_again_key(before.len() as u32, 1, u32::MAX).is_nan(), "nor notes past its chant");
        let both = [bytes, before.as_bytes()].concat();
        // The take's own frames, its note 1 due where it was in the take.
        let offset = 1.0 + notes_from_gabc(gabc, 0.5)[1].start_s;
        let again_with = |first, last, key| {
            ear_bytes(both.len() as u32);
            BYTES.with(|b| b.borrow_mut().copy_from_slice(&both));
            ear_judge_again(bytes.len() as u32, before.len() as u32, 0.5, offset, first, last, key)
        };
        for (first, last, key) in [(1, 3, f32::NAN), (3, 1, key), (1, u32::MAX, key), (1, 99, key)] {
            assert_eq!(again_with(first, last, key), -1, "{first} to {last} in {key}");
        }
        let n = again_with(1, 3, key);
        let again = OUTPUT.with(|o| String::from_utf8(o.borrow().clone()).expect("JSON"));
        assert_eq!(n as usize, again.len());
        let want = judge_again_gabc(gabc, 0.5, offset, (1, 3), key, &judged.verdict, &whole);
        assert_eq!(again, serde_json::to_string(&want).unwrap());
        assert_eq!(want.verdict.outcome, cantor_core::Outcome::Heard);
        assert_eq!((want.notes.len(), want.ribbon.len(), want.ribbon[0].index), (3, 3, 1));
        // Sung from the take's own frames over the same notes, each is heard as it was in the
        // take; told beside the take, and its marks told as a run's are; each band of a note of
        // the run, as judged.
        let chant = notes_from_gabc(gabc, 0.5);
        for i in 1..4 {
            let (a, w) = (want.verdict.relative[i].expect("heard"), judged.verdict.relative[i].expect("heard"));
            assert!((a - w).abs() < 30.0, "note {i}: {a} sung again, {w} in the take");
        }
        assert_eq!(want.summary, cantor_core::again(&judged.verdict, &want.verdict, 1..4));
        assert!(!want.summary.is_empty());
        assert_eq!(want.told, told_again(&want.verdict, &chant));
        for (k, band) in want.ribbon.iter().enumerate() {
            assert_eq!(band.index, 1 + k);
            assert_eq!(band.cents, want.verdict.relative[1 + k]);
        }
        // The chant's last note is of it, and none past it.
        let last = chant.len() as u32 - 1;
        assert!(again_with(1, last, key) > 0);
        assert_eq!(again_with(1, last + 1, key), -1);
        ear_bytes(before.len() as u32);
        BYTES.with(|b| b.borrow_mut().copy_from_slice(before.as_bytes()));
        assert!(ear_again_key(before.len() as u32, 1, last).is_finite());
        assert!(ear_again_key(before.len() as u32, 1, last + 1).is_nan());
        // The take before cut short cannot be read.
        ear_bytes(both.len() as u32);
        BYTES.with(|b| b.borrow_mut().copy_from_slice(&both));
        assert_eq!(ear_judge_again(bytes.len() as u32, 3, 0.5, offset, 1, 3, key), -1);
    }

    #[test]
    fn a_take_stopped_is_judged_to_the_end_of_its_phrase() {
        let gabc = "(c4) Al(f)le(g) (,) lu(h)i(g)a.(f) (::)";
        let judged = |through| judge_gabc(gabc, 0.5, 0.0, &[], through).ribbon.len();
        assert_eq!(judged(None), 5);
        assert_eq!(judged(Some(0)), 0, "no phrase finished: nothing");
        assert_eq!(judged(Some(1)), 2, "the phrase's last note");
        assert_eq!(judged(Some(3)), 2, "to the end of the last phrase finished");
        assert_eq!(judged(Some(4)), 5, "the last note is the whole chant");
        assert_eq!(judged(Some(9)), 5, "a note past the end is the whole chant");
        // The chant's notes as judged are those the truncation finds, each where the offset puts it.
        let notes = notes_from_gabc(gabc, 0.5);
        for through in [None, Some(0), Some(1), Some(2), Some(3), Some(4), Some(9)] {
            let n = finished(&notes, through);
            assert_eq!(judged(through), n, "{through:?}");
            let shown = judge_gabc(gabc, 0.5, 2.0, &[], through);
            let timed: Vec<Note> = notes
                .iter()
                .map(|note| Note {
                    start_s: note.start_s + 2.0,
                    ..*note
                })
                .collect();
            assert_eq!(shown.notes, timed[..n]);
            assert_eq!(
                serde_json::to_string(&shown).unwrap(),
                serde_json::to_string(&judge_notes(timed, &[], through)).unwrap()
            );
        }
        assert_eq!(finished(&[], Some(0)), 0);
    }

    #[test]
    fn a_take_stopped_short_is_told_of_as_the_whole_chant_is() {
        // A psalm whose first verse alone is too little recited to be read as recited: stopped
        // in the second verse and judged on the first, its summary still speaks of the reciting
        // tone, as of the take sung whole.
        let gabc = "(c4) O(g) praise(h) the(j) Lord(j) all(j) ye(j) hea(k)then:(j.) *(:) praise(j) him(j) all(i) ye(j) na(h)tions.(g.) (::) \
            Glo(j)ry(j) be(j) to(j) the(j) Fa(j)ther,(j) and(j) to(k) the(j) Son:(j.) *(:) world(j) with(j) end(j) a(j)men.(j) (::)";
        let notes = notes_from_gabc(gabc, 0.5);
        let end = notes.last().map_or(0.0, |n| n.start_s + n.dur_s);
        let frames: Vec<Frame> = (0..(end / 0.01) as usize)
            .map(|k| {
                let t = k as f32 * 0.01;
                let sung = notes.iter().find(|n| t >= n.start_s && t < n.start_s + n.dur_s);
                Frame {
                    t,
                    midi: sung.map(|n| n.midi),
                    clarity: if sung.is_some() { 0.95 } else { 0.0 },
                    rms: if sung.is_some() { 0.1 } else { 0.0 },
                    masked: false,
                    quiet: sung.is_none(),
                    other: None,
                }
            })
            .collect();
        let stopped = judge_notes(notes.clone(), &frames, Some(20));
        assert_eq!(stopped.notes.len(), 14);
        assert_eq!(stopped.summary, summary(&notes, &stopped.verdict));
        assert!(stopped.summary[0].starts_with("Your reciting tone"), "{:?}", stopped.summary);
        assert_ne!(
            stopped.summary[0],
            summary(&notes[..14], &stopped.verdict)[0],
            "read from the notes judged alone"
        );
        assert_eq!(judge_notes(notes, &frames, None).summary[0], stopped.summary[0]);
    }

    #[test]
    fn the_onset_is_the_first_loud_sample() {
        let mut samples = vec![0.0f32; 1_600];
        samples.extend([0.0005, 0.002, 0.5]);
        assert_eq!(onset(&samples, 16_000.0), Some(1_601.0 / 16_000.0));
        assert_eq!(onset(&[0.0; 10], 16_000.0), None);
    }
}
