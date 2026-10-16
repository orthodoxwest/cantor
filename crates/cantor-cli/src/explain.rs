//! One picture of a judged take: the notes the chant asks for in the singer's key, the pitch
//! heard, the truth where it is known (a synthetic take's planted pitch), and the marks. A
//! trace that leaves its bar where the truth stays on it is the tracker's error; a mark where
//! the truth is on the bar is a false mark. SwiftF0's pitch, where it listened, is drawn in
//! violet under the heard pitch: violet alone is a frame only SwiftF0 voiced (or one under the
//! take's loudness floor), and violet away from blue is the two trackers disagreeing.

use std::fmt::Write;

use cantor_core::{Frame, MarkKind, Note, Verdict};

const WIDTH: f32 = 1400.0;
const HEIGHT: f32 = 420.0;
const LEFT: f32 = 56.0;
const RIGHT: f32 = 16.0;
const TOP: f32 = 56.0;
const BOTTOM: f32 = 40.0;

/// What a picture is drawn from.
pub struct Picture<'a> {
    pub title: &'a str,
    pub notes: &'a [Note],
    pub frames: &'a [Frame],
    pub verdict: &'a Verdict,
    /// Each note's true pitch in cents from the score, when known.
    pub truth: &'a [Option<f32>],
}

/// The picture as an SVG document.
pub fn svg(p: &Picture) -> String {
    let key = p.verdict.key_cents.unwrap_or(0.0) / 100.0;
    let end = p
        .notes
        .iter()
        .map(Note::end_s)
        .chain(p.frames.last().map(|f| f.t))
        .fold(1.0f32, f32::max);
    let lo = p.notes.iter().map(|n| n.midi).fold(f32::INFINITY, f32::min) + key - 3.0;
    let hi = p.notes.iter().map(|n| n.midi).fold(f32::NEG_INFINITY, f32::max) + key + 3.0;
    let (lo, hi) = if lo.is_finite() { (lo, hi) } else { (57.0, 63.0) };
    let x = |t: f32| LEFT + (WIDTH - LEFT - RIGHT) * t / end;
    let y = |m: f32| TOP + (HEIGHT - TOP - BOTTOM) * (hi - m) / (hi - lo);

    let mut s = String::new();
    let _ = write!(
        s,
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" width="{WIDTH}" height="{HEIGHT}" font-family="system-ui, sans-serif" font-size="12">
<rect width="100%" height="100%" fill="#fbfaf7"/>
"##
    );
    // Semitone grid.
    let mut m = lo.ceil();
    while m <= hi {
        let _ = writeln!(
            s,
            r##"<line x1="{LEFT}" x2="{}" y1="{:.1}" y2="{:.1}" stroke="#e6e2da" stroke-width="1"/>"##,
            WIDTH - RIGHT,
            y(m),
            y(m)
        );
        m += 1.0;
    }
    let mut t = 0.0;
    while t <= end {
        let _ = writeln!(
            s,
            r##"<text x="{:.1}" y="{}" fill="#8a847a" text-anchor="middle">{t:.0}s</text>"##,
            x(t),
            HEIGHT - 16.0
        );
        t += if end > 60.0 { 10.0 } else { 5.0 };
    }

    // Marks under everything.
    for mark in &p.verdict.marks {
        let a = &p.notes[mark.first];
        let b = &p.notes[mark.last.min(p.notes.len() - 1)];
        let label = match (mark.kind, mark.cents) {
            (MarkKind::VerseMissing, _) => "verse not sung".to_string(),
            (MarkKind::Verse, Some(c)) => format!("verse {c:+.0}¢"),
            (_, Some(c)) => format!("{c:+.0}¢"),
            (_, None) => String::new(),
        };
        let _ = writeln!(
            s,
            r##"<rect x="{:.1}" y="{TOP}" width="{:.1}" height="{:.1}" fill="#d64545" fill-opacity="0.12" stroke="#d64545"/><text x="{:.1}" y="{}" fill="#b02a2a">{label}</text>"##,
            x(a.start_s),
            (x(b.end_s()) - x(a.start_s)).max(2.0),
            HEIGHT - TOP - BOTTOM,
            x(a.start_s) + 2.0,
            TOP - 4.0
        );
    }

    // The notes asked for, in the singer's key.
    for n in p.notes {
        let _ = writeln!(
            s,
            r##"<rect x="{:.1}" y="{:.1}" width="{:.1}" height="6" rx="2" fill="#b9b2a5"/>"##,
            x(n.start_s),
            y(n.midi + key) - 3.0,
            (x(n.end_s()) - x(n.start_s) - 1.0).max(1.0)
        );
    }
    // The truth, where known.
    for (n, t) in p.notes.iter().zip(p.truth) {
        if let Some(c) = t {
            let m = n.midi + key + cantor_core::score::fold(c - key * 100.0) / 100.0;
            let _ = writeln!(
                s,
                r##"<line x1="{:.1}" x2="{:.1}" y1="{:.1}" y2="{:.1}" stroke="#2f8f5b" stroke-width="2" stroke-dasharray="4 3"/>"##,
                x(n.start_s),
                x(n.end_s()),
                y(m),
                y(m)
            );
        }
    }
    // The pitch heard: each frame drawn in the octave of the note it falls in (or the last
    // one before it), as the scorer folds it; masked frames at the bottom.
    let mut note = 0;
    for f in p.frames {
        while note + 1 < p.notes.len() && p.notes[note + 1].start_s <= f.t {
            note += 1;
        }
        if f.masked {
            let _ = writeln!(
                s,
                r##"<rect x="{:.1}" y="{}" width="2" height="6" fill="#e39b2d"/>"##,
                x(f.t),
                HEIGHT - BOTTOM - 6.0
            );
            continue;
        }
        let Some(n) = p.notes.get(note) else { continue };
        let target = n.midi + key;
        let shown = |m: f32| target + cantor_core::score::fold((m - target) * 100.0) / 100.0;
        if let Some(o) = f.other.map(shown).filter(|o| (lo..=hi).contains(o)) {
            let _ = writeln!(
                s,
                r##"<circle cx="{:.1}" cy="{:.1}" r="2.6" fill="none" stroke="#9b59b6" stroke-width="0.8"/>"##,
                x(f.t),
                y(o)
            );
        }
        if let Some(m) = f.midi.map(shown).filter(|m| (lo..=hi).contains(m)) {
            let _ = writeln!(s, r##"<circle cx="{:.1}" cy="{:.1}" r="1.8" fill="#2a5db0"/>"##, x(f.t), y(m));
        }
    }

    let v = p.verdict;
    let summary = format!(
        "{:?} · key {} · drift {:+.0}¢ ({}) · {} marks · {} notes in tune",
        v.outcome,
        v.key_cents.map_or("-".into(), |k| format!("{k:+.0}¢")),
        v.drift_cents,
        if v.steady { "steady" } else { "unsteady" },
        v.marks.len(),
        v.in_tune
    );
    let _ = write!(
        s,
        r##"<text x="{LEFT}" y="20" font-size="15" font-weight="600" fill="#2b2925">{}</text>
<text x="{LEFT}" y="38" fill="#5c574f">{}</text>
<g transform="translate({} 14)" fill="#5c574f"><rect width="14" height="6" y="2" fill="#b9b2a5"/><text x="18" y="9">notes</text><circle cx="66" cy="5" r="2.5" fill="#2a5db0"/><text x="72" y="9">heard</text><line x1="116" x2="132" y1="5" y2="5" stroke="#2f8f5b" stroke-width="2" stroke-dasharray="4 3"/><text x="136" y="9">truth</text><rect x="176" width="4" height="8" fill="#e39b2d"/><text x="184" y="9">masked</text><rect x="234" width="12" height="9" fill="#d64545" fill-opacity="0.25" stroke="#d64545"/><text x="250" y="9">mark</text><circle cx="298" cy="5" r="3" fill="none" stroke="#9b59b6"/><text x="305" y="9">SwiftF0</text></g>
</svg>
"##,
        escape(p.title),
        escape(&summary),
        WIDTH - 370.0
    );
    s
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
