//! A hand-written C ABI over `cantor-core` for the browser, in the style of neuma-wasm.
//!
//! The guide voice: the page makes the neutral [`Voice`], or writes a voice file into the
//! input buffer and makes one of it, writes a chant's GABC and its timeline's notes (see
//! [`parse_notes`]) and makes a part, then asks for the part a chunk at a time. Voices and parts are held here
//! behind handles (0 is none); samples are left in the output buffer for the page to copy
//! before its next call.

use std::cell::RefCell;

use cantor_core::diction::{Language, Lyric, Sung, part};
use cantor_core::synth::Note;
use cantor_core::{Voice, voice};

/// Notes as the page sends them, one per line: MIDI, start and duration in seconds, the word
/// and syllable indexes and the syllable's text, separated by tabs. Lines that do not parse
/// are skipped.
pub fn parse_notes(text: &str) -> Vec<Lyric> {
    text.lines()
        .filter_map(|line| {
            let mut f = line.splitn(6, '\t');
            let midi = f.next()?.parse().ok()?;
            let start_s = f.next()?.parse().ok()?;
            let dur_s = f.next()?.parse().ok()?;
            let word = f.next()?.parse().ok()?;
            let syllable = f.next()?.parse().ok()?;
            let text = f.next().unwrap_or("").to_string();
            Some(Lyric {
                note: Note { midi, start_s, dur_s },
                text,
                word,
                syllable,
            })
        })
        .collect()
}

/// The part to sing for `gabc` (read only for its language) and its timeline's notes.
pub fn make_part(gabc: &str, notes: &str) -> Vec<Sung> {
    part(Language::of_gabc(gabc), &parse_notes(notes))
}

/// Values behind handles: handle `n` is slot `n - 1`.
struct Slots<T>(Vec<Option<T>>);

impl<T> Slots<T> {
    const fn new() -> Slots<T> {
        Slots(Vec::new())
    }

    fn put(&mut self, value: T) -> u32 {
        match self.0.iter().position(Option::is_none) {
            Some(i) => {
                self.0[i] = Some(value);
                i as u32 + 1
            }
            None => {
                self.0.push(Some(value));
                self.0.len() as u32
            }
        }
    }

    fn get(&self, handle: u32) -> Option<&T> {
        self.0.get((handle as usize).checked_sub(1)?)?.as_ref()
    }

    fn take(&mut self, handle: u32) {
        if let Some(slot) = (handle as usize).checked_sub(1).and_then(|i| self.0.get_mut(i)) {
            *slot = None;
        }
    }
}

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static VOICES: RefCell<Slots<Voice>> = const { RefCell::new(Slots::new()) };
    static PARTS: RefCell<Slots<Vec<Sung>>> = const { RefCell::new(Slots::new()) };
}

// `no_mangle` is the one `unsafe` this crate allows: the exported symbols.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_hz_to_midi(hz: f32) -> f32 {
    cantor_core::hz_to_midi(hz)
}

/// Makes the input buffer `len` bytes long and returns where to write.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_input(len: u32) -> *mut u8 {
    INPUT.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        b.resize(len as usize, 0);
        b.as_mut_ptr()
    })
}

/// A voice from the voice file in the input buffer; 0 when it is not one.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_voice_new() -> u32 {
    match INPUT.with(|b| Voice::parse(&b.borrow())) {
        Ok(v) => VOICES.with(|s| s.borrow_mut().put(v)),
        Err(_) => 0,
    }
}

/// The neutral voice, made rather than recorded.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_voice_neutral() -> u32 {
    VOICES.with(|s| s.borrow_mut().put(Voice::neutral()))
}

#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_voice_free(voice: u32) {
    VOICES.with(|s| s.borrow_mut().take(voice));
}

/// The pitch (MIDI) the voice is at home at; 0 for no voice.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_voice_centre(voice: u32) -> f32 {
    VOICES.with(|s| s.borrow().get(voice).and_then(Voice::centre).unwrap_or(0.0))
}

/// A part from the input buffer: a chant's GABC in its first `gabc_len` bytes (read for its
/// language), then its notes in [`parse_notes`] form.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_part_new(gabc_len: u32) -> u32 {
    let sung = INPUT.with(|b| {
        let b = b.borrow();
        let (gabc, notes) = b.split_at((gabc_len as usize).min(b.len()));
        make_part(&String::from_utf8_lossy(gabc), &String::from_utf8_lossy(notes))
    });
    PARTS.with(|s| s.borrow_mut().put(sung))
}

#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_part_free(part: u32) {
    PARTS.with(|s| s.borrow_mut().take(part));
}

/// How many samples the whole part lasts at `sample_rate`; 0 for no part.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_part_length(part: u32, sample_rate: f32) -> u32 {
    PARTS.with(|s| s.borrow().get(part).map_or(0, |p| voice::length(p, sample_rate) as u32))
}

/// Sings `len` samples of the part with the voice from sample `from`, into the output
/// buffer, and returns where they are (silence for a missing voice or part).
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_sing(voice: u32, part: u32, sample_rate: f32, from: u32, len: u32) -> *const f32 {
    let samples = VOICES.with(|v| {
        PARTS.with(|p| match (v.borrow().get(voice), p.borrow().get(part)) {
            (Some(v), Some(p)) => voice::sing(v, p, sample_rate, from as usize, len as usize),
            _ => vec![0.0; len as usize],
        })
    });
    OUTPUT.with(|b| {
        let mut b = b.borrow_mut();
        *b = samples;
        b.as_ptr()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cantor_core::Vowel;

    fn write(bytes: &[u8]) {
        let p = cantor_input(bytes.len() as u32);
        INPUT.with(|b| assert_eq!(b.borrow().as_ptr(), p.cast_const()));
        INPUT.with(|b| b.borrow_mut().copy_from_slice(bytes));
    }

    #[test]
    fn notes_parse_from_lines() {
        let notes = parse_notes("57\t0\t0.5\t0\t0\tHave\n57\t0.5\t0.5\t1\t1\tmer\nbad line\n59\t1\t0.5\t1\t2\tcy\n");
        assert_eq!(notes.len(), 3);
        assert_eq!(notes[1].text, "mer");
        assert_eq!(notes[2].note.midi, 59.0);
    }

    #[test]
    fn a_part_reads_the_language_from_the_gabc() {
        let notes = "60\t0\t1\t0\t0\tSal\n60\t1\t1\t0\t1\tve\n";
        let latin = make_part("(c4) Sal(f)ve(g)", notes);
        assert_eq!(latin[0].diction.vowel, Vowel::Aa);
        let english = make_part("language: English;\n%%\n(c4) Sal(f)ve(g)", notes);
        assert_eq!(english[0].diction.vowel, Vowel::Ae);
    }

    #[test]
    fn handles_come_and_go() {
        write(b"nope");
        assert_eq!(cantor_voice_new(), 0);
        let gabc = b"(c4) a(f)";
        let mut input = gabc.to_vec();
        input.extend_from_slice(b"60\t0\t1\t0\t0\ta\n");
        write(&input);
        let part = cantor_part_new(gabc.len() as u32);
        assert_ne!(part, 0);
        assert!(cantor_part_length(part, 1000.0) > 1000);
        let voice = cantor_voice_neutral();
        assert_eq!(cantor_voice_centre(voice), 60.0);
        cantor_sing(voice, part, 1000.0, 0, 1000);
        OUTPUT.with(|b| assert!(b.borrow().iter().any(|&s| s != 0.0)));
        cantor_voice_free(voice);
        assert_eq!(cantor_voice_centre(voice), 0.0);
        cantor_part_free(part);
        assert_eq!(cantor_part_length(part, 1000.0), 0);
        let silent = cantor_sing(0, part, 1000.0, 0, 8);
        OUTPUT.with(|b| {
            assert_eq!(b.borrow().as_ptr(), silent);
            assert_eq!(*b.borrow(), vec![0.0; 8]);
        });
    }
}
