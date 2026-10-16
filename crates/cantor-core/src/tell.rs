//! What a take says to the singer, in words: the explanation the page shows when a marked
//! note is tapped and `cantor explain` gives each mark, and the two sentences the page shows
//! after a take. It tells what was heard against the singer's own key and nothing else; the
//! judge decides which notes are marked and whether the tone held.

use crate::judge::{Mark, MarkKind, Outcome, Verdict};
use crate::score::fold;
use crate::synth::Note;

/// The notes that end a phrase with no recitation, taken as its cadence.
const CADENCE_NOTES: usize = 2;

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

/// What the singer is told of the take as a whole, in two sentences: whether the reciting
/// tone held steady (the judge's drift), and whether the cadences were sung on pitch (the
/// judge's marks on them). Nothing of timing or breath. None for a take not heard.
pub fn summary(notes: &[Note], verdict: &Verdict) -> Vec<String> {
    if verdict.outcome != Outcome::Heard {
        return Vec::new();
    }
    let tone = if notes.iter().any(|n| n.recitation) {
        "Your reciting tone"
    } else {
        "Your pitch"
    };
    let drift = verdict.drift_cents;
    let mut out = vec![if verdict.steady {
        format!("{tone} held steady.")
    } else {
        format!(
            "{tone} {} {} over the take ({drift:+.0} cents).",
            if drift < 0.0 { "sank" } else { "rose" },
            steps(drift.abs()).unwrap_or("a little")
        )
    }];
    // A cadence in a verse not heard is neither on pitch nor off.
    let touches = |c: &(usize, usize), missing: bool| {
        verdict
            .marks
            .iter()
            .any(|m| (m.kind == MarkKind::VerseMissing) == missing && (c.0..=c.1).any(|i| m.covers(i)))
    };
    let cadences = cadences(notes);
    let heard: Vec<_> = cadences.iter().filter(|c| !touches(c, true)).collect();
    let off = heard.iter().filter(|c| touches(c, false)).count();
    let all_heard = heard.len() == cadences.len();
    out.extend(match (heard.len(), off) {
        (0, _) => None,
        (1, 0) => Some("The cadence was on pitch.".to_string()),
        (1, _) => Some("The cadence went off pitch; the mark shows where.".to_string()),
        (_, 0) if all_heard => Some("Your cadences were on pitch.".to_string()),
        (_, 0) => Some("Every cadence heard was on pitch.".to_string()),
        (n, off) if off == n => Some("Every cadence went off pitch; the marks show where.".to_string()),
        (n, off) => Some(format!(
            "{} of {} cadences went off pitch; the marks show where.",
            capitalise(&number(off)),
            number(n)
        )),
    });
    out
}

/// Each phrase's cadence, as the notes `first..=last`: the notes after its last recited note,
/// or the last [`CADENCE_NOTES`] of a phrase with none recited. A phrase that ends recited has
/// none.
pub fn cadences(notes: &[Note]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut first = 0;
    while first < notes.len() {
        let last = (first..notes.len())
            .take_while(|&i| notes[i].phrase == notes[first].phrase)
            .last()
            .unwrap_or(first);
        let from = match (first..=last).rev().find(|&i| notes[i].recitation) {
            Some(r) => r + 1,
            None => (last + 1).saturating_sub(CADENCE_NOTES).max(first),
        };
        if from <= last {
            out.push((from, last));
        }
        first = last + 1;
    }
    out
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

/// `n` in words, to twelve.
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
        };
        let words = told(&verdict);
        assert_eq!(words.len(), 2);
        assert_eq!(words[1], "Nothing was heard through this verse.");
    }

    /// Notes by phrase, verse and whether recited: `r` recited, `s` sung.
    fn chant(phrases: &[(u32, u32, &str)]) -> Vec<Note> {
        phrases
            .iter()
            .flat_map(|&(phrase, verse, shape)| {
                shape.chars().map(move |c| Note {
                    phrase,
                    verse,
                    recitation: c == 'r',
                    ..Note::new(60.0, 0.0, 0.5)
                })
            })
            .collect()
    }

    fn heard(drift_cents: f32, marks: Vec<Mark>) -> Verdict {
        Verdict {
            outcome: crate::Outcome::Heard,
            key_cents: Some(0.0),
            drift_cents,
            steady: drift_cents.abs() < crate::judge::DRIFT_CENTS,
            marks,
            relative: Vec::new(),
            in_tune: 0,
        }
    }

    fn span(kind: MarkKind, first: usize, last: usize) -> Mark {
        Mark {
            kind,
            first,
            last,
            cents: (kind != MarkKind::VerseMissing).then_some(200.0),
        }
    }

    #[test]
    fn a_cadence_is_what_follows_the_recitation() {
        // Intonation, recitation, mediant; recitation, termination; a phrase with no recitation;
        // a phrase that ends recited.
        let notes = chant(&[(0, 0, "ssrrrss"), (1, 0, "rrsss"), (2, 1, "ssss"), (3, 1, "srr")]);
        assert_eq!(cadences(&notes), [(5, 6), (9, 11), (14, 15)]);
        assert_eq!(cadences(&chant(&[(0, 0, "s")])), [(0, 0)]);
        assert!(cadences(&[]).is_empty());
    }

    #[test]
    fn a_clean_take_is_told_it_held() {
        let notes = chant(&[(0, 0, "srrss"), (1, 0, "rrss")]);
        assert_eq!(
            summary(&notes, &heard(20.0, Vec::new())),
            ["Your reciting tone held steady.", "Your cadences were on pitch."]
        );
        // Without recitation it is the pitch that holds.
        let notes = chant(&[(0, 0, "ssss"), (1, 0, "sss")]);
        assert_eq!(summary(&notes, &heard(-10.0, Vec::new()))[0], "Your pitch held steady.");
    }

    #[test]
    fn a_drifting_tone_is_told_which_way_and_how_far() {
        let notes = chant(&[(0, 0, "srrss")]);
        assert_eq!(
            summary(&notes, &heard(-130.0, Vec::new()))[0],
            "Your reciting tone sank about a semitone over the take (-130 cents)."
        );
        assert_eq!(
            summary(&notes, &heard(200.0, Vec::new()))[0],
            "Your reciting tone rose a whole tone over the take (+200 cents)."
        );
    }

    #[test]
    fn only_marks_on_cadences_put_them_off_pitch() {
        let notes = chant(&[(0, 0, "srrss"), (1, 0, "rrss"), (2, 1, "rrss")]);
        // A recited note marked is no cadence's.
        let recited = span(MarkKind::Note, 1, 1);
        assert_eq!(summary(&notes, &heard(0.0, vec![recited]))[1], "Your cadences were on pitch.");
        let marks = vec![recited, span(MarkKind::Note, 8, 8)];
        assert_eq!(
            summary(&notes, &heard(0.0, marks))[1],
            "One of three cadences went off pitch; the marks show where."
        );
        // A verse off together puts its cadences off.
        let marks = vec![span(MarkKind::Verse, 0, 8), span(MarkKind::Note, 12, 12)];
        assert_eq!(
            summary(&notes, &heard(0.0, marks))[1],
            "Every cadence went off pitch; the marks show where."
        );
    }

    #[test]
    fn a_verse_not_heard_is_left_out_of_the_cadences() {
        let notes = chant(&[(0, 0, "srrss"), (1, 1, "rrss"), (2, 1, "rrss")]);
        let missing = span(MarkKind::VerseMissing, 5, 12);
        assert_eq!(summary(&notes, &heard(0.0, vec![missing]))[1], "The cadence was on pitch.");
        let notes = chant(&[(0, 0, "srrss"), (1, 0, "rrss"), (2, 1, "rrss")]);
        let missing = span(MarkKind::VerseMissing, 9, 12);
        assert_eq!(summary(&notes, &heard(0.0, vec![missing]))[1], "Every cadence heard was on pitch.");
        let all = span(MarkKind::VerseMissing, 0, 12);
        assert_eq!(summary(&notes, &heard(0.0, vec![all])).len(), 1);
    }

    #[test]
    fn a_take_not_heard_is_told_nothing() {
        let notes = chant(&[(0, 0, "srrss")]);
        let verdict = Verdict {
            outcome: crate::Outcome::NotHeard,
            ..heard(0.0, Vec::new())
        };
        assert!(summary(&notes, &verdict).is_empty());
    }
}
