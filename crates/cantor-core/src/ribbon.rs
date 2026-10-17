//! What the singer sees of a judged take, note by note: each note's own band, its target at
//! the centre, measured in cents from where the judge put that note (the singer's key and
//! the drift line through it), so a half step and a whole step are drawn alike. Each band
//! carries the note's value as the judge read it over its sustained part, and the pitch heard
//! over the whole note, smoothed, so that a slide into the note or away from it shows beside
//! the value; the page draws them and adds nothing.

use serde::Serialize;

use crate::judge::Verdict;
use crate::pitch::Frame;
use crate::score::{Report, fold, sustained};
use crate::synth::Note;

/// How many frames each point of a band's trace is the median of.
pub const SMOOTH_FRAMES: usize = 3;

/// One note's band.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Band {
    /// The note's index in the expected notes.
    pub index: usize,
    /// The note's sustained part, in seconds of the take: where its value was read.
    pub from_s: f32,
    pub to_s: f32,
    /// The whole note, in seconds of the take, from when it was due to when it was due to
    /// end: where its trace lies.
    pub start_s: f32,
    pub end_s: f32,
    /// The note's error from the key and the drift line, in cents, as the judge read it
    /// ([`Verdict::relative`]); `None` when it was not heard.
    pub cents: Option<f32>,
    /// The pitch heard over the whole note, as (seconds, cents) on the same reference, each
    /// point the median of [`SMOOTH_FRAMES`] voiced frames; empty when not heard.
    pub trace: Vec<(f32, f32)>,
}

/// The bands of a take of `notes` heard as `frames`, scored as `report` and judged as
/// `verdict`. A take the judge did not hear has bands with no values.
pub fn ribbon(notes: &[Note], frames: &[Frame], report: &Report, verdict: &Verdict) -> Vec<Band> {
    notes
        .iter()
        .enumerate()
        .map(|(index, note)| {
            let (from_s, to_s) = sustained(note);
            let (start_s, end_s) = (note.start_s, note.start_s + note.dur_s);
            let cents = verdict.relative.get(index).copied().flatten();
            // The judge's reference for this note: its pitch, the key and the drift line there.
            let reference = match (cents, verdict.key_cents, report.notes.get(index).and_then(|r| r.cents)) {
                (Some(rel), Some(key), Some(heard)) => Some(note.midi * 100.0 + key + fold(heard - key - rel)),
                _ => None,
            };
            let trace = reference.map_or_else(Vec::new, |reference| {
                let voiced: Vec<(f32, f32)> = frames
                    .iter()
                    .filter(|f| f.t >= start_s && f.t < end_s)
                    .filter_map(|f| f.midi.map(|m| (f.t, fold(m * 100.0 - reference))))
                    .collect();
                smooth(&voiced)
            });
            Band {
                index,
                from_s,
                to_s,
                start_s,
                end_s,
                cents,
                trace,
            }
        })
        .collect()
}

/// Each point the median of it and its neighbours, [`SMOOTH_FRAMES`] in all (fewer at the
/// ends, where an even count takes the mean of the middle two).
fn smooth(points: &[(f32, f32)]) -> Vec<(f32, f32)> {
    let half = SMOOTH_FRAMES / 2;
    (0..points.len())
        .map(|i| {
            let window = &points[i.saturating_sub(half)..(i + half + 1).min(points.len())];
            let mut values: Vec<f32> = window.iter().map(|p| p.1).collect();
            values.sort_by(f32::total_cmp);
            let mid = values.len() / 2;
            let median = if values.len().is_multiple_of(2) {
                (values[mid - 1] + values[mid]) / 2.0
            } else {
                values[mid]
            };
            (points[i].0, median)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{judge, score};

    fn frames(notes: &[Note], cents: &[f32]) -> Vec<Frame> {
        let mut out = Vec::new();
        for (note, c) in notes.iter().zip(cents) {
            for k in 0..(note.dur_s * 100.0) as usize {
                let t = note.start_s + 0.005 + 0.01 * k as f32;
                // A single wild frame in each note, which the smoothing drops.
                let wild = k == 40;
                out.push(Frame {
                    t,
                    midi: Some(note.midi + (c + if wild { 90.0 } else { 0.0 }) / 100.0),
                    clarity: 1.0,
                    rms: 0.1,
                    masked: false,
                    quiet: false,
                    other: None,
                });
            }
        }
        out
    }

    #[test]
    fn a_band_is_its_note_against_the_key() {
        // A tone low throughout, and the fourth note a further 200 cents flat.
        let notes: Vec<Note> = (0..6)
            .map(|i| Note::new(60.0 + [0.0, 2.0, 4.0, 5.0, 4.0, 2.0][i], i as f32, 1.0))
            .collect();
        let sung = [-200.0, -200.0, -200.0, -400.0, -200.0, -200.0];
        let fr = frames(&notes, &sung);
        let report = score(&notes, &fr);
        let verdict = judge(&notes, &report);
        assert!((verdict.key_cents.unwrap() + 200.0).abs() < 1.0);
        let bands = ribbon(&notes, &fr, &report, &verdict);
        assert_eq!(bands.len(), 6);
        for (band, want) in bands.iter().zip([0.0, 0.0, 0.0, -200.0, 0.0, 0.0]) {
            assert_eq!(band.cents, verdict.relative[band.index]);
            assert!((band.cents.unwrap() - want).abs() < 1.0, "{band:?}");
            assert!(!band.trace.is_empty());
            assert!(
                band.trace
                    .iter()
                    .all(|&(t, c)| t >= band.start_s && t < band.end_s && (c - want).abs() < 1.0),
                "{band:?}"
            );
            // Over the whole note, its value read over the part between.
            assert!(
                band.start_s < band.from_s && band.from_s < band.to_s && band.to_s < band.end_s,
                "{band:?}"
            );
            assert!(
                band.trace.first().unwrap().0 < band.from_s && band.trace.last().unwrap().0 >= band.to_s,
                "{band:?}"
            );
        }
    }

    #[test]
    fn a_band_shows_a_slide_into_its_note_beside_the_value_held() {
        // The second note scooped: begun 150 cents low and slid up to it over its first tenth,
        // then held on pitch.
        let notes = [Note::new(60.0, 0.0, 1.0), Note::new(62.0, 1.0, 1.0), Note::new(64.0, 2.0, 1.0)];
        let mut fr = frames(&notes, &[0.0, 0.0, 0.0]);
        for f in fr.iter_mut().filter(|f| f.t >= 1.0 && f.t < 1.1) {
            let into = (f.t - 1.0) / 0.1;
            f.midi = Some(62.0 - 1.5 * (1.0 - into));
        }
        let report = score(&notes, &fr);
        let verdict = judge(&notes, &report);
        let band = &ribbon(&notes, &fr, &report, &verdict)[1];
        assert!(band.cents.unwrap().abs() < 1.0, "{band:?}");
        let head = band.trace.iter().filter(|&&(t, _)| t < 1.05).map(|&(_, c)| c);
        assert!(head.clone().count() > 0 && head.clone().all(|c| c < -60.0), "{band:?}");
        assert!(
            band.trace.iter().filter(|&&(t, _)| t >= band.from_s).all(|&(_, c)| c.abs() < 1.0),
            "{band:?}"
        );
    }

    #[test]
    fn a_band_follows_the_drift_line() {
        // A tone sinking 20 cents a note, and the fifth note a further 200 cents flat.
        let notes: Vec<Note> = (0..10).map(|i| Note::new(60.0 + (i % 3) as f32, i as f32, 1.0)).collect();
        let sung: Vec<f32> = (0..10).map(|i| -20.0 * i as f32 - if i == 4 { 200.0 } else { 0.0 }).collect();
        let fr = frames(&notes, &sung);
        let report = score(&notes, &fr);
        let verdict = judge(&notes, &report);
        assert!(verdict.drift_cents < -150.0, "{}", verdict.drift_cents);
        for band in ribbon(&notes, &fr, &report, &verdict) {
            let want = if band.index == 4 { -200.0 } else { 0.0 };
            assert!((band.cents.unwrap() - want).abs() < 2.0, "{band:?}");
            assert!(band.trace.iter().all(|&(_, c)| (c - want).abs() < 2.0), "{band:?}");
        }
    }

    #[test]
    fn a_take_not_heard_has_empty_bands() {
        let notes = [Note::new(60.0, 0.0, 1.0), Note::new(62.0, 1.0, 1.0)];
        let report = score(&notes, &[]);
        let verdict = judge(&notes, &report);
        let bands = ribbon(&notes, &[], &report, &verdict);
        assert!(bands.iter().all(|b| b.cents.is_none() && b.trace.is_empty()));
    }
}
