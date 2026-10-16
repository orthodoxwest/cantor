//! What a take says to the singer, in words: the explanation the page shows when a marked
//! note is tapped and `cantor explain` gives each mark, and the two sentences the page shows
//! after a take. It tells what was heard against the singer's own key and nothing else; the
//! judge decides which notes are marked, whether the tone held and which cadences were on pitch.

use crate::judge::{Mark, MarkKind, Outcome, Verdict, recited};
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

/// What the singer is told of the take as a whole, in two sentences: whether the reciting
/// tone (the pitch, in a chant not recited) held steady, from the judge's drift, and whether
/// the cadences were on pitch, from the judge's cadences. Nothing of timing or breath. None for
/// a take not heard; one sentence when no cadence was heard.
pub fn summary(notes: &[Note], verdict: &Verdict) -> Vec<String> {
    if verdict.outcome != Outcome::Heard {
        return Vec::new();
    }
    let tone = if recited(notes) { "Your reciting tone" } else { "Your pitch" };
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
    let heard: Vec<bool> = verdict.cadences.iter().filter_map(|c| c.on_pitch()).collect();
    let off = heard.iter().filter(|on| !**on).count();
    let n = heard.len();
    // Cadences not heard are neither on pitch nor off.
    let which = if n == verdict.cadences.len() { "" } else { " heard" };
    let sentence = match (n, off) {
        (0, _) => None,
        (1, 0) if which.is_empty() => Some("The cadence was on pitch.".to_string()),
        (1, _) if which.is_empty() => Some("The cadence went off pitch.".to_string()),
        (1, 0) => Some("The one cadence heard was on pitch.".to_string()),
        (1, _) => Some("The one cadence heard went off pitch.".to_string()),
        (_, 0) => Some(format!("Every cadence{which} was on pitch.")),
        _ if off == n => Some(format!("Every cadence{which} went off pitch.")),
        _ => {
            let (off, n) = if n <= 12 {
                (capitalise(NUMBERS[off]), NUMBERS[n].to_string())
            } else {
                (off.to_string(), n.to_string())
            };
            Some(format!("{off} of the {n} cadences{which} went off pitch."))
        }
    };
    out.extend(sentence);
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

/// Numbers in words, to twelve.
const NUMBERS: [&str; 13] = [
    "no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
];

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
                .map(|(i, &cents)| Cadence { first: i, last: i, cents })
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
            summary(&psalm(), &heard(20.0, &[Some(30.0), Some(-60.0)])),
            ["Your reciting tone held steady.", "Every cadence was on pitch."]
        );
        // A chant not recited holds its pitch.
        let hymn = crate::notes_from_gabc("(c4) Te(g) lu(h)cis(j) an(i)te(h) (,) ter(g)mi(h)num(g) (::)", 0.5);
        assert_eq!(summary(&hymn, &heard(-10.0, &[None]))[0], "Your pitch held steady.");
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
    }

    #[test]
    fn cadences_off_pitch_are_counted() {
        let notes = psalm();
        let told = |cadences: &[Option<f32>]| summary(&notes, &heard(0.0, cadences))[1].clone();
        assert_eq!(
            told(&[Some(20.0), Some(-120.0), Some(10.0)]),
            "One of the three cadences went off pitch."
        );
        assert_eq!(told(&[Some(120.0), Some(-300.0)]), "Every cadence went off pitch.");
        assert_eq!(told(&[Some(20.0)]), "The cadence was on pitch.");
        assert_eq!(told(&[Some(-101.0)]), "The cadence went off pitch.");
        let many: Vec<Option<f32>> = (0..14).map(|i| Some(if i < 2 { 150.0 } else { 0.0 })).collect();
        assert_eq!(told(&many), "2 of the 14 cadences went off pitch.");
    }

    #[test]
    fn cadences_not_heard_are_left_out() {
        let notes = psalm();
        let told = |cadences: &[Option<f32>]| summary(&notes, &heard(0.0, cadences)).get(1).cloned();
        assert_eq!(told(&[Some(20.0), None, Some(10.0)]).unwrap(), "Every cadence heard was on pitch.");
        assert_eq!(
            told(&[Some(200.0), None, Some(-150.0)]).unwrap(),
            "Every cadence heard went off pitch."
        );
        assert_eq!(
            told(&[Some(200.0), None, Some(15.0)]).unwrap(),
            "One of the two cadences heard went off pitch."
        );
        assert_eq!(told(&[None, Some(15.0)]).unwrap(), "The one cadence heard was on pitch.");
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
    }
}
