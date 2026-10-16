//! What a mark says to the singer, in words: the explanation the page shows when a marked
//! note is tapped and `cantor explain` gives each mark. It tells what was heard against the
//! singer's own key and nothing else; the judge decides which notes are marked.

use crate::judge::{Mark, MarkKind, Verdict};

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

/// "about a whole tone above", "a semitone below": how far `cents` is, in the steps a singer
/// names.
fn interval(cents: f32) -> String {
    let steps = (cents.abs() / 100.0).round() as u32;
    let name = match steps {
        0 => "a little",
        1 => "a semitone",
        2 => "a whole tone",
        3 => "a minor third",
        4 => "a major third",
        5 => "a fourth",
        _ => "a tritone",
    };
    let about = if (cents.abs() - 100.0 * steps as f32).abs() >= 25.0 {
        "about "
    } else {
        ""
    };
    format!("{about}{name} {}", if cents > 0.0 { "above" } else { "below" })
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
}
