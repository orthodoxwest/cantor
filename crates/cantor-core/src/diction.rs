//! What a syllable sounds like when sung: the vowel it is held on, the glide a diphthong
//! closes with, and whether consonants open and close it. Latin follows ecclesiastical
//! pronunciation; English uses spelling rules with a list of common exceptions, which is
//! good enough for a guide voice and never claims to be a dictionary.

use serde::{Deserialize, Serialize};

use crate::synth::Note;

/// A sung vowel, named by its ARPAbet symbol. Diphthongs name their held first part; the
/// glide is a separate [`Diction::glide`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Vowel {
    /// "father", Latin a.
    Aa,
    /// "cat".
    Ae,
    /// "cup", and the reduced vowel of "the".
    Ah,
    /// "law", "Lord".
    Ao,
    /// The held part of "now".
    Aw,
    /// The held part of "my".
    Ay,
    /// "bed", Latin e.
    Eh,
    /// "her".
    Er,
    /// The held part of "day".
    Ey,
    /// "sit".
    Ih,
    /// "see", Latin i.
    Iy,
    /// "go" without its glide, Latin o.
    Ow,
    /// The held part of "boy".
    Oy,
    /// "good".
    Uh,
    /// "too", Latin u.
    Uw,
}

impl Vowel {
    /// Every vowel, in declaration order.
    pub const ALL: [Vowel; 15] = [
        Vowel::Aa,
        Vowel::Ae,
        Vowel::Ah,
        Vowel::Ao,
        Vowel::Aw,
        Vowel::Ay,
        Vowel::Eh,
        Vowel::Er,
        Vowel::Ey,
        Vowel::Ih,
        Vowel::Iy,
        Vowel::Ow,
        Vowel::Oy,
        Vowel::Uh,
        Vowel::Uw,
    ];

    /// The ARPAbet symbol, as voice files name their units.
    pub fn symbol(self) -> &'static str {
        match self {
            Vowel::Aa => "AA",
            Vowel::Ae => "AE",
            Vowel::Ah => "AH",
            Vowel::Ao => "AO",
            Vowel::Aw => "AW",
            Vowel::Ay => "AY",
            Vowel::Eh => "EH",
            Vowel::Er => "ER",
            Vowel::Ey => "EY",
            Vowel::Ih => "IH",
            Vowel::Iy => "IY",
            Vowel::Ow => "OW",
            Vowel::Oy => "OY",
            Vowel::Uh => "UH",
            Vowel::Uw => "UW",
        }
    }

    /// The vowel an ARPAbet symbol names, stress digits ignored.
    pub fn from_symbol(symbol: &str) -> Option<Vowel> {
        let bare = symbol.trim_end_matches(|c: char| c.is_ascii_digit());
        Vowel::ALL.into_iter().find(|v| v.symbol().eq_ignore_ascii_case(bare))
    }

    /// The nearest vowel to stand in when a voice lacks this one; `None` for the five
    /// vowels every voice is expected to carry (Latin's).
    pub fn stand_in(self) -> Option<Vowel> {
        match self {
            Vowel::Aa | Vowel::Eh | Vowel::Iy | Vowel::Ow | Vowel::Uw => None,
            Vowel::Ae => Some(Vowel::Eh),
            Vowel::Ah | Vowel::Ao | Vowel::Aw | Vowel::Ay => Some(Vowel::Aa),
            Vowel::Er => Some(Vowel::Ah),
            Vowel::Ey => Some(Vowel::Eh),
            Vowel::Ih => Some(Vowel::Iy),
            Vowel::Oy => Some(Vowel::Ao),
            Vowel::Uh => Some(Vowel::Uw),
        }
    }

    /// The vowel a diphthong closes on, if this is one when held alone.
    pub fn natural_glide(self) -> Option<Vowel> {
        match self {
            Vowel::Ay | Vowel::Oy => Some(Vowel::Ih),
            Vowel::Aw => Some(Vowel::Uh),
            Vowel::Ey => Some(Vowel::Iy),
            _ => None,
        }
    }
}

/// How consonants meet a vowel: none, voiced ones that keep the pitch sounding (m, l, v),
/// or unvoiced ones that silence it (t, s, k).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Consonants {
    #[default]
    None,
    Voiced,
    Unvoiced,
}

/// A syllable as sung.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diction {
    /// The consonants before the vowel.
    pub onset: Consonants,
    /// The vowel the syllable is held on.
    pub vowel: Vowel,
    /// The vowel a diphthong closes on at the syllable's end.
    pub glide: Option<Vowel>,
    /// The consonants after the vowel.
    pub coda: Consonants,
}

/// A note of a part with its syllable's text, as a timeline gives it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lyric {
    pub note: Note,
    /// The syllable's text.
    pub text: String,
    /// The syllable's word, by index: notes of one word share it.
    pub word: u32,
    /// The syllable, by index: notes of one syllable share it.
    pub syllable: u32,
}

/// A note to sing and how its syllable is sung.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sung {
    pub note: Note,
    pub diction: Diction,
    /// The first note of its syllable.
    pub new_syllable: bool,
}

/// The notes of a part with their diction: each word's syllables read together, so English
/// rules see the whole word.
pub fn part(language: Language, lyrics: &[Lyric]) -> Vec<Sung> {
    let mut out = Vec::with_capacity(lyrics.len());
    let mut i = 0;
    while i < lyrics.len() {
        let word = lyrics[i].word;
        let mut j = i;
        while j < lyrics.len() && lyrics[j].word == word {
            j += 1;
        }
        let notes = &lyrics[i..j];
        let mut texts: Vec<&str> = Vec::new();
        let mut index_of = Vec::with_capacity(notes.len());
        let mut last = None;
        for n in notes {
            if last != Some(n.syllable) {
                texts.push(&n.text);
                last = Some(n.syllable);
            }
            index_of.push(texts.len() - 1);
        }
        let dictions: Vec<Diction> = (0..texts.len()).map(|k| diction(language, &texts, k)).collect();
        for (k, n) in notes.iter().enumerate() {
            out.push(Sung {
                note: n.note,
                diction: dictions[index_of[k]],
                new_syllable: k == 0 || index_of[k] != index_of[k - 1],
            });
        }
        i = j;
    }
    out
}

/// The language whose rules read the syllables.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Language {
    Latin,
    English,
}

impl Language {
    /// The language a GABC source declares in its `language:` header, else a guess from its
    /// words: English when enough of them look English.
    pub fn of_gabc(gabc: &str) -> Language {
        if let Some((header, _)) = gabc.split_once("%%") {
            for field in header.split(';') {
                if let Some((name, value)) = field.split_once(':')
                    && name.trim().eq_ignore_ascii_case("language")
                {
                    let value = value.trim().to_ascii_lowercase();
                    if value.starts_with("en") {
                        return Language::English;
                    }
                    if value.starts_with("la") {
                        return Language::Latin;
                    }
                }
            }
        }
        let body = gabc.split_once("%%").map_or(gabc, |(_, b)| b);
        Language::guess(&lyrics(body))
    }

    /// English when more than one word in six has an English mark: a common English word,
    /// "th", "w", "sh", or a final "y".
    pub fn guess(text: &str) -> Language {
        let words: Vec<String> = text
            .split(|c: char| !c.is_alphabetic())
            .filter(|w| !w.is_empty())
            .map(str::to_lowercase)
            .collect();
        if words.is_empty() {
            return Language::Latin;
        }
        let english = words
            .iter()
            .filter(|w| {
                ENGLISH_MARKERS.contains(&w.as_str())
                    || w.contains("th")
                    || w.contains('w')
                    || w.contains("sh")
                    || (w.len() > 1 && w.ends_with('y'))
            })
            .count();
        if english * 6 > words.len() {
            Language::English
        } else {
            Language::Latin
        }
    }
}

const ENGLISH_MARKERS: [&str; 16] = [
    "the", "and", "of", "to", "is", "be", "my", "our", "his", "for", "him", "all", "are", "was", "lord", "god",
];

/// The sung text of a GABC body: everything outside parentheses, without markup.
fn lyrics(body: &str) -> String {
    let mut out = String::new();
    let mut depth = 0u32;
    let mut tag = false;
    for c in body.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            '<' if depth == 0 => tag = true,
            '>' if depth == 0 => tag = false,
            _ if depth == 0 && !tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// How `syllable` is sung, as part of `word` (the whole word's syllables, in order, with
/// `syllable` at `index`). Syllables without a vowel letter are sung on a neutral vowel.
pub fn diction(language: Language, word: &[&str], index: usize) -> Diction {
    let syllables: Vec<String> = word.iter().map(|s| letters(s)).collect();
    let Some(syllable) = syllables.get(index) else { return neutral() };
    if syllable.is_empty() {
        return neutral();
    }
    match language {
        Language::Latin => latin(syllable, index > 0),
        Language::English => english(&syllables, index),
    }
}

fn neutral() -> Diction {
    Diction {
        onset: Consonants::None,
        vowel: Vowel::Ah,
        glide: None,
        coda: Consonants::None,
    }
}

/// The lowercase letters of `text`, accents and ligatures folded to plain Latin letters.
fn letters(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        match c {
            'a'..='z' => out.push(c),
            'á' | 'à' | 'â' | 'ä' | 'ā' | 'ă' => out.push('a'),
            'é' | 'è' | 'ê' | 'ë' | 'ē' | 'ĕ' => out.push('e'),
            'í' | 'ì' | 'î' | 'ï' | 'ī' => out.push('i'),
            'ó' | 'ò' | 'ô' | 'ö' | 'ō' => out.push('o'),
            'ú' | 'ù' | 'û' | 'ü' | 'ū' => out.push('u'),
            'ý' | 'ÿ' => out.push('y'),
            'æ' | 'ǽ' => out.push_str("ae"),
            'œ' => out.push_str("oe"),
            _ => {}
        }
    }
    out
}

fn is_vowel_letter(c: char) -> bool {
    matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y')
}

/// Splits a syllable into its onset consonants, vowel letters and coda consonants. A "u"
/// after "q" (and after "g" before another vowel) and an "i", "j" or "y" before a vowel at
/// the start are consonants.
fn split(s: &str) -> (&str, &str, &str) {
    let b = s.as_bytes();
    let mut start = 0;
    loop {
        let Some(&c) = b.get(start) else { return (s, "", "") };
        let c = c as char;
        let next_vowel = b.get(start + 1).is_some_and(|&n| is_vowel_letter(n as char));
        let consonant_u = c == 'u' && start > 0 && (b[start - 1] == b'q' || (b[start - 1] == b'g' && next_vowel));
        let consonant_i = matches!(c, 'i' | 'j' | 'y') && start == 0 && next_vowel;
        if is_vowel_letter(c) && !consonant_u && !consonant_i {
            break;
        }
        start += 1;
    }
    let mut end = start;
    while end < b.len() && (is_vowel_letter(b[end] as char) || (b[end] == b'w' && end > start)) {
        end += 1;
    }
    (&s[..start], &s[start..end], &s[end..])
}

fn consonants(letters: &str, language: Language) -> Consonants {
    let Some(c) = letters.chars().find(|&c| c != 'h' || letters.len() == 1) else {
        return Consonants::None;
    };
    if letters == "h" {
        return match language {
            Language::Latin => Consonants::None,
            Language::English => Consonants::Unvoiced,
        };
    }
    match c {
        'b' | 'd' | 'g' | 'j' | 'l' | 'm' | 'n' | 'r' | 'v' | 'w' | 'y' | 'z' => Consonants::Voiced,
        _ => Consonants::Unvoiced,
    }
}

fn latin(s: &str, _inner: bool) -> Diction {
    let (onset, nucleus, coda) = split(s);
    let (vowel, glide) = match nucleus {
        "" => (Vowel::Ah, None),
        n if n.starts_with("ae") || n.starts_with("oe") => (Vowel::Eh, None),
        n if n.starts_with("au") => (Vowel::Aa, Some(Vowel::Uw)),
        n if n.starts_with("eu") => (Vowel::Eh, Some(Vowel::Uw)),
        "ui" if onset == "c" || onset == "h" => (Vowel::Uw, Some(Vowel::Iy)),
        n => (
            match n.as_bytes()[0] {
                b'a' => Vowel::Aa,
                b'e' => Vowel::Eh,
                b'i' | b'y' => Vowel::Iy,
                b'o' => Vowel::Ow,
                _ => Vowel::Uw,
            },
            None,
        ),
    };
    Diction {
        onset: consonants(onset, Language::Latin),
        vowel,
        glide,
        coda: consonants(coda, Language::Latin),
    }
}

/// Whole words whose vowels spelling rules get wrong, one vowel per sung syllable: common
/// liturgical words, and the words of the English chant library that the rules missed
/// at least three times against the CMU Pronouncing Dictionary. A word sung with a different
/// number of syllables falls back to the rules.
const ENGLISH_WORDS: &[(&str, &[Vowel])] = {
    use Vowel::*;
    &[
        ("a", &[Ah]),
        ("able", &[Ey, Ah]),
        ("above", &[Ah, Ah]),
        ("abraham", &[Ey, Ah, Ae]),
        ("abroad", &[Ah, Ao]),
        ("adversaries", &[Ae, Er, Eh, Iy]),
        ("again", &[Ah, Eh]),
        ("against", &[Ah, Eh]),
        ("agatha", &[Ae, Ah, Ah]),
        ("ages", &[Ey, Ah]),
        ("alleluia", &[Ae, Eh, Uw, Aa]),
        ("almighty", &[Ao, Ay, Iy]),
        ("altar", &[Ao, Er]),
        ("amen", &[Aa, Eh]),
        ("amiable", &[Ey, Iy, Ah, Ah]),
        ("among", &[Ah, Ah]),
        ("angel", &[Ey, Ah]),
        ("angels", &[Ey, Ah]),
        ("another", &[Ah, Ah, Er]),
        ("any", &[Eh, Iy]),
        ("anyone", &[Eh, Iy, Ah]),
        ("apostles", &[Ah, Aa, Ah]),
        ("apostolic", &[Ae, Ah, Ao, Ih]),
        ("apparel", &[Ah, Ae, Ah]),
        ("appear", &[Ah, Ih]),
        ("are", &[Aa]),
        ("as", &[Ae]),
        ("be", &[Iy]),
        ("bearing", &[Eh, Ih]),
        ("beauty", &[Uw, Iy]),
        ("become", &[Ih, Ah]),
        ("began", &[Ih, Ae]),
        ("begotten", &[Iy, Ao, Ih]),
        ("being", &[Iy, Ih]),
        ("blood", &[Ah]),
        ("body", &[Aa, Iy]),
        ("both", &[Ow]),
        ("bread", &[Eh]),
        ("break", &[Ey]),
        ("breath", &[Eh]),
        ("brethren", &[Eh, Eh]),
        ("bridegroom", &[Ay, Uw]),
        ("brother", &[Ah, Er]),
        ("build", &[Ih]),
        ("busy", &[Ih, Iy]),
        ("called", &[Ao]),
        ("calling", &[Ao, Ih]),
        ("captives", &[Ae, Ih]),
        ("cedar", &[Iy, Er]),
        ("chalice", &[Ae, Ih]),
        ("charity", &[Eh, Ih, Iy]),
        ("children", &[Ih, Ah]),
        ("christ", &[Ay]),
        ("christian", &[Ih, Ah]),
        ("cleanse", &[Eh]),
        ("come", &[Ah]),
        ("comes", &[Ah]),
        ("cometh", &[Ah, Eh]),
        ("comfort", &[Ah, Er]),
        ("company", &[Ah, Ah, Iy]),
        ("congregation", &[Aa, Ah, Ey, Ah]),
        ("could", &[Uh]),
        ("countenance", &[Aw, Ah, Ah]),
        ("country", &[Ah, Iy]),
        ("covenant", &[Ah, Ah, Ah]),
        ("crying", &[Ay, Ih]),
        ("dead", &[Eh]),
        ("dealt", &[Eh]),
        ("death", &[Eh]),
        ("defence", &[Ih, Eh]),
        ("desolation", &[Eh, Ah, Ey, Ah]),
        ("disciple", &[Ih, Ay, Ah]),
        ("disciples", &[Ih, Ay, Ah]),
        ("divers", &[Ay, Er]),
        ("do", &[Uw]),
        ("does", &[Ah]),
        ("dominion", &[Ah, Ih, Ah]),
        ("done", &[Ah]),
        ("door", &[Ao]),
        ("dove", &[Ah]),
        ("dreadful", &[Eh, Ah]),
        ("early", &[Er, Iy]),
        ("earth", &[Er]),
        ("egypt", &[Iy, Ah]),
        ("emmanuel", &[Ih, Ae, Uw, Ah]),
        ("even", &[Iy, Ih]),
        ("evening", &[Iy, Ih]),
        ("everyone", &[Eh, Iy, Ah]),
        ("evil", &[Iy, Ah]),
        ("exalt", &[Ih, Ao]),
        ("exalted", &[Ih, Ao, Ih]),
        ("eye", &[Ay]),
        ("eyes", &[Ay]),
        ("father", &[Aa, Er]),
        ("fathers", &[Aa, Er]),
        ("favored", &[Ey, Er]),
        ("feathers", &[Eh, Er]),
        ("fierce", &[Ih]),
        ("finest", &[Ay, Ah]),
        ("flood", &[Ah]),
        ("floor", &[Ao]),
        ("flourish", &[Er, Ih]),
        ("flowing", &[Ow, Ih]),
        ("food", &[Uw]),
        ("forever", &[Er, Eh, Er]),
        ("forgive", &[Ao, Ih]),
        ("four", &[Ao]),
        ("friend", &[Eh]),
        ("friends", &[Eh]),
        ("from", &[Ah]),
        ("full", &[Uh]),
        ("galilee", &[Ae, Ah, Iy]),
        ("gather", &[Ae, Er]),
        ("give", &[Ih]),
        ("given", &[Ih, Eh]),
        ("gives", &[Ih]),
        ("giveth", &[Ih, Eh]),
        ("glory", &[Ao, Iy]),
        ("god", &[Aa]),
        ("gone", &[Ao]),
        ("good", &[Uh]),
        ("governance", &[Ah, Er, Ah]),
        ("governor", &[Ah, Er, Er]),
        ("great", &[Ey]),
        ("has", &[Ae]),
        ("have", &[Ae]),
        ("he", &[Iy]),
        ("head", &[Eh]),
        ("heads", &[Eh]),
        ("health", &[Eh]),
        ("hear", &[Iy]),
        ("heart", &[Aa]),
        ("hearts", &[Aa]),
        ("heaven", &[Eh, Eh]),
        ("heavens", &[Eh, Eh]),
        ("hebrews", &[Iy, Uw]),
        ("here", &[Iy]),
        ("his", &[Ih]),
        ("holy", &[Ow, Iy]),
        ("honey", &[Ah, Iy]),
        ("honeycomb", &[Ah, Iy, Ow]),
        ("honour", &[Aa, Er]),
        ("honourable", &[Aa, Er, Ah, Ah]),
        ("hosts", &[Ow]),
        ("hour", &[Aw]),
        ("i", &[Ay]),
        ("imagine", &[Ih, Ae, Ah]),
        ("incense", &[Ih, Eh]),
        ("inheritance", &[Ih, Eh, Ah, Ah]),
        ("inviolate", &[Ih, Ay, Ah, Ih]),
        ("iron", &[Ay, Er]),
        ("is", &[Ih]),
        ("israel", &[Ih, Iy, Ah]),
        ("jacob", &[Ey, Ah]),
        ("jerusalem", &[Er, Uw, Ah, Ah]),
        ("jesus", &[Iy, Ah]),
        ("judge", &[Ah]),
        ("knowledge", &[Aa, Ah]),
        ("labour", &[Ey, Er]),
        ("lazarus", &[Ae, Er, Ah]),
        ("lion", &[Ay, Ah]),
        ("live", &[Ih]),
        ("lived", &[Ih]),
        ("lord", &[Ao]),
        ("love", &[Ah]),
        ("loved", &[Ah]),
        ("loving", &[Ah, Ih]),
        ("lowly", &[Ow, Iy]),
        ("majesty", &[Ae, Ah, Iy]),
        ("manna", &[Ae, Ah]),
        ("many", &[Eh, Iy]),
        ("marvellous", &[Aa, Ah, Ah]),
        ("mary", &[Eh, Iy]),
        ("me", &[Iy]),
        ("melody", &[Eh, Ah, Iy]),
        ("memory", &[Eh, Er, Iy]),
        ("merrily", &[Eh, Ah, Iy]),
        ("merry", &[Eh, Iy]),
        ("monarch", &[Aa, Aa]),
        ("money", &[Ah, Iy]),
        ("month", &[Ah]),
        ("mother", &[Ah, Er]),
        ("mountain", &[Aw, Ah]),
        ("mountains", &[Aw, Ah]),
        ("neither", &[Iy, Er]),
        ("none", &[Ah]),
        ("nothing", &[Ah, Ih]),
        ("o", &[Ow]),
        ("of", &[Ah]),
        ("offer", &[Ao, Er]),
        ("offering", &[Ao, Er, Ih]),
        ("offerings", &[Ao, Er, Ih]),
        ("oh", &[Ow]),
        ("once", &[Ah]),
        ("one", &[Ah]),
        ("ones", &[Ah]),
        ("only", &[Ow, Iy]),
        ("onward", &[Ao, Er]),
        ("other", &[Ah, Er]),
        ("our", &[Aw]),
        ("palace", &[Ae, Ah]),
        ("people", &[Iy, Ah]),
        ("perpetual", &[Er, Eh, Uw, Ah]),
        ("peter", &[Iy, Er]),
        ("pilate", &[Ay, Ah]),
        ("pleasure", &[Eh, Er]),
        ("poor", &[Uw]),
        ("pour", &[Ao]),
        ("prayer", &[Eh]),
        ("preeminence", &[Iy, Eh, Ah, Ah]),
        ("priest", &[Iy]),
        ("priests", &[Iy]),
        ("prophet", &[Aa, Ah]),
        ("prophets", &[Aa, Ah]),
        ("put", &[Uh]),
        ("ready", &[Eh, Iy]),
        ("remembrance", &[Iy, Eh, Ah]),
        ("sacrament", &[Ae, Ah, Ah]),
        ("sacrifice", &[Ae, Ah, Ay]),
        ("said", &[Eh]),
        ("saith", &[Eh]),
        ("sanctuary", &[Ae, Uw, Eh, Iy]),
        ("says", &[Eh]),
        ("season", &[Iy, Ah]),
        ("seraphim", &[Er, Aa, Iy]),
        ("service", &[Er, Ah]),
        ("shadow", &[Ae, Ow]),
        ("shall", &[Ae]),
        ("shalt", &[Ae]),
        ("sharing", &[Eh, Ih]),
        ("she", &[Iy]),
        ("shield", &[Iy]),
        ("should", &[Uh]),
        ("sign", &[Ay]),
        ("simeon", &[Ih, Iy, Ah]),
        ("simon", &[Ay, Ah]),
        ("since", &[Ih]),
        ("solemnity", &[Ah, Eh, Ah, Iy]),
        ("some", &[Ah]),
        ("son", &[Ah]),
        ("sons", &[Ah]),
        ("sorrow", &[Aa, Ow]),
        ("sorrows", &[Aa, Ow]),
        ("soul", &[Ow]),
        ("souls", &[Ow]),
        ("spirit", &[Ih, Ih]),
        ("spread", &[Eh]),
        ("statutes", &[Ae, Uw]),
        ("sure", &[Uh]),
        ("sword", &[Ao]),
        ("terrible", &[Eh, Ah, Ah]),
        ("terror", &[Eh, Er]),
        ("the", &[Ah]),
        ("their", &[Eh]),
        ("there", &[Eh]),
        ("thereof", &[Eh, Ah]),
        ("they", &[Ey]),
        ("through", &[Uw]),
        ("thyself", &[Ay, Eh]),
        ("to", &[Uw]),
        ("together", &[Ah, Eh, Er]),
        ("tomb", &[Uw]),
        ("tongue", &[Ah]),
        ("touch", &[Ah]),
        ("tribulation", &[Ih, Ah, Ey, Ah]),
        ("triumph", &[Ay, Ah]),
        ("triumphant", &[Ay, Ah, Ah]),
        ("trouble", &[Ah, Ah]),
        ("truth", &[Uw]),
        ("twelve", &[Eh]),
        ("two", &[Uw]),
        ("undivided", &[Ah, Ah, Ay, Ih]),
        ("ungodly", &[Ah, Ao, Iy]),
        ("unity", &[Uw, Ah, Iy]),
        ("uprising", &[Ah, Ay, Ih]),
        ("very", &[Eh, Iy]),
        ("vinegar", &[Ih, Ah, Er]),
        ("vineyard", &[Ih, Er]),
        ("was", &[Ah]),
        ("water", &[Ao, Er]),
        ("waters", &[Ao, Er]),
        ("we", &[Iy]),
        ("welcome", &[Eh, Ah]),
        ("were", &[Er]),
        ("what", &[Ah]),
        ("whatsoever", &[Ah, Ow, Eh, Er]),
        ("where", &[Eh]),
        ("who", &[Uw]),
        ("whoever", &[Uw, Eh, Er]),
        ("whom", &[Uw]),
        ("whose", &[Uw]),
        ("wind", &[Ih]),
        ("woman", &[Uh, Ah]),
        ("womb", &[Uw]),
        ("women", &[Ih, Ih]),
        ("wonder", &[Ah, Er]),
        ("wonderful", &[Ah, Er, Ah]),
        ("wonders", &[Ah, Er]),
        ("wondrous", &[Ah, Ah]),
        ("would", &[Uh]),
        ("wounded", &[Uw, Ih]),
        ("wounds", &[Uw]),
        ("ye", &[Iy]),
        ("yea", &[Ey]),
        ("you", &[Uw]),
        ("young", &[Ah]),
        ("your", &[Ao]),
        ("youth", &[Uw]),
        ("zion", &[Ay, Ah]),
    ]
};

fn english(syllables: &[String], index: usize) -> Diction {
    let s = syllables[index].as_str();
    let (onset, nucleus, coda) = split(s);
    let whole: String = syllables.concat();
    let lookup = ENGLISH_WORDS.binary_search_by(|(w, _)| (*w).cmp(whole.as_str())).ok();
    let vowel = match lookup.map(|i| ENGLISH_WORDS[i].1) {
        Some(vowels) if vowels.len() == syllables.len() => vowels[index],
        _ => english_rules(syllables, index, onset, nucleus, coda),
    };
    let last = index + 1 == syllables.len();
    // A "th" that begins a function word is voiced ("the", "thou"); elsewhere it is not.
    let onset_kind = if onset.starts_with("th") && index == 0 && THE_WORDS.contains(&whole.as_str()) {
        Consonants::Voiced
    } else {
        consonants(onset, Language::English)
    };
    // A final silent e closes nothing.
    let coda = if last && coda == "e" { "" } else { coda.trim_end_matches('e') };
    Diction {
        onset: onset_kind,
        vowel,
        glide: vowel.natural_glide(),
        coda: consonants(coda, Language::English),
    }
}

const THE_WORDS: [&str; 16] = [
    "the", "thee", "thou", "thy", "thine", "that", "this", "these", "those", "there", "their", "them", "then", "they", "though", "thus",
];

fn english_rules(syllables: &[String], index: usize, onset: &str, nucleus: &str, coda: &str) -> Vowel {
    use Vowel::*;
    let last = index + 1 == syllables.len();
    let single = syllables.len() == 1;
    let s = syllables[index].as_str();
    // Whole-syllable suffixes, sung reduced or fixed.
    if !single && index > 0 {
        match s {
            "tion" | "sion" | "cious" | "tious" | "ous" | "al" | "dom" | "ble" | "ple" | "tle" | "dle" | "gle" => {
                return Ah;
            }
            "ful" => return Uh,
            "fy" | "fied" | "fies" => return Ay,
            "ture" | "sure" => return Er,
            _ => {}
        }
    }
    let next = syllables.get(index + 1).map_or("", String::as_str);
    match s {
        "to" | "do" if last => return Uw,
        "to" => return Ah,
        "com" | "con" if !last => return Ah,
        "there" | "where" => return Eh,
        _ => {}
    }
    if nucleus.is_empty() {
        return Ah;
    }
    // A first syllable whose consonant doubles into the next ("ac-cord", "ap-pear") is
    // unstressed.
    if index == 0 && !last && onset.is_empty() && coda.len() == 1 && next.starts_with(coda) && nucleus == "a" {
        return Ah;
    }
    let r = coda.starts_with('r');
    let after = &coda[coda.len().min(1)..];
    let magic_e = last && {
        let tail = coda.trim_end_matches(['s', 'd']);
        nucleus.len() == 1
            && tail.len() >= 2
            && tail.ends_with('e')
            && tail[..tail.len() - 1].chars().all(|c| !is_vowel_letter(c))
            && tail.len() <= 3
    };
    match nucleus {
        "ee" => return if r { Ih } else { Iy },
        "ea" if r && matches!(onset, "b" | "w" | "sw" | "p") => return Eh,
        "ea" if r => return if after.is_empty() || after == "s" || after == "e" { Ih } else { Er },
        "ea" if onset.ends_with("gr") || onset.ends_with("br") => return Ey,
        "ea" => return Iy,
        "ie" if single => return Ay,
        "ie" => return Iy,
        "ei" => {
            return if r {
                Eh
            } else if onset.ends_with('c') {
                Iy
            } else {
                Ey
            };
        }
        "ey" => return if !single && last { Iy } else { Ey },
        "ai" | "ay" => return if r { Eh } else { Ey },
        "oa" => return if r { Ao } else { Ow },
        "oe" => return Ow,
        "oi" | "oy" => return Oy,
        "oo" => {
            return if r {
                Ao
            } else if coda.starts_with('k') || coda == "d" || coda == "t" {
                Uh
            } else {
                Uw
            };
        }
        "ou" if r => return if coda == "r" { Aw } else { Ao },
        "ou" if coda.starts_with("gh") => return if coda.starts_with("ght") { Ao } else { Ow },
        "ou" => return Aw,
        "ow" => {
            return if !single && last || OW_WORDS.contains(&syllables.concat().as_str()) {
                Ow
            } else {
                Aw
            };
        }
        "au" | "aw" => return Ao,
        "ew" | "eu" | "ue" | "ui" => return Uw,
        "uy" => return Ay,
        "eye" => return Ay,
        _ => {}
    }
    let first = nucleus.as_bytes()[0];
    if nucleus.len() > 1 && coda.is_empty() && first == b'i' && nucleus.ends_with('e') {
        return Ay;
    }
    let v = first as char;
    // r-coloured vowels.
    if r {
        let w = onset.ends_with('w');
        return match v {
            'a' if w => Ao,
            'a' if coda == "re" || coda == "res" || coda == "red" => Eh,
            'a' => Aa,
            'o' if w => Er,
            'o' if last && !single && (coda == "r" || coda == "rs") => Er,
            'o' => Ao,
            'i' if coda == "re" || coda == "res" || coda == "red" => Ay,
            'e' if coda == "re" && !single => Ih,
            'e' if coda == "re" => Ih,
            'u' if coda == "re" => Uh,
            _ => Er,
        };
    }
    if magic_e {
        return match v {
            'a' => Ey,
            'e' => Iy,
            'i' | 'y' => Ay,
            'o' => Ow,
            _ => Uw,
        };
    }
    if coda.is_empty() {
        // An open syllable.
        return match v {
            'y' if single => Ay,
            'y' => Iy,
            'e' if last && !single => Ih,
            'e' if index == 0 && !single => Eh,
            'o' if next.starts_with('r') => Ao,
            'a' if !single && index == 0 && onset.is_empty() => Ah,
            'a' => Ey,
            'e' => Iy,
            'i' => Ih,
            'o' => Ow,
            _ if onset.is_empty() && !single => Ah,
            _ => Uw,
        };
    }
    // A closed syllable.
    match v {
        'a' if coda == "l" && onset.is_empty() && !last && !next.starts_with('l') => Ao,
        'a' if last && !single => Ah,
        'a' if coda.starts_with("ll") || (coda.starts_with('l') && coda.len() > 1 && !coda.starts_with("le")) => {
            if coda.starts_with("lm") {
                Aa
            } else {
                Ao
            }
        }
        'a' if onset.ends_with('w') && (coda.starts_with("sh") || coda.starts_with("tch") || coda == "s") => Aa,
        'a' if onset.ends_with("qu") => Aa,
        'a' => Ae,
        'e' if last && !single && (coda == "s" || coda == "st" || coda == "th") => Ih,
        'e' => Eh,
        'i' if coda.starts_with("nd") || coda.starts_with("ld") || coda.starts_with("gh") => Ay,
        'i' | 'y' => Ih,
        'o' if coda.starts_with("ld") || coda.starts_with("lt") || coda.starts_with("st") && OW_WORDS.contains(&s) => Ow,
        'o' if onset.ends_with('w') || coda.starts_with("ng") || coda.starts_with("ff") || coda.starts_with("ss") => Ao,
        'o' => Aa,
        _ if coda.starts_with("sh") && onset.ends_with('p') || coda.starts_with("ll") && onset.ends_with('p') => Uh,
        _ => Ah,
    }
}

const OW_WORDS: [&str; 22] = [
    "low", "show", "shown", "know", "known", "grow", "grown", "flow", "own", "slow", "throw", "thrown", "snow", "blow", "glow", "bestow",
    "below", "most", "host", "ghost", "post", "bowl",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn word(language: Language, syllables: &[&str]) -> Vec<Vowel> {
        (0..syllables.len()).map(|i| diction(language, syllables, i).vowel).collect()
    }

    #[test]
    fn exception_table_is_sorted() {
        for pair in ENGLISH_WORDS.windows(2) {
            assert!(pair[0].0 < pair[1].0, "{} before {}", pair[0].0, pair[1].0);
        }
    }

    #[test]
    fn latin_vowels() {
        use Vowel::*;
        let l = Language::Latin;
        assert_eq!(word(l, &["Sal", "ve"]), [Aa, Eh]);
        assert_eq!(word(l, &["Re", "gí", "na"]), [Eh, Iy, Aa]);
        assert_eq!(word(l, &["cae", "ló", "rum"]), [Eh, Ow, Uw]);
        assert_eq!(word(l, &["quae"]), [Eh]);
        assert_eq!(word(l, &["Ie", "su"]), [Eh, Uw]);
        assert_eq!(word(l, &["e", "ius"]), [Eh, Uw]);
        assert_eq!(word(l, &["lau", "dá", "mus"]), [Aa, Aa, Uw]);
        assert_eq!(diction(l, &["lau"], 0).glide, Some(Uw));
        assert_eq!(word(l, &["san", "guis"]), [Aa, Iy]);
        assert_eq!(word(l, &["Æ", "ter", "ne"]), [Eh, Eh, Eh]);
    }

    #[test]
    fn latin_consonants() {
        let d = diction(Language::Latin, &["Sal", "ve"], 0);
        assert_eq!((d.onset, d.coda), (Consonants::Unvoiced, Consonants::Voiced));
        let d = diction(Language::Latin, &["Al", "ma"], 0);
        assert_eq!(d.onset, Consonants::None);
        let d = diction(Language::Latin, &["ho", "di", "e"], 0);
        assert_eq!(d.onset, Consonants::None, "a Latin h is silent");
    }

    #[test]
    fn english_psalm_fifty() {
        use Vowel::*;
        let e = Language::English;
        assert_eq!(word(e, &["Have"]), [Ae]);
        assert_eq!(word(e, &["mer", "cy"]), [Er, Iy]);
        assert_eq!(word(e, &["up", "on"]), [Ah, Aa]);
        assert_eq!(word(e, &["thy"]), [Ay]);
        assert_eq!(word(e, &["good", "ness"]), [Uh, Eh]);
        assert_eq!(word(e, &["mine"]), [Ay]);
        assert_eq!(word(e, &["wash"]), [Aa]);
        assert_eq!(word(e, &["cleanse"]), [Eh]);
        assert_eq!(word(e, &["sin"]), [Ih]);
        assert_eq!(word(e, &["faults"]), [Ao]);
        assert_eq!(word(e, &["sight"]), [Ay]);
        assert_eq!(word(e, &["thou"]), [Aw]);
        assert_eq!(word(e, &["clear"]), [Ih]);
        assert_eq!(word(e, &["when"]), [Eh]);
        assert_eq!(word(e, &["art"]), [Aa]);
        assert_eq!(word(e, &["jus", "ti", "fied"]), [Ah, Ih, Ay]);
        assert_eq!(word(e, &["judg", "ed"]), [Ah, Eh]);
        assert_eq!(diction(e, &["thy"], 0).glide, Some(Ih));
        assert_eq!(diction(e, &["thy"], 0).onset, Consonants::Voiced);
        assert_eq!(diction(e, &["sight"], 0).onset, Consonants::Unvoiced);
    }

    #[test]
    fn english_patterns() {
        use Vowel::*;
        let e = Language::English;
        assert_eq!(word(e, &["name"]), [Ey]);
        assert_eq!(word(e, &["named"]), [Ey]);
        assert_eq!(word(e, &["ho", "ly"]), [Ow, Iy]);
        assert_eq!(word(e, &["night"]), [Ay]);
        assert_eq!(word(e, &["sal", "va", "tion"]), [Ae, Ey, Ah]);
        assert_eq!(word(e, &["glo", "ri", "ous"]), [Ao, Ih, Ah]);
        assert_eq!(word(e, &["word"]), [Er]);
        assert_eq!(word(e, &["now"]), [Aw]);
        assert_eq!(word(e, &["sor", "row"]), [Aa, Ow]);
        assert_eq!(word(e, &["all"]), [Ao]);
        assert_eq!(word(e, &["psalm"]), [Aa]);
        assert_eq!(word(e, &["queen"]), [Iy]);
        assert_eq!(word(e, &["hail"]), [Ey]);
        assert_eq!(word(e, &["peace"]), [Iy]);
        assert_eq!(word(e, &["King"]), [Ih]);
    }

    #[test]
    fn language_from_header_or_words() {
        assert_eq!(
            Language::of_gabc("name:x;\nlanguage: English;\n%%\n(c4) Sal(f)ve(g)"),
            Language::English
        );
        assert_eq!(Language::of_gabc("name:x;\n%%\n(c4) Sal(f)ve(g) Re(h)gí(g)na(f)"), Language::Latin);
        assert_eq!(
            Language::of_gabc("name:x;\n%%\n(c4) Hail(f) ho(g)ly(h) queen,(g) mo(f)ther(g) of(f) mer(e)cy(f)"),
            Language::English
        );
    }

    #[test]
    fn a_part_reads_whole_words() {
        let lyric = |text: &str, word, syllable, start_s| Lyric {
            note: Note::new(60.0, start_s, 0.5),
            text: text.into(),
            word,
            syllable,
        };
        let lyrics = [
            lyric("ho", 0, 0, 0.0),
            lyric("ly", 0, 1, 0.5),
            lyric("ly", 0, 1, 1.0),
            lyric("God", 1, 2, 1.5),
        ];
        let sung = part(Language::English, &lyrics);
        let vowels: Vec<Vowel> = sung.iter().map(|s| s.diction.vowel).collect();
        assert_eq!(vowels, [Vowel::Ow, Vowel::Iy, Vowel::Iy, Vowel::Aa]);
        let starts: Vec<bool> = sung.iter().map(|s| s.new_syllable).collect();
        assert_eq!(starts, [true, true, false, true]);
    }

    #[test]
    fn empty_syllables_sing_a_neutral_vowel() {
        assert_eq!(diction(Language::English, &["*"], 0).vowel, Vowel::Ah);
        assert_eq!(diction(Language::Latin, &[], 0).vowel, Vowel::Ah);
    }
}
