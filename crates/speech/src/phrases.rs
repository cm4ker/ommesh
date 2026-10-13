//! Where a phrase begins and ends, from the voice detector's verdict on each
//! 32 ms frame: the chance, 0 to 1, that it holds speech. Kept apart from
//! the detector so that the rule can be tested on made-up verdicts.
//!
//! A phrase starts with a run of speech long enough not to be a click or a
//! cough, and ends at a pause long enough not to be a breath between words.
//! A little sound is kept on either side, since the detector is late to the
//! first consonant and early off the last. A phrase that goes on without a
//! pause is cut at its quietest moment, so that Whisper is never handed more
//! than it hears well at once.

/// What the microphone is heard at: 16 kHz mono, as Whisper hears.
pub const RATE: usize = 16_000;
/// The detector's frame: 512 samples, 32 ms.
pub const FRAME: usize = 512;

const fn frames(ms: usize) -> usize {
    ms * RATE / 1000 / FRAME
}

/// Speech, surely: a run of speech holds at least one frame this sure.
const ON: f32 = 0.5;
/// Speech still: the run goes on while frames stay above this. The gap
/// between the two keeps a word that fades from ending the phrase.
const OFF: f32 = 0.35;
/// A quarter of a second of speech makes a phrase; less is a click.
const MIN_SPEECH: usize = frames(256);
/// Seven tenths of a second of quiet ends it: longer than a breath, shorter than a thought.
pub const PAUSE: usize = frames(704);
/// Sound kept on either side of a phrase.
const PAD: usize = frames(192);
/// Twenty seconds without a pause, and the phrase is cut where it is quietest.
const LONGEST: usize = frames(20_000);

/// What to do with the frames gathered so far.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Nothing to say yet: more sound may finish a phrase or start one.
    Wait,
    /// No speech: the frames before this one can go.
    Drop(usize),
    /// A phrase over frames `[from, to)`; everything before `to` can go.
    Phrase { from: usize, to: usize },
}

/// The first frame of a run of speech: frames above `OFF`, at least
/// `MIN_SPEECH` of them, one of them above `ON`.
fn start(probs: &[f32]) -> Option<usize> {
    let mut run = 0;
    let mut sure = false;
    for (i, &p) in probs.iter().enumerate() {
        if p >= OFF {
            run += 1;
            sure |= p >= ON;
            if run >= MIN_SPEECH && sure {
                return Some(i + 1 - run);
            }
        } else {
            run = 0;
            sure = false;
        }
    }
    None
}

/// The frames held, from the first gathered since the last step; `len` frames in all.
pub fn step(probs: &[f32]) -> Step {
    let len = probs.len();
    let Some(from) = start(probs) else {
        // A run may be starting at the end; the rest is silence.
        let keep = MIN_SPEECH + PAD;
        return if len > keep { Step::Drop(len - keep) } else { Step::Wait };
    };
    let last = probs.iter().rposition(|&p| p >= OFF).expect("a run of speech was found");
    if len - 1 - last >= PAUSE {
        return Step::Phrase { from: from.saturating_sub(PAD), to: (last + 1 + PAD).min(len) };
    }
    if len - from >= LONGEST {
        // The quietest three frames in the second half of the phrase.
        let lo = from + LONGEST / 2;
        let at = (lo..len - 1).min_by(|&a, &b| quiet(probs, a).total_cmp(&quiet(probs, b))).unwrap_or(len);
        return Step::Phrase { from: from.saturating_sub(PAD), to: at };
    }
    Step::Wait
}

fn quiet(probs: &[f32], at: usize) -> f32 {
    probs[at.saturating_sub(1)..(at + 2).min(probs.len())].iter().sum()
}

/// What is left as a phrase when the microphone is turned off: speech not
/// yet ended by a pause.
pub fn last(probs: &[f32]) -> Option<(usize, usize)> {
    let from = start(probs)?;
    let last = probs.iter().rposition(|&p| p >= OFF)?;
    Some((from.saturating_sub(PAD), (last + 1 + PAD).min(probs.len())))
}

/// Whether someone is speaking now: a run of speech has begun in what is held.
pub fn speaking(probs: &[f32]) -> bool {
    start(probs).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Made-up verdicts: `ms` of silence or of speech, in turn.
    fn sound(parts: &[(bool, usize)]) -> Vec<f32> {
        parts.iter().flat_map(|&(speech, ms)| std::iter::repeat_n(if speech { 0.9 } else { 0.05 }, frames(ms))).collect()
    }

    #[test]
    fn silence_is_let_go_but_for_a_little_at_the_end() {
        assert_eq!(step(&[]), Step::Wait);
        assert_eq!(step(&sound(&[(false, 300)])), Step::Wait);
        let probs = sound(&[(false, 3000)]);
        assert_eq!(step(&probs), Step::Drop(probs.len() - MIN_SPEECH - PAD));
        assert!(!speaking(&probs) && last(&probs).is_none());
    }

    #[test]
    fn a_click_or_a_cough_is_no_phrase() {
        let probs = sound(&[(false, 500), (true, 160), (false, 1500)]);
        assert!(matches!(step(&probs), Step::Drop(_)));
        assert!(last(&probs).is_none());
    }

    #[test]
    fn a_phrase_ends_at_a_pause_and_not_at_a_breath() {
        let breath = sound(&[(false, 400), (true, 1500), (false, 300), (true, 800), (false, 400)]);
        assert_eq!(step(&breath), Step::Wait);
        assert!(speaking(&breath));
        let probs = sound(&[(false, 400), (true, 1500), (false, 300), (true, 800), (false, 800)]);
        let begun = frames(400);
        let ended = frames(400) + frames(1500) + frames(300) + frames(800);
        assert_eq!(step(&probs), Step::Phrase { from: begun - PAD, to: ended + PAD });
    }

    #[test]
    fn a_word_that_fades_keeps_the_phrase_going() {
        let mut probs = sound(&[(true, 1000)]);
        probs.extend(std::iter::repeat_n(0.4, frames(600)));
        probs.extend(sound(&[(false, 400)]));
        assert_eq!(step(&probs), Step::Wait);
    }

    #[test]
    fn speech_without_a_pause_is_cut_where_it_is_quietest() {
        let mut probs = sound(&[(true, 21_000)]);
        let dip = frames(14_000);
        probs[dip] = 0.36;
        probs[dip + 1] = 0.36;
        assert_eq!(step(&probs), Step::Phrase { from: 0, to: dip });
    }

    #[test]
    fn what_is_said_when_the_microphone_goes_off_is_a_phrase_too() {
        let probs = sound(&[(false, 1000), (true, 900), (false, 200)]);
        assert_eq!(step(&probs), Step::Wait);
        assert_eq!(last(&probs), Some((frames(1000) - PAD, probs.len())));
    }
}
