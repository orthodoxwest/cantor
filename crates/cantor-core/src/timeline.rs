//! Notes to sing from a GABC source, through neuma's timeline. Pitches are placed with the
//! clef's do at middle C; time is one pulse per weight unit, except that recitation (a run of
//! single-note syllables on one pitch) moves at speech pace, [`RECITATION`] of a pulse.

use neuma::{BarKind, Chant, PauseKind, Timeline};

use crate::diction::{Language, Lyric, Sung, part};
use crate::grid::Part;
use crate::synth::Note;

/// The MIDI-style note number of the clef's do.
pub const DO_MIDI: f32 = 60.0;

/// A recited note's length, in pulses.
pub const RECITATION: f32 = 0.6;

/// A layout width wide enough that line breaking never changes the timeline.
const LAYOUT_WIDTH: f32 = 4000.0;

/// The notes of `gabc` in singing order, each weight unit lasting `pulse_s` seconds, with
/// their verse, phrase, part of a psalm verse and vowel.
pub fn notes_from_gabc(gabc: &str, pulse_s: f32) -> Vec<Note> {
    let chant = Chant::new(gabc);
    let timeline = chant.layout(LAYOUT_WIDTH).timeline();
    let parts = parts(&timeline);
    let mut notes = Vec::with_capacity(timeline.notes.len());
    // Recited notes are shortened, so each note starts where the last one ended plus the
    // pause the timeline left between them.
    let mut clock = 0.0f32;
    let mut prev_end = 0.0f32;
    let mut phrase = 0u32;
    let mut pauses = timeline.pauses.iter().peekable();
    for (i, n) in timeline.notes.iter().enumerate() {
        // A mediant and the bar it sits at are two pauses but one phrase break.
        let mut paused = false;
        while pauses.next_if(|p| p.before_note as usize <= i).is_some() {
            paused = true;
        }
        if paused && i > 0 {
            phrase += 1;
        }
        let gap = if i == 0 { n.start } else { (n.start - prev_end).max(0.0) };
        prev_end = n.start + n.duration;
        let duration = if n.recitation { n.duration * RECITATION } else { n.duration };
        clock += gap;
        notes.push(Note {
            midi: DO_MIDI + n.semitones as f32,
            start_s: clock * pulse_s,
            dur_s: duration * pulse_s,
            verse: n.verse,
            phrase,
            part: parts[i],
            vowel: n.vowel,
            recitation: n.recitation,
        });
        clock += duration;
    }
    notes
}

/// Where each of `timeline`'s notes falls in its verse, as a psalm tone divides one. A verse is
/// a psalm verse when its mediant `*` is at a full bar (`*(:)`), as a psalm sung to a tone is
/// written; a `*` at a lesser bar or none ends an antiphon's intonation, and its verse is sung
/// whole. In a psalm verse the notes after the mediant are its termination, those before a
/// flex `†` its flex, and the rest its mediant.
fn parts(timeline: &Timeline) -> Vec<Part> {
    let notes = &timeline.notes;
    let pauses = &timeline.pauses;
    let verse_of = |at: u32| notes.get(at as usize).map(|n| n.verse);
    let mut mediants = std::collections::BTreeMap::new();
    for (p, q) in pauses.iter().zip(pauses.iter().skip(1)) {
        let full = matches!(q.kind, PauseKind::Bar(BarKind::Full | BarKind::DottedFull));
        if p.kind == PauseKind::Mediant
            && full
            && q.before_note == p.before_note
            && let Some(verse) = verse_of(p.before_note)
        {
            mediants.entry(verse).or_insert(p.before_note as usize);
        }
    }
    let mut flexes = std::collections::BTreeMap::new();
    for p in pauses.iter().filter(|p| p.kind == PauseKind::Flex) {
        if let Some(verse) = verse_of(p.before_note)
            && mediants.get(&verse).is_some_and(|&m| (p.before_note as usize) < m)
        {
            flexes.insert(verse, p.before_note as usize);
        }
    }
    notes
        .iter()
        .enumerate()
        .map(|(i, n)| match (mediants.get(&n.verse), flexes.get(&n.verse)) {
            (None, _) => Part::Whole,
            (Some(&m), _) if i >= m => Part::Termination,
            (_, Some(&f)) if i < f => Part::Flex,
            _ => Part::Mediant,
        })
        .collect()
}

/// The notes of `gabc` with their diction, timed as [`notes_from_gabc`] times them. The
/// language is the source's `language:` header, else a guess from its words.
pub fn part_from_gabc(gabc: &str, pulse_s: f32) -> Vec<Sung> {
    part(Language::of_gabc(gabc), &lyrics_from_gabc(gabc, pulse_s))
}

/// The notes of `gabc` with their syllables' text, timed as [`notes_from_gabc`] times them.
pub fn lyrics_from_gabc(gabc: &str, pulse_s: f32) -> Vec<Lyric> {
    let timeline = Chant::new(gabc).layout(LAYOUT_WIDTH).timeline();
    notes_from_gabc(gabc, pulse_s)
        .into_iter()
        .zip(&timeline.notes)
        .map(|(note, n)| Lyric {
            note,
            text: n.syllable_text.clone(),
            word: n.word,
            syllable: n.syllable,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scale_from_do() {
        let notes = notes_from_gabc("(c1) Do(d) re(e) mi(f) fa(g) sol(h) la(i) ti(j) do(k) (::)", 0.5);
        let midi: Vec<f32> = notes.iter().map(|n| n.midi).collect();
        assert_eq!(midi, [60.0, 62.0, 64.0, 65.0, 67.0, 69.0, 71.0, 72.0]);
        for (i, n) in notes.iter().enumerate() {
            assert!((n.start_s - 0.5 * i as f32).abs() < 1e-5, "note {i} starts at {}", n.start_s);
            assert!((n.dur_s - 0.5).abs() < 1e-5);
        }
        assert_eq!(notes[1].vowel, Some('e'));
    }

    #[test]
    fn a_part_carries_its_vowels() {
        use crate::diction::Vowel;
        let sung = part_from_gabc("(c4) Sal(f)ve(gh) Re(g)gí(f)na(e) (::)", 0.5);
        let vowels: Vec<Vowel> = sung.iter().map(|s| s.diction.vowel).collect();
        assert_eq!(vowels, [Vowel::Aa, Vowel::Eh, Vowel::Eh, Vowel::Eh, Vowel::Iy, Vowel::Aa]);
        assert!(sung[1].new_syllable && !sung[2].new_syllable);
    }

    #[test]
    fn a_melisma_continued_after_a_breath_keeps_its_vowel() {
        use crate::diction::{Consonants, Vowel};
        let sung = part_from_gabc("(c4) I(g)te,(hg) (,) (gf) mis(e)sa(e) (::)", 0.5);
        let vowels: Vec<Vowel> = sung.iter().map(|s| s.diction.vowel).collect();
        assert_eq!(
            vowels,
            [Vowel::Iy, Vowel::Eh, Vowel::Eh, Vowel::Eh, Vowel::Eh, Vowel::Iy, Vowel::Aa]
        );
        assert!(sung[3].new_syllable && sung[3].note.start_s > sung[2].note.end_s());
        assert_eq!((sung[3].diction.onset, sung[3].diction.coda), (Consonants::None, Consonants::None));
    }

    #[test]
    fn a_bar_leaves_a_gap_and_starts_a_phrase() {
        let notes = notes_from_gabc("(c1) a(d) b(e) (:) c(f) (::)", 1.0);
        assert_eq!(notes.len(), 3);
        assert!(notes[2].start_s > notes[1].end_s() + 0.5, "{notes:?}");
        assert_eq!(
            notes.iter().map(|n| (n.verse, n.phrase)).collect::<Vec<_>>(),
            [(0, 0), (0, 0), (1, 1)]
        );
    }

    #[test]
    fn a_psalm_verse_is_parted_at_its_mediant_and_flex() {
        use crate::grid::Part::{Flex, Mediant, Termination, Whole};
        let parts = |gabc: &str| notes_from_gabc(gabc, 0.5).iter().map(|n| (n.verse, n.part)).collect::<Vec<_>>();
        // A mediant at a full bar parts a psalm verse; a flex before it parts the first half.
        assert_eq!(
            parts("(c4) a(h) b(g) †(,) c(h) d(i) *(:) e(h) f(g) (:) g(h) *(:) h(g) (::)"),
            [
                (0, Flex),
                (0, Flex),
                (0, Mediant),
                (0, Mediant),
                (0, Termination),
                (0, Termination),
                (1, Mediant),
                (1, Termination)
            ]
        );
        // A `*` at a lesser bar, or none, ends an antiphon's intonation, and a flex outside a psalm
        // verse is none; a bare full bar is a verse's end, not its mediant.
        for gabc in [
            "(c4) a(h) *(,) b(g) c(h) (::)",
            "(c4) a(h) *() b(g) c(h) (::)",
            "(c4) a(h) †(,) b(g) c(h) (::)",
            "(c4) a(h) b(g) (:) c(h) (::)",
        ] {
            assert!(parts(gabc).iter().all(|&(_, p)| p == Whole), "{gabc}: {:?}", parts(gabc));
        }
    }

    #[test]
    fn recitation_moves_at_speech_pace() {
        let notes = notes_from_gabc(
            "(c4) O(g) praise(h) the(j) Lord(j) all(j) ye(j) hea(k)then(j) *(:) praise(j) him(j.) (::)",
            1.0,
        );
        let durs: Vec<f32> = notes.iter().map(|n| n.dur_s).collect();
        assert_eq!(durs[0], 1.0);
        assert!((durs[3] - RECITATION).abs() < 1e-6, "{durs:?}");
        assert!(notes[3].recitation && !notes[0].recitation);
        for w in notes.windows(2) {
            assert!(w[1].start_s >= w[0].end_s() - 1e-5, "{notes:?}");
        }
        // The mediant is a pause and a phrase, not a new verse.
        assert_eq!((notes[7].verse, notes[7].phrase), (0, 0));
        assert_eq!((notes[8].verse, notes[8].phrase), (0, 1));
    }
}
