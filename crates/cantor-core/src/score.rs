//! Scoring a tracked take against the notes it should contain: the median cents error per
//! note over its sustained part, and a few summary rates.

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
    let mut errors: Vec<f32> = frames
        .iter()
        .filter(|f| f.t >= from && f.t < to)
        .filter_map(|f| f.midi.map(|m| (m - note.midi) * 100.0))
        .collect();
    let voiced_frames = errors.len();
    let cents = (voiced_frames >= MIN_VOICED).then(|| median(&mut errors));
    NoteResult {
        index,
        expected_midi: note.midi,
        voiced_frames,
        cents,
    }
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
            })
            .collect()
    }

    #[test]
    fn median_error_over_the_sustained_part() {
        let notes = [Note {
            midi: 60.0,
            start_s: 0.0,
            dur_s: 1.0,
        }];
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
        let notes = [
            Note {
                midi: 60.0,
                start_s: 0.0,
                dur_s: 1.0,
            },
            Note {
                midi: 62.0,
                start_s: 1.0,
                dur_s: 1.0,
            },
        ];
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
    fn nothing_heard_gives_zero_rates() {
        let report = score(
            &[Note {
                midi: 60.0,
                start_s: 0.0,
                dur_s: 1.0,
            }],
            &[],
        );
        assert_eq!(
            (report.heard_fraction, report.gross_error_rate, report.mean_abs_cents),
            (0.0, 0.0, 0.0)
        );
    }
}
