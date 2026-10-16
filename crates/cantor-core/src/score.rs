//! Scoring a tracked take against the notes it should contain: the median cents error per
//! note over its sustained part, and a few summary rates. Errors are octave-agnostic: each
//! frame's error is folded to the nearest octave of the note, so a singer an octave down is
//! on pitch and a tracker's octave error on one frame does not move the note.

use serde::{Deserialize, Serialize};

use crate::pitch::Frame;
use crate::synth::Note;

/// The fraction of a note skipped at its start (the attack and the glide in).
const SKIP_HEAD: f32 = 0.2;
/// The fraction of a note skipped at its end (the release and the glide out).
const SKIP_TAIL: f32 = 0.1;
/// Fewer voiced frames than this in the sustained part leave the note unheard.
const MIN_VOICED: usize = 3;
/// A cents error above this is gross.
pub const GROSS_CENTS: f32 = 50.0;

/// What was heard for one expected note.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct NoteResult {
    /// The note's index in the expected notes.
    pub index: usize,
    /// The expected pitch.
    pub expected_midi: f32,
    /// How many voiced frames landed in the note's sustained part.
    pub voiced_frames: usize,
    /// How many frames there were masked by the guide's bleed.
    #[serde(default)]
    pub masked_frames: usize,
    /// The median cents error of those frames, or `None` when too few landed.
    pub cents: Option<f32>,
}

/// A take's scorecard.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Report {
    /// One result per expected note, in order.
    pub notes: Vec<NoteResult>,
    /// The fraction of notes that were heard (have a cents error).
    pub heard_fraction: f32,
    /// The fraction of heard notes whose error is above [`GROSS_CENTS`] in magnitude.
    pub gross_error_rate: f32,
    /// The mean absolute cents error over heard notes.
    pub mean_abs_cents: f32,
}

/// Scores `frames` against `notes`. Each note is judged over its sustained part only: the
/// first 20% and the last 10% are skipped. A note with fewer than three voiced frames there
/// is unheard. The rates are 0 when nothing was heard.
pub fn score(notes: &[Note], frames: &[Frame]) -> Report {
    let results: Vec<NoteResult> = notes
        .iter()
        .enumerate()
        .map(|(index, note)| score_note(index, note, frames))
        .collect();
    let heard: Vec<f32> = results.iter().filter_map(|r| r.cents).collect();
    let (heard_fraction, gross_error_rate, mean_abs_cents) = if heard.is_empty() {
        (0.0, 0.0, 0.0)
    } else {
        let n = heard.len() as f32;
        let gross = heard.iter().filter(|c| c.abs() > GROSS_CENTS).count() as f32;
        let mean_abs = heard.iter().map(|c| c.abs()).sum::<f32>() / n;
        (n / notes.len() as f32, gross / n, mean_abs)
    };
    Report {
        notes: results,
        heard_fraction,
        gross_error_rate,
        mean_abs_cents,
    }
}

fn score_note(index: usize, note: &Note, frames: &[Frame]) -> NoteResult {
    let from = note.start_s + SKIP_HEAD * note.dur_s;
    let to = note.start_s + (1.0 - SKIP_TAIL) * note.dur_s;
    let sustained = frames.iter().filter(|f| f.t >= from && f.t < to);
    let masked_frames = sustained.clone().filter(|f| f.masked).count();
    let mut errors: Vec<f32> = sustained.filter_map(|f| f.midi.map(|m| fold((m - note.midi) * 100.0))).collect();
    let voiced_frames = errors.len();
    let cents = (voiced_frames >= MIN_VOICED).then(|| median(&mut errors));
    NoteResult {
        index,
        expected_midi: note.midi,
        voiced_frames,
        masked_frames,
        cents,
    }
}

/// `cents` folded to the nearest octave: into `-600.0..600.0`.
pub fn fold(cents: f32) -> f32 {
    (cents + 600.0).rem_euclid(1200.0) - 600.0
}

/// The median of a non-empty slice, sorting it in place.
fn median(values: &mut [f32]) -> f32 {
    values.sort_by(f32::total_cmp);
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid]) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(spec: &[(f32, Option<f32>)]) -> Vec<Frame> {
        spec.iter()
            .map(|&(t, midi)| Frame {
                t,
                midi,
                clarity: 1.0,
                rms: 0.1,
                masked: false,
            })
            .collect()
    }

    #[test]
    fn median_error_over_the_sustained_part() {
        let notes = [Note::new(60.0, 0.0, 1.0)];
        // The first frame (t = 0.1) and the last (t = 0.95) fall outside the sustained part.
        let fr = frames(&[
            (0.1, Some(70.0)),
            (0.3, Some(60.1)),
            (0.5, Some(60.2)),
            (0.7, Some(60.3)),
            (0.95, Some(50.0)),
        ]);
        let report = score(&notes, &fr);
        let cents = report.notes[0].cents.expect("heard");
        assert!((cents - 20.0).abs() < 1e-3, "{cents}");
        assert_eq!(report.notes[0].voiced_frames, 3);
        assert_eq!(report.heard_fraction, 1.0);
        assert_eq!(report.gross_error_rate, 0.0);
    }

    #[test]
    fn too_few_voiced_frames_is_unheard() {
        let notes = [Note::new(60.0, 0.0, 1.0), Note::new(62.0, 1.0, 1.0)];
        let fr = frames(&[
            (0.3, Some(60.0)),
            (0.5, None),
            (0.7, Some(60.0)),
            (1.3, Some(63.0)),
            (1.5, Some(63.0)),
            (1.7, Some(63.0)),
        ]);
        let report = score(&notes, &fr);
        assert_eq!(report.notes[0].cents, None);
        assert_eq!(report.notes[1].cents, Some(100.0));
        assert_eq!(report.heard_fraction, 0.5);
        assert_eq!(report.gross_error_rate, 1.0);
        assert_eq!(report.mean_abs_cents, 100.0);
    }

    #[test]
    fn octaves_fold_away() {
        assert_eq!(fold(1210.0), 10.0);
        assert_eq!(fold(-1190.0), 10.0);
        assert_eq!(fold(-250.0), -250.0);
        assert_eq!(fold(700.0), -500.0);
        let notes = [Note::new(60.0, 0.0, 1.0)];
        let fr = frames(&[(0.3, Some(48.1)), (0.5, Some(60.1)), (0.7, Some(48.1))]);
        let cents = score(&notes, &fr).notes[0].cents.expect("heard");
        assert!((cents - 10.0).abs() < 1e-3, "{cents}");
    }

    #[test]
    fn nothing_heard_gives_zero_rates() {
        let report = score(&[Note::new(60.0, 0.0, 1.0)], &[]);
        assert_eq!(
            (report.heard_fraction, report.gross_error_rate, report.mean_abs_cents),
            (0.0, 0.0, 0.0)
        );
    }
}
