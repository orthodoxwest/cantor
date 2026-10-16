//! Notes to sing from a GABC source, through neuma's timeline. Pitches are placed with the
//! clef's do at middle C; time is one pulse per weight unit.

use neuma::Chant;

use crate::synth::Note;

/// The MIDI-style note number of the clef's do.
pub const DO_MIDI: f32 = 60.0;

/// A layout width wide enough that line breaking never changes the timeline.
const LAYOUT_WIDTH: f32 = 4000.0;

/// The notes of `gabc` in singing order, each weight unit lasting `pulse_s` seconds.
pub fn notes_from_gabc(gabc: &str, pulse_s: f32) -> Vec<Note> {
    let chant = Chant::new(gabc);
    let timeline = chant.layout(LAYOUT_WIDTH).timeline();
    timeline
        .notes
        .iter()
        .map(|n| Note {
            midi: DO_MIDI + n.semitones as f32,
            start_s: n.start * pulse_s,
            dur_s: n.duration * pulse_s,
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
    }

    #[test]
    fn a_bar_leaves_a_gap() {
        let notes = notes_from_gabc("(c1) a(d) b(e) (:) c(f) (::)", 1.0);
        assert_eq!(notes.len(), 3);
        assert!(notes[2].start_s > notes[1].end_s() + 0.5, "{notes:?}");
    }
}
