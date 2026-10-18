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

/// The words for each of `verdict`'s marks, in order, for a run of `chant` sung again
/// ([`crate::judge::judge_again`]): a verse's mark over only the part of it the run holds tells
/// of those notes, not of the verse.
pub fn told_again(verdict: &Verdict, chant: &[Note]) -> Vec<String> {
    verdict
        .marks
        .iter()
        .map(|m| {
            let verse = chant.get(m.first).map(|n| n.verse);
            let whole = (m.first == 0 || chant.get(m.first - 1).map(|n| n.verse) != verse)
                && chant.get(m.last + 1).is_none_or(|n| Some(n.verse) != verse);
            match (m.kind, m.cents) {
                (MarkKind::Verse, Some(cents)) if !whole => format!(
                    "These notes were sung together {} your key ({cents:+.0} cents), as if they began on another note.",
                    interval(cents)
                ),
                (MarkKind::VerseMissing, _) if !whole => "Nothing was heard through these notes.".to_string(),
                _ => tell(m),
            }
        })
        .collect()
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
/// same notes in the take they were sung after (judged `before`, its notes heard `before_cents`
/// off the score, by the chant's index, as its report has them), in a sentence or two: which were
/// in tune each time, then which were marked, when any are or were. A note is in tune, as the
/// judge counts it, within [`IN_TUNE_CENTS`] of the key and under no mark. Each time it is read
/// against the key the run was sung in, with no drift, so the same singing is in tune the same
/// both times; "before" is the take read so, which beside a take that drifted may not be the
/// notes it showed in tune along its drift. One the take did not hear was neither in tune in it
/// nor out, and is said so. Both are compared note by note, not counted: "as before" is said of
/// the same notes, "the same notes" of marks the same way. The marks before are the take's, as it
/// showed them; the run's part of a verse is marked as a verse only where the take marked the
/// verse, by the same rule, so a part off as the verse was, sung as before, is marked on the same
/// notes. A part not off enough to judge as a verse alone, or of fewer than three notes heard, is
/// judged a note at a time, and told so beside the verse's mark. A take not heard is not compared
/// with. None for a run not heard.
pub fn again(before: &Verdict, before_cents: &[Option<f32>], after: &Verdict, run: Range<usize>) -> Vec<String> {
    let (Outcome::Heard, Some(key)) = (after.outcome, after.key_cents) else {
        return Vec::new();
    };
    if run.is_empty() {
        return Vec::new();
    }
    let n = run.len();
    fn under(v: &Verdict, i: usize) -> Option<&Mark> {
        v.marks.iter().find(|m| m.covers(i))
    }
    // Each note marked, and which way: above the key, below it, or not heard.
    let marked = |v: &Verdict| -> Vec<(usize, i8)> {
        run.clone()
            .filter_map(|i| under(v, i).map(|m| (i, m.cents.map_or(0, |c| if c < 0.0 { -1 } else { 1 }))))
            .collect()
    };
    let tuned = |v: &Verdict, error: &dyn Fn(usize) -> Option<f32>| -> Vec<usize> {
        run.clone()
            .filter(|&i| error(i).is_some_and(|c| c.abs() < IN_TUNE_CENTS) && under(v, i).is_none())
            .collect()
    };
    let taken = |i: usize| before_cents.get(i).copied().flatten();
    let now = (tuned(after, &|i| after.relative.get(i).copied().flatten()), marked(after));
    let was = (before.outcome == Outcome::Heard).then(|| (tuned(before, &|i| taken(i).map(|c| fold(c - key))), marked(before)));
    let heard = run.clone().filter(|&i| taken(i).is_some()).count();
    let same = |k: usize| if k == 1 { "the same one" } else { "the same ones" };
    let mut out = vec![if n == 1 {
        let tune = |v: &Vec<usize>| !v.is_empty();
        match (tune(&now.0), was.as_ref().map(|w| tune(&w.0))) {
            (true, None) => "Its note was in tune.",
            (false, None) => "Its note was not in tune.",
            (true, Some(_)) if heard == 0 => "Its note was in tune this time, where it was not heard before.",
            (false, Some(_)) if heard == 0 => "Its note was not in tune this time, where it was not heard before.",
            (true, Some(true)) => "Its note was in tune, as before.",
            (true, Some(false)) => "Its note was in tune this time, where it was not before.",
            (false, Some(true)) => "Its note was not in tune this time, where it was before.",
            (false, Some(false)) => "Its note was not in tune, as before.",
        }
        .to_string()
    } else {
        let k = now.0.len();
        match was.as_ref().map(|w| &w.0) {
            None => format!("{} in tune.", of_its(k, n, true)),
            // None in tune either time is as before only of notes the take heard.
            Some(w) if *w == now.0 && (heard == n || k > 0) => format!("{} in tune, as before.", of_its(k, n, true)),
            Some(w) if w.len() == k && heard == n => {
                format!("{} in tune this time, but not {} as before.", of_its(k, n, true), same(k))
            }
            Some(w) => format!("{} in tune this time{}.", of_its(k, n, true), where_before(w.len(), n, heard)),
        }
    }];
    let marks = |k: usize| {
        if k == 1 {
            "one mark".to_string()
        } else {
            format!("{} marks", number(k))
        }
    };
    let notes = |v: &Vec<(usize, i8)>| v.iter().map(|m| m.0).collect::<Vec<_>>();
    let (a, b) = (&now.1, was.as_ref().map(|w| &w.1));
    out.extend(match b {
        _ if a.is_empty() && b.is_none_or(Vec::is_empty) => None,
        None => Some(format!("It has {}.", marks(after.marks.len()))),
        Some(_) if a.is_empty() => {
            let had = before.marks.iter().filter(|m| m.first < run.end && m.last >= run.start).count();
            Some(if had == 1 {
                "Its mark is gone.".to_string()
            } else {
                format!("Its {} are gone.", marks(had))
            })
        }
        Some(b) if b.is_empty() => Some(format!("It has {}.", marks(after.marks.len()))),
        Some(b) if notes(a) == notes(b) => {
            let which = if a.len() == 1 { "note" } else { "notes" };
            let way = |v: &Vec<(usize, i8)>| v.iter().all(|m| m.1 == v[0].1).then_some(v[0].1);
            let side = |w: i8| if w < 0 { "below" } else { "above" };
            Some(match (way(a), way(b)) {
                _ if a == b => format!("It is marked on the same {which} as before."),
                (Some(-1), Some(1)) => {
                    format!("It is marked on the same {which} as before, but below your key this time, where it was above.")
                }
                (Some(1), Some(-1)) => {
                    format!("It is marked on the same {which} as before, but above your key this time, where it was below.")
                }
                (Some(0), Some(w)) => format!(
                    "It is marked on the same {which} as before, but not heard this time, where it was {} your key.",
                    side(w)
                ),
                (Some(w), Some(0)) => format!(
                    "It is marked on the same {which} as before, but {} your key this time, where it was not heard.",
                    side(w)
                ),
                _ => format!("It is marked on the same {which} as before, but not for the same reason."),
            })
        }
        Some(b) if a.len() == b.len() => Some(format!(
            "{} marked this time, but not {} as before.",
            of_its(a.len(), n, false),
            same(a.len())
        )),
        Some(b) => Some(format!(
            "{} marked this time{}.",
            of_its(a.len(), n, false),
            where_before(b.len(), n, n)
        )),
    });
    out
}

/// "All four of its notes were", "One of its four notes is", "Of its 24 notes, 13 were": `k`
/// of a run of `n` notes, with the verb in the past or the present.
fn of_its(k: usize, n: usize, past: bool) -> String {
    let (one, many) = if past { ("was", "were") } else { ("is", "are") };
    match k {
        _ if n > WORDS.len() - 1 => match k {
            0 => format!("Of its {n} notes, none {many}"),
            _ if k == n => format!("Of its {n} notes, all {many}"),
            1 => format!("Of its {n} notes, one {one}"),
            _ => format!("Of its {n} notes, {k} {many}"),
        },
        _ if k == n && n == 2 => format!("Both its notes {many}"),
        _ if k == n => format!("All {} of its notes {many}", number(n)),
        0 if n == 2 => format!("Neither of its notes {one}"),
        0 => format!("None of its {} notes {many}", number(n)),
        1 => format!("One of its {} notes {one}", number(n)),
        _ => format!("{} of its {} notes {many}", capitalise(&number(k)), number(n)),
    }
}

/// ", where two were before": how many of a run of `n` notes were so in the take before, of the
/// `heard` of them it heard ("where two of the three heard before were").
fn where_before(k: usize, n: usize, heard: usize) -> String {
    let h = heard.min(n);
    let (kw, hw) = (amount(k, n), amount(h, n));
    if h == n {
        return match k {
            0 if n == 2 => ", where neither was before".to_string(),
            0 => ", where none were before".to_string(),
            _ if k == n && n == 2 => ", where both were before".to_string(),
            _ if k == n => ", where all were before".to_string(),
            1 => ", where one was before".to_string(),
            _ => format!(", where {kw} were before"),
        };
    }
    match (h, k) {
        (0, _) if n == 2 => ", where neither was heard before".to_string(),
        (0, _) => ", where none were heard before".to_string(),
        (1, 1) => ", where the one heard before was".to_string(),
        (1, _) => ", where the one heard before was not".to_string(),
        (2, 2) => ", where both heard before were".to_string(),
        (2, 0) => ", where neither heard before was".to_string(),
        _ if k == h => format!(", where all {hw} heard before were"),
        (_, 0) => format!(", where none of the {hw} heard before were"),
        (_, 1) => format!(", where one of the {hw} heard before was"),
        _ => format!(", where {kw} of the {hw} heard before were"),
    }
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

const WORDS: [&str; 21] = [
    "no",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
];

/// `n` in words to twenty, and in figures above.
fn number(n: usize) -> String {
    WORDS.get(n).map_or_else(|| n.to_string(), |w| w.to_string())
}

/// `k` of a run of `n` notes: in words, as [`number`] gives it, unless `n` is too many for
/// words, when both are in figures.
fn amount(k: usize, n: usize) -> String {
    if n < WORDS.len() { number(k) } else { k.to_string() }
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
        assert_eq!(told(&many), "But two of the fourteen phrase endings went off pitch.");
        let more: Vec<Option<f32>> = (0..24).map(|i| Some(if i < 2 { 150.0 } else { 0.0 })).collect();
        assert_eq!(told(&more), "But two of the 24 phrase endings went off pitch.");
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

    /// A verdict on `cents` of eight notes, two verses of a phrase of four, judged whole (`run`
    /// None) or as a run sung again in the key 0 after a take in tune.
    fn judged(cents: &[Option<f32>], run: Option<std::ops::Range<usize>>) -> Verdict {
        match run {
            None => judged_after(cents, None, None),
            Some(run) => judged_after(cents, Some(run), Some(&judged_after(&[Some(0.0); 8], None, None))),
        }
    }

    /// As [`judged`], a run sung again after `take`.
    fn judged_after(cents: &[Option<f32>], run: Option<std::ops::Range<usize>>, take: Option<&Verdict>) -> Verdict {
        let notes: Vec<Note> = (0..8)
            .map(|i| Note {
                phrase: (i / 4) as u32,
                verse: (i / 4) as u32,
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
            Some(run) => crate::judge::judge_again(&notes, run, &report, 0.0, take.expect("a take")),
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
            again(&before, &before.relative, &after([0.0, 10.0, -20.0, 0.0]), 4..8),
            [
                "All four of its notes were in tune this time, where two were before.",
                "Its mark is gone."
            ]
        );
        assert_eq!(
            again(&before, &before.relative, &after([0.0, 200.0, -60.0, 0.0]), 4..8),
            [
                "Two of its four notes were in tune, as before.",
                "It is marked on the same note as before."
            ]
        );
        assert_eq!(
            again(&before, &before.relative, &after([300.0, 0.0, -200.0, 0.0]), 4..8),
            [
                "Two of its four notes were in tune this time, but not the same ones as before.",
                "Two of its four notes are marked this time, where one was before."
            ]
        );
        assert_eq!(
            again(&before, &before.relative, &after([0.0, 0.0, -200.0, 0.0]), 4..8),
            [
                "Three of its four notes were in tune this time, where two were before.",
                "One of its four notes is marked this time, but not the same one as before."
            ]
        );
        assert_eq!(
            again(&before, &before.relative, &after([80.0, 80.0, 80.0, 0.0]), 4..8),
            [
                "One of its four notes was in tune this time, where two were before.",
                "Its mark is gone."
            ]
        );
        // A run of two, and of one.
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(0.0), Some(0.0)], Some(6..8)), 6..8),
            ["Both its notes were in tune this time, where one was before."]
        );
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(300.0), Some(300.0)], Some(6..8)), 6..8),
            [
                "Neither of its notes was in tune this time, where one was before.",
                "It has two marks."
            ]
        );
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(0.0)], Some(5..6)), 5..6),
            ["Its note was in tune this time, where it was not before.", "Its mark is gone."]
        );
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(0.0)], Some(4..5)), 4..5),
            ["Its note was in tune, as before."]
        );
        // Not heard, nothing.
        assert!(again(&before, &before.relative, &judged(&[None; 4], Some(4..8)), 4..8).is_empty());
    }

    #[test]
    fn a_verse_the_take_marked_sung_again_in_part_as_before_is_marked_where_it_was() {
        // The take marks the second verse once, a whole tone high; three of its notes sung again
        // so are marked together, as the verse was, and told of as those notes.
        let before = judged(&[[Some(0.0); 4], [Some(200.0); 4]].concat(), None);
        let kinds = |v: &Verdict| v.marks.iter().map(|m| (m.kind, m.first, m.last)).collect::<Vec<_>>();
        assert_eq!(kinds(&before), [(MarkKind::Verse, 4, 7)]);
        let after = judged_after(&[Some(200.0); 3], Some(5..8), Some(&before));
        assert_eq!(kinds(&after), [(MarkKind::Verse, 5, 7)]);
        assert_eq!(
            again(&before, &before.relative, &after, 5..8),
            [
                "None of its three notes were in tune, as before.",
                "It is marked on the same notes as before."
            ]
        );
        let chant: Vec<Note> = (0..8)
            .map(|i| Note {
                verse: (i / 4) as u32,
                ..Note::new(60.0, 0.6 * i as f32, 0.5)
            })
            .collect();
        assert_eq!(
            told_again(&after, &chant),
            ["These notes were sung together a whole tone above your key (+200 cents), as if they began on another note."]
        );
        // So is a part that begins the verse.
        let begun = Verdict {
            marks: vec![Mark {
                kind: MarkKind::Verse,
                first: 4,
                last: 6,
                cents: Some(200.0),
            }],
            ..after.clone()
        };
        assert!(told_again(&begun, &chant)[0].starts_with("These notes were sung together"));
        // The whole verse is told of as the verse, and a mark on a note as ever.
        assert_eq!(told_again(&before, &chant), told(&before));
        let missing = Verdict {
            marks: vec![
                Mark {
                    kind: MarkKind::VerseMissing,
                    first: 5,
                    last: 7,
                    cents: None,
                },
                Mark {
                    kind: MarkKind::Note,
                    first: 2,
                    last: 2,
                    cents: Some(-200.0),
                },
                Mark {
                    kind: MarkKind::VerseMissing,
                    first: 4,
                    last: 7,
                    cents: None,
                },
            ],
            ..before.clone()
        };
        assert_eq!(
            told_again(&missing, &chant),
            [
                "Nothing was heard through these notes.",
                "Sung a whole tone below where your key puts this note (-200 cents), and held there.",
                "Nothing was heard through this verse."
            ]
        );
    }

    #[test]
    fn a_run_sung_again_is_told_only_of_the_take_s_marks_on_its_notes() {
        // The take marks notes 5 and 7; the run 6..8 holds one of them.
        let mut cents = [Some(0.0); 8];
        cents[5] = Some(200.0);
        cents[7] = Some(-200.0);
        let before = judged(&cents, None);
        assert_eq!(before.marks.iter().map(|m| m.first).collect::<Vec<_>>(), [5, 7]);
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(0.0); 2], Some(6..8)), 6..8),
            ["Both its notes were in tune this time, where one was before.", "Its mark is gone."]
        );
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(0.0); 4], Some(4..8)), 4..8),
            [
                "All four of its notes were in tune this time, where two were before.",
                "Its two marks are gone."
            ]
        );
    }

    #[test]
    fn a_note_under_a_mark_is_not_in_tune_whatever_its_own_error() {
        // The second verse marked a whole tone high, one of its notes sung in tune all the same.
        let mut cents = [[Some(0.0); 4], [Some(200.0); 4]].concat();
        cents[5] = Some(20.0);
        let before = judged(&cents, None);
        assert_eq!(before.marks.len(), 1);
        assert_eq!(before.in_tune, 4);
        let after = judged(&[Some(0.0); 4], Some(4..8));
        assert_eq!(after.in_tune, 4);
        assert_eq!(
            again(&before, &before.relative, &after, 4..8),
            [
                "All four of its notes were in tune this time, where none were before.",
                "Its mark is gone."
            ]
        );
        // Sung again so too, it is no more in tune.
        let after = judged(&cents[4..], Some(4..8));
        assert_eq!(after.in_tune, 0);
        assert_eq!(
            again(&before, &before.relative, &after, 4..8),
            [
                "None of its four notes were in tune, as before.",
                "It is marked on the same notes as before."
            ]
        );
    }

    #[test]
    fn sung_again_the_notes_in_tune_are_compared_not_counted() {
        // Notes 4 and 5 in tune in the take, 6 and 7 not (none marked).
        let before = judged(&[[Some(0.0); 4], [Some(0.0), Some(0.0), Some(80.0), Some(80.0)]].concat(), None);
        assert!(before.marks.is_empty());
        let after = |c: [f32; 4]| judged(&c.map(Some), Some(4..8));
        assert_eq!(
            again(&before, &before.relative, &after([80.0, 80.0, 0.0, 0.0]), 4..8),
            ["Two of its four notes were in tune this time, but not the same ones as before."]
        );
        assert_eq!(
            again(&before, &before.relative, &after([80.0, 0.0, 80.0, 0.0]), 4..8),
            ["Two of its four notes were in tune this time, but not the same ones as before."]
        );
        assert_eq!(
            again(&before, &before.relative, &after([80.0, 0.0, 80.0, 80.0]), 4..8),
            ["One of its four notes was in tune this time, where two were before."]
        );
        assert_eq!(
            again(&before, &before.relative, &after([80.0; 4]), 4..8),
            ["None of its four notes were in tune this time, where two were before."]
        );
        assert_eq!(
            again(&before, &before.relative, &after([0.0, 0.0, 80.0, 80.0]), 4..8),
            ["Two of its four notes were in tune, as before."]
        );
        // Where none, both or all were.
        let flat = judged(&[[Some(0.0); 4], [Some(80.0); 4]].concat(), None);
        assert_eq!(
            again(&flat, &flat.relative, &after([0.0; 4]), 4..8),
            ["All four of its notes were in tune this time, where none were before."]
        );
        let tuned = judged(&[Some(0.0); 8], None);
        assert_eq!(
            again(&tuned, &tuned.relative, &after([0.0, 80.0, 0.0, 0.0]), 4..8),
            ["Three of its four notes were in tune this time, where all were before."]
        );
        assert_eq!(
            again(&tuned, &tuned.relative, &judged(&[Some(80.0), Some(0.0)], Some(6..8)), 6..8),
            ["One of its two notes was in tune this time, where both were before."]
        );
        assert_eq!(
            again(&flat, &flat.relative, &judged(&[Some(0.0), Some(0.0)], Some(6..8)), 6..8),
            ["Both its notes were in tune this time, where neither was before."]
        );
    }

    #[test]
    fn sung_again_notes_the_take_did_not_hear_were_neither_in_tune_nor_out() {
        // The take heard notes 4 and 7 in tune, and 5 and 6 not at all.
        let before = judged(&[[Some(0.0); 4], [Some(0.0), None, None, Some(0.0)]].concat(), None);
        assert_eq!(before.outcome, Outcome::Heard);
        let after = |c: [f32; 4]| judged(&c.map(Some), Some(4..8));
        assert_eq!(
            again(&before, &before.relative, &after([0.0; 4]), 4..8),
            ["All four of its notes were in tune this time, where both heard before were."]
        );
        assert_eq!(
            again(&before, &before.relative, &after([80.0, 0.0, 0.0, 80.0]), 4..8),
            ["Two of its four notes were in tune this time, where both heard before were."]
        );
        assert_eq!(
            again(&before, &before.relative, &after([0.0, 0.0, 0.0, 80.0]), 4..8),
            ["Three of its four notes were in tune this time, where both heard before were."]
        );
        let one = judged(&[[Some(0.0); 4], [Some(80.0), None, None, Some(0.0)]].concat(), None);
        assert_eq!(
            again(&one, &one.relative, &after([0.0; 4]), 4..8),
            ["All four of its notes were in tune this time, where one of the two heard before was."]
        );
        let three = judged(&[[Some(0.0); 4], [Some(80.0), Some(80.0), None, Some(80.0)]].concat(), None);
        assert_eq!(
            again(&three, &three.relative, &after([0.0; 4]), 4..8),
            ["All four of its notes were in tune this time, where none of the three heard before were."]
        );
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(0.0), Some(0.0)], Some(5..7)), 5..7),
            ["Both its notes were in tune this time, where neither was heard before."]
        );
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(0.0), Some(0.0)], Some(6..8)), 6..8),
            ["Both its notes were in tune this time, where the one heard before was."]
        );
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(0.0)], Some(5..6)), 5..6),
            ["Its note was in tune this time, where it was not heard before."]
        );
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(80.0)], Some(5..6)), 5..6),
            ["Its note was not in tune this time, where it was not heard before."]
        );
        // Out of tune now, it is not as before of notes not heard then.
        assert_eq!(
            again(&before, &before.relative, &after([80.0; 4]), 4..8),
            ["None of its four notes were in tune this time, where both heard before were."]
        );
        let flat = judged(&[[Some(0.0); 4], [Some(80.0), None, None, Some(80.0)]].concat(), None);
        assert_eq!(
            again(&flat, &flat.relative, &after([80.0; 4]), 4..8),
            ["None of its four notes were in tune this time, where neither heard before was."]
        );
        assert_eq!(
            again(&flat, &flat.relative, &after([0.0; 4]), 4..8),
            ["All four of its notes were in tune this time, where neither heard before was."]
        );
        // Its verse marked as not heard, then heard.
        let unheard = judged(&[[Some(0.0); 4], [None; 4]].concat(), None);
        assert_eq!(unheard.outcome, Outcome::Heard);
        assert_eq!(
            again(&unheard, &unheard.relative, &after([80.0; 4]), 4..8),
            [
                "None of its four notes were in tune this time, where none were heard before.",
                "Its mark is gone."
            ]
        );
        let late = judged(&[[Some(0.0); 4], [Some(0.0), Some(0.0), None, Some(80.0)]].concat(), None);
        assert_eq!(
            again(&late, &late.relative, &judged(&[Some(0.0), Some(0.0)], Some(6..8)), 6..8),
            ["Both its notes were in tune this time, where the one heard before was not."]
        );
        assert_eq!(
            again(&late, &late.relative, &after([0.0; 4]), 4..8),
            ["All four of its notes were in tune this time, where two of the three heard before were."]
        );
        let three = judged(&[[Some(0.0); 4], [Some(0.0), Some(0.0), None, Some(0.0)]].concat(), None);
        assert_eq!(
            again(&three, &three.relative, &after([0.0; 4]), 4..8),
            ["All four of its notes were in tune this time, where all three heard before were."]
        );
    }

    #[test]
    fn marks_on_the_same_notes_are_told_apart_by_which_way_they_are() {
        // The second verse marked a tone sharp, then sung a tone flat: marked on the same notes,
        // the other way.
        let sharp = judged(&[[Some(0.0); 4], [Some(200.0); 4]].concat(), None);
        assert_eq!(
            again(&sharp, &sharp.relative, &judged(&[Some(-200.0); 4], Some(4..8)), 4..8),
            [
                "None of its four notes were in tune, as before.",
                "It is marked on the same notes as before, but below your key this time, where it was above."
            ]
        );
        let flat = judged(&[[Some(0.0); 4], [Some(-200.0); 4]].concat(), None);
        assert_eq!(
            again(&flat, &flat.relative, &judged(&[Some(200.0); 4], Some(4..8)), 4..8),
            [
                "None of its four notes were in tune, as before.",
                "It is marked on the same notes as before, but above your key this time, where it was below."
            ]
        );
        // Not heard where it was sung off.
        let silent = judged(&[[Some(0.0); 4], [None; 4]].concat(), Some(0..8));
        assert_eq!(
            silent.marks.iter().map(|m| (m.kind, m.first, m.last)).collect::<Vec<_>>(),
            [(MarkKind::VerseMissing, 4, 7)]
        );
        assert_eq!(
            again(&sharp, &sharp.relative, &silent, 0..8),
            [
                "Four of its eight notes were in tune, as before.",
                "It is marked on the same notes as before, but not heard this time, where it was above your key."
            ]
        );
        // Sung off where it was not heard.
        assert_eq!(
            again(
                &silent,
                &silent.relative,
                &judged(&[[Some(0.0); 4], [Some(-200.0); 4]].concat(), Some(0..8)),
                0..8
            ),
            [
                "Four of its eight notes were in tune, as before.",
                "It is marked on the same notes as before, but below your key this time, where it was not heard."
            ]
        );
        // Marked both ways, one of them now the other way.
        let both = judged(
            &[
                Some(0.0),
                Some(0.0),
                Some(0.0),
                Some(0.0),
                Some(0.0),
                Some(200.0),
                Some(-200.0),
                Some(0.0),
            ],
            None,
        );
        let turned = judged(
            &[
                Some(0.0),
                Some(0.0),
                Some(0.0),
                Some(0.0),
                Some(0.0),
                Some(200.0),
                Some(200.0),
                Some(0.0),
            ],
            Some(0..8),
        );
        assert_eq!(both.marks.len(), 2);
        assert_eq!(
            again(&both, &both.relative, &turned, 0..8)[1],
            "It is marked on the same notes as before, but not for the same reason."
        );
    }

    #[test]
    fn long_runs_are_counted_in_words_to_twenty_and_in_figures_past() {
        assert_eq!(of_its(13, 14, true), "Thirteen of its fourteen notes were");
        assert_eq!(of_its(20, 20, false), "All twenty of its notes are");
        assert_eq!(of_its(13, 24, true), "Of its 24 notes, 13 were");
        assert_eq!(of_its(0, 24, true), "Of its 24 notes, none were");
        assert_eq!(of_its(1, 24, false), "Of its 24 notes, one is");
        assert_eq!(of_its(24, 24, true), "Of its 24 notes, all were");
        assert_eq!(of_its(5, 20, true), "Five of its twenty notes were");
        assert_eq!(of_its(1, 21, true), "Of its 21 notes, one was");
        assert_eq!(where_before(12, 24, 24), ", where 12 were before");
        assert_eq!(where_before(12, 24, 20), ", where 12 of the 20 heard before were");
        assert_eq!(where_before(12, 14, 14), ", where twelve were before");
    }

    #[test]
    fn a_run_sung_again_after_a_take_not_heard_is_told_alone() {
        let before = judged(&[None; 8], None);
        assert_ne!(before.outcome, Outcome::Heard);
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(0.0); 4], Some(4..8)), 4..8),
            ["All four of its notes were in tune."]
        );
        assert_eq!(
            again(
                &before,
                &before.relative,
                &judged(&[Some(0.0), Some(300.0), Some(0.0), Some(0.0)], Some(4..8)),
                4..8
            ),
            ["Three of its four notes were in tune.", "It has one mark."]
        );
        assert_eq!(
            again(&before, &before.relative, &judged(&[Some(300.0)], Some(5..6)), 5..6),
            ["Its note was not in tune.", "It has one mark."]
        );
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
            again(&before, &before.relative, &after, 0..4),
            ["Three of its four notes were in tune, as before.", "It has one mark."]
        );
    }
}
