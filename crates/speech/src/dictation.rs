//! Speaking into the message field: the microphone's sound is handed in as
//! it comes, cut into phrases at the pauses, and each phrase is heard on a
//! thread of its own while the next is said. What is heard comes back with
//! the next sound handed in, or when the microphone is turned off.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;

use crate::engine::{self, Engine, Vad};
use crate::models::{self, Model, ModelInfo, VAD};
use crate::phrases::{self, Step, FRAME, RATE};

/// Half a second of sound the detector hears again before the new sound,
/// since it starts each call from nothing and is unsure of its first frames.
const WARM: usize = 16;
/// Fifteen seconds without a word, and the microphone turns itself off.
const IDLE: usize = 15 * RATE / FRAME;
/// What was written last that goes with a phrase as a clue: a sentence or two.
const CLUE: usize = 200;
/// -60 dB: below it throughout, the microphone was muted.
const QUIET: f32 = 0.001;

/// The model in memory, kept between dictations: reading it in again costs a
/// second and power each time. One phrase is heard at a time.
type Loaded = Arc<Mutex<Option<(&'static str, Engine)>>>;

/// What a shell keeps for voice input: where the models are, and the one in memory.
pub struct Recognizer {
    folder: PathBuf,
    loaded: Loaded,
}

impl Recognizer {
    pub fn new(folder: PathBuf) -> Self {
        Self { folder, loaded: Arc::default() }
    }

    pub fn folder(&self) -> &Path {
        &self.folder
    }

    pub fn models(&self) -> Vec<ModelInfo> {
        models::infos(&self.folder)
    }

    /// What a model needs fetched still, the detector first.
    pub fn missing(&self, id: &str) -> Result<Vec<&'static Model>, String> {
        Ok(models::missing(&self.folder, models::model(id)?))
    }

    /// Removes a model, letting go of it first if it is in memory.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let model = models::model(id)?;
        let mut slot = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.as_ref().is_some_and(|(id, _)| *id == model.id) {
            *slot = None;
        }
        drop(slot);
        models::delete(&self.folder, model)
    }

    /// Lets go of the model in memory, when voice input is turned off.
    pub fn unload(&self) {
        *self.loaded.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Starts listening: reads the model in if it is not, which takes a
    /// moment, so it is called off the page's thread. `language` is Whisper's
    /// code for what is spoken; `before`, what is in the field before the
    /// caret, a clue to how the text goes on.
    pub fn start(&self, id: &str, language: &str, before: &str) -> Result<Dictation, String> {
        models::able()?;
        let model = models::model(id)?;
        if !models::missing(&self.folder, model).is_empty() {
            return Err(format!("the {} speech model is not downloaded", model.id));
        }
        let vad = Vad::load(&self.folder.join(VAD.file))?;
        {
            let mut slot = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
            if !slot.as_ref().is_some_and(|(id, _)| *id == model.id) {
                // The old model goes before the new one is read in, so the two are never in memory together.
                *slot = None;
                *slot = Some((model.id, engine::load(&self.folder.join(model.file))?));
            }
        }
        Ok(Dictation::new(vad, self.loaded.clone(), language.to_string(), clue(before)))
    }
}

/// What is heard, as the worker leaves it for the next call to take.
#[derive(Default)]
struct Heard {
    phrases: Vec<String>,
    /// Phrases handed to the worker and not heard yet.
    waiting: usize,
    error: Option<String>,
}

/// What a call to `feed` has to say.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Fed {
    /// Phrases heard since the last call, in the order they were said.
    pub phrases: Vec<String>,
    /// Someone is speaking now, or a phrase is being heard.
    pub speaking: bool,
    /// Long quiet: the microphone can be turned off.
    pub ended: bool,
    /// How loud the sound handed in was at its loudest, 0 to 1.
    pub level: f32,
}

/// One turn of the microphone.
pub struct Dictation {
    vad: Vad,
    /// Sound not yet part of a phrase or let go as silence.
    held: Vec<f32>,
    /// The detector's verdict on each whole frame held.
    probs: Vec<f32>,
    /// Frames since the last speech, or since the start.
    idle: usize,
    jobs: Option<Sender<Vec<f32>>>,
    heard: Arc<Mutex<Heard>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Dictation {
    fn new(vad: Vad, loaded: Loaded, language: String, mut before: String) -> Self {
        let (jobs, inbox) = channel::<Vec<f32>>();
        let heard = Arc::new(Mutex::new(Heard::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let heard = heard.clone();
            let stop = stop.clone();
            std::thread::Builder::new()
                .name("speech".into())
                .spawn(move || {
                    for samples in inbox {
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        let outcome = {
                            let slot = loaded.lock().unwrap_or_else(PoisonError::into_inner);
                            match slot.as_ref() {
                                Some((_, engine)) => engine.hear(&samples, &language, &before),
                                None => Err("the speech model was let go".into()),
                            }
                        };
                        let mut heard = heard.lock().unwrap_or_else(PoisonError::into_inner);
                        heard.waiting -= 1;
                        match outcome {
                            Ok(text) if !text.is_empty() => {
                                before = clue(&format!("{before} {text}"));
                                heard.phrases.push(text);
                            }
                            Ok(_) => {}
                            Err(error) => heard.error = Some(error),
                        }
                    }
                })
                .expect("a thread starts")
        };
        Self { vad, held: Vec::new(), probs: Vec::new(), idle: 0, jobs: Some(jobs), heard, stop, worker: Some(worker) }
    }

    /// More sound from the microphone, 16 kHz mono in [-1, 1], in pieces of
    /// any length; a few tenths of a second each keeps the text close behind
    /// the speech.
    pub fn feed(&mut self, samples: &[f32]) -> Result<Fed, String> {
        let level = samples.iter().fold(0f32, |peak, s| if s.is_finite() { peak.max(s.abs()) } else { peak });
        // A sample that is not a number would spoil the whole spectrogram.
        self.held.extend(samples.iter().map(|&s| if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 }));
        self.listen()?;
        loop {
            match phrases::step(&self.probs) {
                Step::Wait => break,
                Step::Drop(to) => {
                    self.idle += to;
                    self.forget(to);
                }
                Step::Phrase { from, to } => {
                    self.idle = 0;
                    self.hand(from, to);
                    self.forget(to);
                }
            }
        }
        let speaking = phrases::speaking(&self.probs);
        if speaking {
            self.idle = 0;
        }
        let mut heard = self.heard.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(error) = heard.error.take() {
            return Err(error);
        }
        let busy = speaking || heard.waiting > 0;
        Ok(Fed { phrases: std::mem::take(&mut heard.phrases), speaking: busy, ended: !busy && self.idle >= IDLE, level })
    }

    /// The microphone is off: what was said since the last pause is heard
    /// too, and the phrases not handed back yet come back once all are heard.
    pub fn finish(mut self) -> Result<Vec<String>, String> {
        if let Some((from, to)) = phrases::last(&self.probs) {
            self.hand(from, to);
        }
        drop(self.jobs.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let mut heard = self.heard.lock().unwrap_or_else(PoisonError::into_inner);
        match heard.error.take() {
            Some(error) if heard.phrases.is_empty() => Err(error),
            _ => Ok(std::mem::take(&mut heard.phrases)),
        }
    }

    /// The detector's verdict on the frames not judged yet, with a little
    /// sound before them to start it off.
    fn listen(&mut self) -> Result<(), String> {
        let whole = self.held.len() / FRAME;
        let known = self.probs.len();
        if whole == known {
            return Ok(());
        }
        let from = known.saturating_sub(WARM);
        let probs = self.vad.probabilities(&self.held[from * FRAME..whole * FRAME])?;
        for i in known..whole {
            self.probs.push(probs.get(i - from).copied().unwrap_or(0.0));
        }
        Ok(())
    }

    fn hand(&mut self, from: usize, to: usize) {
        let samples = self.held[from * FRAME..(to * FRAME).min(self.held.len())].to_vec();
        // Nothing to hear, so whisper is not asked: given silence it writes a
        // line it learnt from subtitles rather than nothing.
        if samples.iter().all(|s| s.abs() < QUIET) {
            return;
        }
        if let Some(jobs) = &self.jobs {
            self.heard.lock().unwrap_or_else(PoisonError::into_inner).waiting += 1;
            if jobs.send(samples).is_err() {
                self.heard.lock().unwrap_or_else(PoisonError::into_inner).waiting -= 1;
            }
        }
    }

    fn forget(&mut self, frames: usize) {
        let frames = frames.min(self.probs.len());
        self.held.drain(..(frames * FRAME).min(self.held.len()));
        self.probs.drain(..frames);
    }
}

impl Drop for Dictation {
    /// Turned off without `finish`: the phrases waiting are not heard.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        drop(self.jobs.take());
    }
}

/// The end of what was written, at most `CLUE` letters of it, from a word's
/// start; whisper.cpp takes it as a C string, so no NUL.
fn clue(text: &str) -> String {
    let text: String = text.chars().filter(|&c| c != '\0').collect();
    let count = text.chars().count();
    if count <= CLUE {
        return text.trim().to_string();
    }
    let tail: String = text.chars().skip(count - CLUE).collect();
    let tail = tail.split_once(char::is_whitespace).map_or(tail.as_str(), |(_, rest)| rest);
    tail.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clue_is_the_end_of_what_was_written_from_a_word() {
        assert_eq!(clue("  Привет  "), "Привет");
        assert_eq!(clue("a\0b"), "ab");
        let long = "слово ".repeat(60);
        let tail = clue(&long);
        assert!(tail.chars().count() <= CLUE && tail.starts_with("слово"));
    }

    /// A model, the detector and a recording from elsewhere, fed as the
    /// microphone would, a fifth of a second at a time:
    /// `SPEECH_TEST_FOLDER=…(holding ggml-small-q5_1.bin and ggml-silero-v5.1.2.bin)
    /// SPEECH_TEST_WAV=…/speech.wav cargo test --release -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn hears_phrases_as_they_are_said() {
        let folder = PathBuf::from(std::env::var("SPEECH_TEST_FOLDER").expect("SPEECH_TEST_FOLDER holds the models"));
        let samples = read_wav(&std::env::var("SPEECH_TEST_WAV").expect("SPEECH_TEST_WAV names a recording"));
        let model = std::env::var("SPEECH_TEST_MODEL").unwrap_or_else(|_| "small".into());
        let recognizer = Recognizer::new(folder);
        let started = std::time::Instant::now();
        let mut dictation = recognizer.start(&model, "ru", "").unwrap();
        eprintln!("started in {:?}", started.elapsed());
        let started = std::time::Instant::now();
        let mut all = Vec::new();
        for (i, piece) in samples.chunks(RATE / 5).enumerate() {
            // As fast as the microphone gives it, so the worker keeps up as it would.
            std::thread::sleep(std::time::Duration::from_millis(200));
            let fed = dictation.feed(piece).unwrap();
            for phrase in &fed.phrases {
                eprintln!("{:5.1} s (said by {:5.1} s): {phrase}", started.elapsed().as_secs_f32(), (i + 1) as f32 / 5.0);
            }
            all.extend(fed.phrases);
        }
        let rest = dictation.finish().unwrap();
        eprintln!("{:5.1} s, at the end: {rest:?}", started.elapsed().as_secs_f32());
        all.extend(rest);
        assert!(all.len() >= 2, "{all:?}");
    }

    /// Reads a 16 kHz mono 16-bit WAV.
    fn read_wav(path: &str) -> Vec<f32> {
        let bytes = std::fs::read(path).unwrap();
        let mut at = 12;
        while at + 8 <= bytes.len() {
            let id = &bytes[at..at + 4];
            let length = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            let body = &bytes[at + 8..(at + 8 + length).min(bytes.len())];
            if id == b"fmt " {
                let channels = u16::from_le_bytes([body[2], body[3]]);
                let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
                let bits = u16::from_le_bytes([body[14], body[15]]);
                assert_eq!((channels, rate, bits), (1, RATE as u32, 16), "{path}: not 16 kHz mono 16-bit");
            } else if id == b"data" {
                return body.chunks_exact(2).map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0).collect();
            }
            at += 8 + length + (length & 1);
        }
        panic!("{path}: no sound in it");
    }
}
