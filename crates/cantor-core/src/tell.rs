//! What a take says to the singer, in words: the explanation the page shows when a marked
//! note is tapped and `cantor explain` gives each mark, the two sentences the page shows
//! after a take, each phrase ending the second tells of as off pitch, for the page to go to,
//! and a run sung again beside the take it was sung after. It tells what was heard against the
//! singer's own key and nothing else; the judge decides which notes are marked, whether the
//! tone held and which cadences were on pitch.

use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::judge::{CADENCE_CENTS, IN_TUNE_CENTS, Mark, MarkKind, Outcome, Verdict, recited};
use crate::score::fold;
use crate::synth::Note;

/// The words for `mark`.
pub fn tell(mark: &Mark) -> String {
    match (mark.kind, mark.cents) {
        (MarkKind::Note, Some(cents)) => format!(
            "Sung {} where your key puts this note ({:+.0} cents), and held there.",
            interval(cents),
            cents
        ),
        (MarkKind::Verse, Some(cents)) => format!(
            "This verse was sung together {} your key ({:+.0} cents), as if it began on another note.",
            interval(cents),
            cents
        ),
        (MarkKind::VerseMissing, _) => "Nothing was heard through this verse.".to_string(),
        (_, None) => "This was off from your key.".to_string(),
    }
}

/// The words for each of `verdict`'s marks, in order.
pub fn told(verdict: &Verdict) -> Vec<String> {
    verdict.marks.iter().map(tell).collect()
}

/// A phrase ending the judge heard off pitch, over the notes `first..=last`, in words.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Ending {
    pub first: usize,
    pub last: usize,
    /// Its note furthest off, by index: the one its words tell of.
    pub note: usize,
    /// The mark that tells of the same fault, by index, when one does: one over the ending's
    /// notes, that note's own if it is, at a level the ending is not off pitch from (within
    /// [`CADENCE_CENTS`] of it), so told already. Not a verse's mark of a level further off, nor
    /// one of a verse not heard.
    pub mark: Option<usize>,
    pub words: String,
}

/// The phrase endings [`summary`] tells of as off pitch, in order, each with the note it tells
/// of, and the mark telling of the same fault if there is one, in words: the
/// places its second sentence is about. None for a take not heard.
pub fn endings(verdict: &Verdict) -> Vec<Ending> {
    if verdict.outcome != Outcome::Heard {
        return Vec::new();
    }
    verdict
        .cadences
        .iter()
        .filter(|c| c.on_pitch() == Some(false))
        .filter_map(|c| {
            let (note, cents) = (c.note?, c.cents?);
            Some(Ending {
                first: c.first,
                last: c.last,
                note,
                mark: {
                    let level = |m: &Mark| m.cents.is_some_and(|at| fold(cents - at).abs() < CADENCE_CENTS);
                    let over = |m: &Mark| m.first <= c.last && c.first <= m.last;
                    let marks = &verdict.marks;
                    marks
                        .iter()
                        .position(|m| m.covers(note) && level(m))
                        .or_else(|| marks.iter().position(|m| over(m) && level(m)))
                },
                words: format!(
                    "This phrase ended off pitch: a note of its ending was sung {} where your key puts it ({cents:+.0} cents).",
                    interval(cents)
                ),
            })
        })
        .collect()
}

/// What the singer is told of the take as a whole, in two sentences: whether the reciting
/// tone (the key, in a chant not recited) held steady, from the judge's drift, and whether the
/// phrase endings (the judge's cadences) were on pitch. The second begins "But" when it
/// tells of endings off pitch after a take that held steady, which a beginner could otherwise
/// read as contradicting it: the first is of the take as a whole, the second of its endings.
/// Nothing of timing or breath. None for a take not heard; one sentence when no ending was
/// clearly heard. `notes` are the chant's, all of them for a take stopped short, as the judge
/// reads whether it is recited from the whole chant.
pub fn summary(notes: &[Note], verdict: &Verdict) -> Vec<String> {
    if verdict.outcome != Outcome::Heard {
        return Vec::new();
    }
    let recited = recited(notes);
    let drift = verdict.drift_cents;
    let mut out = vec![match (verdict.steady, recited) {
        (true, true) => "Your reciting tone held steady from start to finish.".to_string(),
        (true, false) => "You stayed in your key from start to finish.".to_string(),
        (false, _) => format!(
            "{} {} {} over the take ({drift:+.0} cents).",
            if recited { "Your reciting tone" } else { "Your pitch" },
            if drift < 0.0 { "sank" } else { "rose" },
            steps(drift.abs()).unwrap_or("a little")
        ),
    }];
    let heard: Vec<bool> = verdict.cadences.iter().filter_map(|c| c.on_pitch()).collect();
    let off = heard.iter().filter(|on| !**on).count();
    let n = heard.len();
    // Endings not clearly heard are neither on pitch nor off.
    let which = if n == verdict.cadences.len() { "" } else { " heard clearly" };
    let sentence = match (n, off) {
        (0, _) => None,
        (1, 0) if which.is_empty() => Some("The ending was on pitch.".to_string()),
        (1, _) if which.is_empty() => Some("The ending went off pitch.".to_string()),
        (1, 0) => Some("Only one phrase ending was heard clearly, and it was on pitch.".to_string()),
        (1, _) => Some("Only one phrase ending was heard clearly, and it went off pitch.".to_string()),
        (2, 0) => Some(format!("Both phrase endings{which} were on pitch.")),
        (2, 2) => Some(format!("Both phrase endings{which} went off pitch.")),
        (_, 0) => Some(format!("Every phrase ending{which} was on pitch.")),
        _ if off == n => Some(format!("Every phrase ending{which} went off pitch.")),
        _ => Some(format!(
            "{} of the {} phrase endings{which} went off pitch.",
            capitalise(&number(off)),
            number(n)
        )),
    };
    out.extend(sentence.map(|s| if verdict.steady && off > 0 { but(&s) } else { s }));
    out
}

/// The notes `run` sung again (`after`, as [`crate::judge::judge_again`] judges them) beside the
/// same notes in the take they were sung after (`before`), in a sentence or two: how many were in
/// tune each time, then the marks on them, when they have or had any. A note is in tune, as the
/// judge counts it, within [`IN_TUNE_CENTS`] of the key and under no mark. None for a run not
/// heard.
pub fn again(before: &Verdict, after: &Verdict, run: Range<usize>) -> Vec<String> {
    if after.outcome != Outcome::Heard || run.is_empty() {
        return Vec::new();
    }
    let n = run.len();
    let tuned = |v: &Verdict| {
        run.clone()
            .filter(|&i| {
                v.relative.get(i).copied().flatten().is_some_and(|c| c.abs() < IN_TUNE_CENTS) && !v.marks.iter().any(|m| m.covers(i))
            })
            .count()
    };
    let (was, now) = (if before.outcome == Outcome::Heard { tuned(before) } else { 0 }, tuned(after));
    let mut out = vec![if n == 1 {
        match (now, was) {
            (1, 1) => "Its note was in tune, as before.",
            (1, _) => "Its note was in tune this time, where it was not before.",
            (_, 1) => "Its note was not in tune this time, where it was before.",
            _ => "Its note was not in tune, as before.",
        }
        .to_string()
    } else {
        let these = match now {
            k if k == n && n == 2 => "Both its notes were".to_string(),
            k if k == n => format!("All {} of its notes were", number(n)),
            0 => format!("None of its {} notes were", number(n)),
            1 => format!("One of its {} notes was", number(n)),
            k => format!("{} of its {} notes were", capitalise(&number(k)), number(n)),
        };
        let then = match was {
            k if k == now => ", as before".to_string(),
            0 => ", where none were before".to_string(),
            2 if n == 2 => ", where both were before".to_string(),
            1 => ", where one was before".to_string(),
            k if k == n => ", where all were before".to_string(),
            k => format!(", where {} were before", number(k)),
        };
        let again = if was == now { "" } else { " this time" };
        format!("{these} in tune{again}{then}.")
    }];
    let marks = |k: usize| {
        if k == 1 {
            "one mark".to_string()
        } else {
            format!("{} marks", number(k))
        }
    };
    let had = before.marks.iter().filter(|m| m.first < run.end && m.last >= run.start).count();
    let has = after.marks.len();
    out.extend(match (had, has) {
        (0, 0) => None,
        (1, 0) => Some("Its mark is gone.".to_string()),
        (_, 0) => Some(format!("Its {} are gone.", marks(had))),
        (0, _) => Some(format!("It has {} now.", marks(has))),
        _ => Some(format!(
            "It has {} now, where it had {}.",
            marks(has),
            if had == 1 { "one".to_string() } else { number(had) }
        )),
    });
    out
}

/// `sentence` begun with "But", as a contrast with the one before it.
fn but(sentence: &str) -> String {
    let mut chars = sentence.chars();
    chars
        .next()
        .map_or_else(String::new, |c| format!("But {}{}", c.to_lowercase(), chars.as_str()))
}

/// "about a whole tone above", "a semitone below": how far `cents` (folded to the nearest
/// octave) is, in the steps a singer names.
fn interval(cents: f32) -> String {
    let cents = fold(cents);
    let way = if cents >= 0.0 { "above" } else { "below" };
    match steps(cents.abs()) {
        Some(name) => format!("{name} {way}"),
        None => format!("a little {way}"),
    }
}

/// "a whole tone", "about a semitone": `cents` (at least zero) in the steps a singer names,
/// up to a tritone; none under half a semitone.
fn steps(cents: f32) -> Option<&'static str> {
    let steps = (cents / 100.0).round() as u32;
    let about = (cents - 100.0 * steps as f32).abs() >= 25.0;
    Some(match (steps, about) {
        (0, _) => return None,
        (1, false) => "a semitone",
        (1, true) => "about a semitone",
        (2, false) => "a whole tone",
        (2, true) => "about a whole tone",
        (3, false) => "a minor third",
        (3, true) => "about a minor third",
        (4, false) => "a major third",
        (4, true) => "about a major third",
        (5, false) => "a fourth",
        (5, true) => "about a fourth",
        (6, false) => "a tritone",
        (6, true) => "about a tritone",
        _ => "more than a tritone",
    })
}

/// `n` in words to twelve, and in figures above.
fn number(n: usize) -> String {
    const WORDS: [&str; 13] = [
        "no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    ];
    WORDS.get(n).map_or_else(|| n.to_string(), |w| w.to_string())
}

fn capitalise(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map_or_else(String::new, |c| c.to_uppercase().chain(chars).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::judge::Cadence;

    fn mark(kind: MarkKind, cents: Option<f32>) -> Mark {
        Mark {
            kind,
            first: 3,
            last: 3,
            cents,
        }
    }

    #[test]
    fn a_note_is_told_how_far_and_which_way() {
        assert_eq!(
            tell(&mark(MarkKind::Note, Some(196.6))),
            "Sung a whole tone above where your key puts this note (+197 cents), and held there."
        );
        assert_eq!(
            tell(&mark(MarkKind::Note, Some(-160.0))),
            "Sung about a whole tone below where your key puts this note (-160 cents), and held there."
        );
    }

    #[test]
    fn a_verse_is_told_as_a_whole() {
        assert_eq!(
            tell(&mark(MarkKind::Verse, Some(-310.0))),
            "This verse was sung together a minor third below your key (-310 cents), as if it began on another note."
        );
        assert_eq!(tell(&mark(MarkKind::VerseMissing, None)), "Nothing was heard through this verse.");
    }

    #[test]
    fn steps_are_named_within_the_octave() {
        assert_eq!(interval(30.0), "a little above");
        assert_eq!(interval(-49.0), "a little below");
        assert_eq!(interval(150.0), "about a whole tone above");
        assert_eq!(interval(-600.0), "a tritone below");
        // An octave and a whole tone is a whole tone.
        assert_eq!(interval(1400.0), "a whole tone above");
    }

    #[test]
    fn every_mark_is_told_in_order() {
        let verdict = Verdict {
            outcome: crate::Outcome::Heard,
            key_cents: Some(0.0),
            drift_cents: 0.0,
            steady: true,
            marks: vec![mark(MarkKind::Note, Some(200.0)), mark(MarkKind::VerseMissing, None)],
            relative: vec![None; 6],
            in_tune: 0,
            cadences: Vec::new(),
        };
        let words = told(&verdict);
        assert_eq!(words.len(), 2);
        assert_eq!(words[1], "Nothing was heard through this verse.");
    }

    fn heard(drift_cents: f32, cadences: &[Option<f32>]) -> Verdict {
        Verdict {
            outcome: crate::Outcome::Heard,
            key_cents: Some(0.0),
            drift_cents,
            steady: drift_cents.abs() < crate::judge::DRIFT_CENTS,
            marks: Vec::new(),
            relative: Vec::new(),
            in_tune: 0,
            cadences: cadences
                .iter()
                .enumerate()
                .map(|(i, &cents)| Cadence {
                    first: i,
                    last: i,
                    note: cents.map(|_| i),
                    cents,
                })
                .collect(),
        }
    }

    /// A psalm verse: intonation, recitation and mediant; recitation and termination.
    fn psalm() -> Vec<Note> {
        crate::notes_from_gabc(
            "(c4) O(g) praise(h) the(j) Lord(j) all(j) ye(j) hea(k)then(j.) *(:) praise(j) him(j) all(j) ye(j) na(h)tions.(g.) (::)",
            0.5,
        )
    }

    #[test]
    fn a_clean_take_is_told_it_held() {
        assert_eq!(
            summary(&psalm(), &heard(20.0, &[Some(30.0), Some(-60.0), Some(5.0)])),
            [
                "Your reciting tone held steady from start to finish.",
                "Every phrase ending was on pitch."
            ]
        );
        // A chant not recited is told of its key.
        assert_eq!(
            summary(&hymn(), &heard(-10.0, &[None]))[0],
            "You stayed in your key from start to finish."
        );
    }

    /// A hymn's line, no note of it recited.
    fn hymn() -> Vec<Note> {
        crate::notes_from_gabc("(c4) Te(g) lu(h)cis(j) an(i)te(h) (,) ter(g)mi(h)num(g) (::)", 0.5)
    }

    #[test]
    fn a_drifting_tone_is_told_which_way_and_how_far() {
        assert_eq!(
            summary(&psalm(), &heard(-130.0, &[]))[0],
            "Your reciting tone sank about a semitone over the take (-130 cents)."
        );
        assert_eq!(
            summary(&psalm(), &heard(200.0, &[]))[0],
            "Your reciting tone rose a whole tone over the take (+200 cents)."
        );
        assert_eq!(
            summary(&hymn(), &heard(-90.0, &[]))[0],
            "Your pitch sank a semitone over the take (-90 cents)."
        );
    }

    #[test]
    fn endings_off_pitch_are_counted() {
        let notes = psalm();
        let told = |cadences: &[Option<f32>]| summary(&notes, &heard(0.0, cadences))[1].clone();
        assert_eq!(
            told(&[Some(20.0), Some(-120.0), Some(10.0)]),
            "But one of the three phrase endings went off pitch."
        );
        assert_eq!(told(&[Some(120.0), Some(-300.0)]), "But both phrase endings went off pitch.");
        assert_eq!(
            told(&[Some(120.0), Some(-300.0), Some(400.0)]),
            "But every phrase ending went off pitch."
        );
        assert_eq!(told(&[Some(20.0)]), "The ending was on pitch.");
        assert_eq!(told(&[Some(-101.0)]), "But the ending went off pitch.");
        let many: Vec<Option<f32>> = (0..14).map(|i| Some(if i < 2 { 150.0 } else { 0.0 })).collect();
        assert_eq!(told(&many), "But two of the 14 phrase endings went off pitch.");
        assert_eq!(told(&[Some(0.0), Some(20.0)]), "Both phrase endings were on pitch.");
    }

    #[test]
    fn endings_off_after_a_steady_take_are_told_as_a_contrast() {
        // A steady take with its one clear ending off: the two sentences are of different
        // things, and say so.
        assert_eq!(
            summary(&hymn(), &heard(5.0, &[None, Some(-140.0)])),
            [
                "You stayed in your key from start to finish.",
                "But only one phrase ending was heard clearly, and it went off pitch."
            ]
        );
        // After a drifting take there is nothing to contrast.
        assert_eq!(summary(&hymn(), &heard(-90.0, &[Some(-140.0)]))[1], "The ending went off pitch.");
    }

    #[test]
    fn endings_not_heard_are_left_out() {
        let notes = psalm();
        let told = |cadences: &[Option<f32>]| summary(&notes, &heard(0.0, cadences)).get(1).cloned();
        assert_eq!(
            told(&[Some(20.0), None, Some(10.0), Some(0.0)]).unwrap(),
            "Every phrase ending heard clearly was on pitch."
        );
        assert_eq!(
            told(&[Some(200.0), None, Some(-150.0)]).unwrap(),
            "But both phrase endings heard clearly went off pitch."
        );
        assert_eq!(
            told(&[Some(200.0), None, Some(15.0)]).unwrap(),
            "But one of the two phrase endings heard clearly went off pitch."
        );
        assert_eq!(
            told(&[None, Some(15.0)]).unwrap(),
            "Only one phrase ending was heard clearly, and it was on pitch."
        );
        assert_eq!(told(&[None, None]), None);
        assert_eq!(told(&[]), None);
    }

    #[test]
    fn a_take_not_heard_is_told_nothing() {
        let verdict = Verdict {
            outcome: crate::Outcome::NotHeard,
            ..heard(0.0, &[Some(0.0)])
        };
        assert!(summary(&psalm(), &verdict).is_empty());
        assert!(endings(&verdict).is_empty());
    }

    #[test]
    fn the_endings_off_pitch_are_the_ones_counted() {
        // Of four endings, one on pitch, one not heard clearly and two off: the two are the
        // places "two of the three" is about, in order, each told how far it went.
        let verdict = heard(0.0, &[Some(20.0), Some(-120.0), None, Some(310.0)]);
        assert_eq!(
            summary(&psalm(), &verdict)[1],
            "But two of the three phrase endings heard clearly went off pitch."
        );
        let off = endings(&verdict);
        assert_eq!(off.iter().map(|e| (e.first, e.last)).collect::<Vec<_>>(), [(1, 1), (3, 3)]);
        assert_eq!(
            off[0].words,
            "This phrase ended off pitch: a note of its ending was sung a semitone below where your key puts it (-120 cents)."
        );
        assert_eq!(
            off[1].words,
            "This phrase ended off pitch: a note of its ending was sung a minor third above where your key puts it (+310 cents)."
        );
        // Endings on pitch are no place to go.
        assert!(endings(&heard(0.0, &[Some(20.0), Some(-99.0)])).is_empty());
    }

    #[test]
    fn an_ending_tells_of_its_note_off_and_the_mark_over_it() {
        // Two endings of two notes each, the second note of each the one off; a mark over the
        // second's tells of the same fault.
        let verdict = Verdict {
            marks: vec![Mark {
                kind: MarkKind::Note,
                first: 3,
                last: 3,
                cents: Some(400.0),
            }],
            cadences: vec![
                Cadence {
                    first: 0,
                    last: 1,
                    note: Some(1),
                    cents: Some(-150.0),
                },
                Cadence {
                    first: 2,
                    last: 3,
                    note: Some(3),
                    cents: Some(400.0),
                },
            ],
            ..heard(0.0, &[])
        };
        let off = endings(&verdict);
        assert_eq!(off.iter().map(|e| (e.note, e.mark)).collect::<Vec<_>>(), [(1, None), (3, Some(0))]);
        // A verse's mark tells of the ending only when the ending is not off pitch from the
        // verse's own level, whether or not their words fall in the same step; one of a verse not
        // heard never does.
        let over = |kind, cents| Verdict {
            marks: vec![Mark {
                kind,
                first: 2,
                last: 3,
                cents,
            }],
            ..verdict.clone()
        };
        let marked = |v: &Verdict| endings(v)[1].mark;
        assert_eq!(marked(&over(MarkKind::Verse, Some(390.0))), Some(0));
        assert_eq!(marked(&over(MarkKind::Verse, Some(200.0))), None);
        assert_eq!(marked(&over(MarkKind::VerseMissing, None)), None);
        // A mark on another note of the ending tells of it, at its level.
        let beside = |at: usize, cents: f32| Verdict {
            marks: vec![Mark {
                kind: MarkKind::Note,
                first: at,
                last: at,
                cents: Some(cents),
            }],
            ..verdict.clone()
        };
        assert_eq!(marked(&beside(2, 380.0)), Some(0));
        assert_eq!(marked(&beside(2, -380.0)), None);
        // Not one off its notes, though at its level.
        assert_eq!(marked(&beside(1, 380.0)), None);
        let at = |verse: f32, ending: f32| {
            let mut v = over(MarkKind::Verse, Some(verse));
            v.cadences[1].cents = Some(ending);
            marked(&v)
        };
        // "a whole tone" and "about a whole tone", or a whole tone and about a minor third, told
        // once.
        assert_eq!(at(176.0, 174.0), Some(0));
        assert_eq!(at(200.0, 251.0), Some(0));
        assert_eq!(at(-224.0, -226.0), Some(0));
        assert_eq!(at(152.0, 248.0), Some(0));
        assert_eq!(at(176.0, 275.0), Some(0));
        // Across the tritone, where a level folds to its other side.
        assert_eq!(at(-550.0, -600.0), Some(0));
        assert_eq!(at(560.0, -560.0), Some(0));
        // A semitone or more from the verse: off pitch from where the verse was sung, told apart.
        assert_eq!(at(200.0, 300.0), None);
    }
    #[test]
    fn an_ending_at_the_level_of_a_mark_on_another_of_its_notes_is_told_by_it() {
        // At a brisk pulse the note before the ending's last, a pulse long, counts toward the
        // ending but is too short to be marked; the last, dotted, is.
        let gabc = "(c4) O(g) praise(h) the(j) Lord(j) all(j) ye(j) hea(k)then(j.) *(:) praise(j) him(j) all(j) ye(j) na(h)tions.(g.) (::)";
        let ending = |pulse: f32, a: f32, b: f32| {
            let notes = crate::notes_from_gabc(gabc, pulse);
            let heard = |index: usize, cents: f32| crate::score::NoteResult {
                index,
                expected_midi: notes[index].midi,
                voiced_frames: 12,
                masked_frames: 0,
                quiet_frames: 0,
                frames: 12,
                spread_cents: Some(10.0),
                cents: Some(cents),
            };
            let report = crate::score::Report {
                notes: (0..notes.len())
                    .map(|i| heard(i, [(12, a), (13, b)].iter().find(|(n, _)| *n == i).map_or(0.0, |p| p.1)))
                    .collect(),
                heard_fraction: 1.0,
                gross_error_rate: 0.0,
                mean_abs_cents: 0.0,
            };
            let verdict = crate::judge::judge(&notes, &report);
            let told = endings(&verdict);
            assert_eq!(told.len(), 1, "{a} {b}");
            (verdict.marks.len(), told[0].mark)
        };
        // The short note furthest off, at the level of the last note's mark; not at its level.
        assert_eq!(ending(0.38, 320.0, 300.0), (1, Some(0)));
        assert_eq!(ending(0.38, -320.0, 200.0), (1, None));
        // The last note furthest off: its own mark.
        assert_eq!(ending(0.38, 300.0, 320.0), (1, Some(0)));
        // Both marked, slower: the mark of the note furthest off, though the other is at its
        // level too.
        assert_eq!(ending(0.5, 250.0, 300.0), (2, Some(1)));
    }

    /// A verdict on `cents` of eight notes, two phrases of four, judged whole (`run` None) or as
    /// a run sung again in the key 0.
    fn judged(cents: &[Option<f32>], run: Option<std::ops::Range<usize>>) -> Verdict {
        let notes: Vec<Note> = (0..8)
            .map(|i| Note {
                phrase: (i / 4) as u32,
                ..Note::new(60.0, 0.6 * i as f32, 0.5)
            })
            .collect();
        let report = crate::score::Report {
            notes: cents
                .iter()
                .enumerate()
                .map(|(index, &c)| crate::score::NoteResult {
                    index,
                    expected_midi: 60.0,
                    voiced_frames: if c.is_some() { 12 } else { 0 },
                    masked_frames: 0,
                    quiet_frames: if c.is_some() { 0 } else { 12 },
                    frames: 12,
                    spread_cents: c.map(|_| 10.0),
                    cents: c,
                })
                .collect(),
            heard_fraction: 1.0,
            gross_error_rate: 0.0,
            mean_abs_cents: 0.0,
        };
        match run {
            None => crate::judge::judge(&notes, &report),
            Some(run) => crate::judge::judge_again(&notes, run, &report, 0.0),
        }
    }

    #[test]
    fn a_run_sung_again_is_told_beside_the_take_it_was_sung_after() {
        // The second phrase: one note a whole tone high, one a quarter tone flat.
        let mut cents = [Some(0.0); 8];
        cents[5] = Some(200.0);
        cents[6] = Some(-60.0);
        let before = judged(&cents, None);
        assert_eq!(before.marks.len(), 1);
        let after = |c: [f32; 4]| judged(&c.map(Some), Some(4..8));
        assert_eq!(
            again(&before, &after([0.0, 10.0, -20.0, 0.0]), 4..8),
            [
                "All four of its notes were in tune this time, where two were before.",
                "Its mark is gone."
            ]
        );
        assert_eq!(
            again(&before, &after([0.0, 200.0, -60.0, 0.0]), 4..8),
            [
                "Two of its four notes were in tune, as before.",
                "It has one mark now, where it had one."
            ]
        );
        assert_eq!(
            again(&before, &after([300.0, 0.0, -200.0, 0.0]), 4..8),
            [
                "Two of its four notes were in tune, as before.",
                "It has two marks now, where it had one."
            ]
        );
        assert_eq!(
            again(&before, &after([80.0, 80.0, 80.0, 0.0]), 4..8),
            [
                "One of its four notes was in tune this time, where two were before.",
                "Its mark is gone."
            ]
        );
        // A run of two, and of one.
        assert_eq!(
            again(&before, &judged(&[Some(0.0), Some(0.0)], Some(6..8)), 6..8),
            ["Both its notes were in tune this time, where one was before."]
        );
        assert_eq!(
            again(&before, &judged(&[Some(0.0)], Some(5..6)), 5..6),
            ["Its note was in tune this time, where it was not before.", "Its mark is gone."]
        );
        assert_eq!(
            again(&before, &judged(&[Some(0.0)], Some(4..5)), 4..5),
            ["Its note was in tune, as before."]
        );
        // Not heard, nothing.
        assert!(again(&before, &judged(&[None; 4], Some(4..8)), 4..8).is_empty());
    }

    #[test]
    fn a_first_phrase_sung_again_may_be_marked_where_the_take_could_not_be() {
        let mut cents = [Some(0.0); 8];
        cents[1] = Some(300.0);
        let before = judged(&cents, None);
        assert!(before.marks.is_empty());
        let after = judged(&[Some(0.0), Some(300.0), Some(0.0), Some(0.0)], Some(0..4));
        assert_eq!(after.marks.len(), 1);
        assert_eq!(
            again(&before, &after, 0..4),
            ["Three of its four notes were in tune, as before.", "It has one mark now."]
        );
    }
}
