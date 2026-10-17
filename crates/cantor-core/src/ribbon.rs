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
/// A frame the second tracker hears further than this from the first, in cents (not folded), is
/// left out of a trace, so that the error is not drawn as a slide: more than a tritone apart is
/// a tracker's octave or harmonic error, not two trackers following a slide differently.
pub const TRACE_AGREE_CENTS: f32 = 600.0;

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
    /// point the median of [`SMOOTH_FRAMES`] voiced frames, leaving out those the two trackers
    /// hear far apart ([`TRACE_AGREE_CENTS`]); empty when not heard, or when they heard every
    /// frame so.
    pub trace: Vec<(f32, f32)>,
}

impl Band {
    /// The band with its times `by` seconds later, as of a take with that much more before it.
    pub fn shifted(mut self, by: f32) -> Band {
        for t in [&mut self.from_s, &mut self.to_s, &mut self.start_s, &mut self.end_s] {
            *t += by;
        }
        self.trace.iter_mut().for_each(|p| p.0 += by);
        self
    }
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
                let off = |f: &Frame| f.midi.map(|m| m * 100.0 - reference);
                let held = |f: &Frame| f.t >= from_s && f.t < to_s;
                let contradicted =
                    |f: &Frame| matches!((f.midi, f.other), (Some(m), Some(o)) if ((o - m) * 100.0).abs() > TRACE_AGREE_CENTS);
                // Each point is measured from the octave the note was held in (the judge folds
                // its value to the note, so a singer an octave below the score is on it), over
                // the frames the trace draws (or all held, when the trackers disagree on every
                // one), not folded itself: where the singer is still on the note before or
                // already on the next, a fifth or more away, it keeps its side, while the note
                // is held over most of its sustained part.
                let held_deviations = |drawn: bool| -> Vec<f32> {
                    frames
                        .iter()
                        .filter(|f| held(f) && !(drawn && contradicted(f)))
                        .filter_map(off)
                        .collect()
                };
                let mut deviations = held_deviations(true);
                if deviations.is_empty() {
                    deviations = held_deviations(false);
                }
                deviations.sort_by(f32::total_cmp);
                let octave = deviations.get(deviations.len() / 2).map_or(0.0, |c| (c / 1200.0).round() * 1200.0);
                let voiced: Vec<(f32, f32)> = frames
                    .iter()
                    .filter(|f| f.t >= start_s && f.t < end_s && !contradicted(f))
                    .filter_map(|f| off(f).map(|c| (f.t, c - octave)))
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
    fn a_fifth_reached_late_into_the_sustained_part_keeps_its_side() {
        // 60 67 60, each note reached 0.3 s late (past its head) and left 0.15 s early (before
        // its tail), on the neighbouring note throughout.
        let midis = [60.0f32, 67.0, 60.0];
        let notes: Vec<Note> = midis.iter().enumerate().map(|(i, &m)| Note::new(m, i as f32, 1.0)).collect();
        let mut fr = frames(&notes, &[0.0, 0.0, 0.0]);
        for f in fr.iter_mut() {
            let i = (f.t.floor() as usize).min(2);
            let into = f.t - i as f32;
            if i > 0 && into < 0.3 {
                f.midi = Some(midis[i - 1]);
            } else if i < 2 && into > 0.85 {
                f.midi = Some(midis[i + 1]);
            }
        }
        let report = score(&notes, &fr);
        let verdict = judge(&notes, &report);
        let bands = ribbon(&notes, &fr, &report, &verdict);
        let within = |b: &Band, lo: f32, hi: f32| {
            let points: Vec<f32> = b.trace.iter().filter(|&&(t, _)| t >= lo && t < hi).map(|&(_, c)| c).collect();
            assert!(!points.is_empty(), "{b:?}");
            points
        };
        assert!(within(&bands[1], 1.0, 1.28).iter().all(|&c| c < -600.0), "{:?}", bands[1]);
        assert!(within(&bands[1], 1.87, 2.0).iter().all(|&c| c < -600.0), "{:?}", bands[1]);
        assert!(within(&bands[2], 2.0, 2.28).iter().all(|&c| c > 600.0), "{:?}", bands[2]);
        assert!(within(&bands[0], 0.87, 1.0).iter().all(|&c| c > 600.0), "{:?}", bands[0]);
    }

    #[test]
    fn a_frame_the_second_tracker_hears_elsewhere_is_left_out_of_the_trace() {
        // The first tracker an octave up at the onset, where the second hears the note; agreeing
        // after.
        let notes = [Note::new(60.0, 0.0, 1.0)];
        let mut fr = frames(&notes, &[0.0]);
        for f in fr.iter_mut() {
            f.other = Some(60.0);
            if f.t < 0.08 {
                f.midi = Some(72.0);
            }
        }
        let report = score(&notes, &fr);
        let verdict = judge(&notes, &report);
        let band = &ribbon(&notes, &fr, &report, &verdict)[0];
        assert!(band.trace.iter().all(|&(_, c)| c.abs() < 100.0), "{band:?}");
        assert!(band.trace.iter().any(|&(t, _)| t < 0.15), "{band:?}");
        assert!(!band.trace.iter().any(|&(t, _)| t < 0.08), "{band:?}");
    }

    #[test]
    fn a_band_its_first_tracker_hears_an_octave_out_over_most_of_is_drawn_on_its_note() {
        // The first tracker an octave down over most of the sustained part, where the second
        // hears the note throughout.
        let notes = [Note::new(60.0, 0.0, 1.0)];
        let mut fr = frames(&notes, &[0.0]);
        for f in fr.iter_mut() {
            f.other = Some(60.0);
            if f.t >= 0.2 && f.t < 0.62 {
                f.midi = Some(48.0);
            }
        }
        let report = score(&notes, &fr);
        let verdict = judge(&notes, &report);
        let band = &ribbon(&notes, &fr, &report, &verdict)[0];
        assert!(band.cents.unwrap().abs() < 1.0, "{band:?}");
        assert!(
            !band.trace.is_empty() && band.trace.iter().all(|&(_, c)| c.abs() < 100.0),
            "{band:?}"
        );
    }

    #[test]
    fn a_slide_the_trackers_follow_apart_is_drawn() {
        // A slide up a third into the second note, the second tracker a step and a half behind
        // the first while it moves.
        let notes = [Note::new(60.0, 0.0, 1.0), Note::new(64.0, 1.0, 1.0)];
        let mut fr = frames(&notes, &[0.0, 0.0]);
        for f in fr.iter_mut() {
            f.other = f.midi;
            if f.t >= 1.0 && f.t < 1.1 {
                let m = 60.0 + 4.0 * (f.t - 1.0) / 0.1;
                f.midi = Some(m);
                f.other = Some(m - 1.5);
            }
        }
        let report = score(&notes, &fr);
        let verdict = judge(&notes, &report);
        let band = &ribbon(&notes, &fr, &report, &verdict)[1];
        assert!(band.trace.iter().any(|&(t, c)| t < 1.05 && c < -150.0), "{band:?}");
    }

    #[test]
    fn a_slide_from_a_note_a_fifth_away_keeps_its_side() {
        // Up a fifth and down again, each note reached a tenth late, still on the note before.
        let notes = [Note::new(60.0, 0.0, 1.0), Note::new(67.0, 1.0, 1.0), Note::new(60.0, 2.0, 1.0)];
        let mut fr = frames(&notes, &[0.0, 0.0, 0.0]);
        for f in fr.iter_mut().filter(|f| (f.t >= 1.0 && f.t < 1.1) || (f.t >= 2.0 && f.t < 2.1)) {
            f.midi = Some(if f.t < 2.0 { 60.0 } else { 67.0 });
        }
        let report = score(&notes, &fr);
        let verdict = judge(&notes, &report);
        let bands = ribbon(&notes, &fr, &report, &verdict);
        let head = |b: &Band| {
            b.trace
                .iter()
                .filter(|&&(t, _)| t < b.start_s + 0.05)
                .map(|&(_, c)| c)
                .collect::<Vec<_>>()
        };
        // Below the fifth it rose to, not above it; above the one it fell to.
        assert!(
            !head(&bands[1]).is_empty() && head(&bands[1]).iter().all(|&c| c < -600.0),
            "{:?}",
            bands[1]
        );
        assert!(
            !head(&bands[2]).is_empty() && head(&bands[2]).iter().all(|&c| c > 600.0),
            "{:?}",
            bands[2]
        );
        // Held, each is on its note.
        for b in &bands {
            assert!(
                b.trace
                    .iter()
                    .filter(|&&(t, _)| t >= b.from_s && t < b.to_s)
                    .all(|&(_, c)| c.abs() < 1.0),
                "{b:?}"
            );
        }
    }

    #[test]
    fn a_band_sung_an_octave_down_is_drawn_on_its_note_throughout() {
        // An octave below the score, each note reached a tenth late, still on the note before.
        let notes = [Note::new(60.0, 0.0, 1.0), Note::new(62.0, 1.0, 1.0)];
        let mut fr = frames(&notes, &[-1200.0, -1200.0]);
        for f in fr.iter_mut().filter(|f| f.t >= 1.0 && f.t < 1.1) {
            f.midi = Some(48.0);
        }
        let report = score(&notes, &fr);
        let verdict = judge(&notes, &report);
        let band = &ribbon(&notes, &fr, &report, &verdict)[1];
        // The note before, a whole tone below, as it is: not an octave and a tone.
        let head: Vec<f32> = band.trace.iter().filter(|&&(t, _)| t < 1.05).map(|&(_, c)| c).collect();
        assert!(!head.is_empty() && head.iter().all(|&c| (c + 200.0).abs() < 1.0), "{band:?}");
    }

    #[test]
    fn a_band_shifted_is_later_throughout() {
        let notes = [Note::new(60.0, 0.0, 1.0)];
        let fr = frames(&notes, &[0.0]);
        let report = score(&notes, &fr);
        let band = ribbon(&notes, &fr, &report, &judge(&notes, &report)).remove(0);
        let later = band.clone().shifted(2.0);
        assert_eq!(
            [later.from_s, later.to_s, later.start_s, later.end_s],
            [band.from_s + 2.0, band.to_s + 2.0, band.start_s + 2.0, band.end_s + 2.0]
        );
        assert!(later.trace.iter().zip(&band.trace).all(|(l, b)| l.0 == b.0 + 2.0 && l.1 == b.1));
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
