//! Voice input as Kotlin and Swift see it (uniffi). The phones' native code
//! owns the microphone: it hands the sound in as it records it, a quarter of
//! a second at a time, and passes the phrases that come back to the page.
//! Every call that waits (a download, reading a model in, the last phrase)
//! is made off the phone's main thread.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use crate::dictation::{Dictation, Recognizer};
use crate::models::{self, Download, Model};

/// Flat: Kotlin and Swift get the words as the error's message (a field named
/// `message` would clash with Kotlin's own on every exception).
#[derive(Debug, uniffi::Error)]
#[uniffi(flat_error)]
pub enum SpeechError {
    /// What went wrong, in the words the page shows.
    Failed(String),
}

impl std::fmt::Display for SpeechError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpeechError::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for SpeechError {}

impl From<String> for SpeechError {
    fn from(message: String) -> Self {
        SpeechError::Failed(message)
    }
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SpeechModel {
    pub id: String,
    /// The model's size once here; before, what is left to fetch. Signed, as Java has no other.
    pub bytes: i64,
    pub present: bool,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct Heard {
    /// Phrases heard since the last call, in the order they were said.
    pub phrases: Vec<String>,
    /// Someone is speaking, or a phrase is being heard.
    pub speaking: bool,
    /// Long quiet: the microphone can go off.
    pub ended: bool,
    /// How loud the sound handed in was at its loudest, 0 to 1.
    pub level: f32,
}

/// How far a download has got, in bytes of all it fetches.
#[uniffi::export(callback_interface)]
pub trait DownloadProgress: Send + Sync {
    fn told(&self, done: i64, total: i64);
}

#[derive(uniffi::Object)]
pub struct SpeechInput {
    recognizer: Recognizer,
    dictation: Mutex<Option<Dictation>>,
    /// Raised to stop the download under way.
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

#[uniffi::export]
impl SpeechInput {
    /// With the models kept in `folder`, one the phone does not back up.
    #[uniffi::constructor]
    pub fn new(folder: String) -> Arc<Self> {
        Arc::new(SpeechInput { recognizer: Recognizer::new(PathBuf::from(folder)), dictation: Mutex::default(), stop: Mutex::default() })
    }

    /// Why this phone cannot hear speech, or nothing when it can.
    pub fn unable(&self) -> Option<String> {
        models::able().err()
    }

    pub fn models(&self) -> Vec<SpeechModel> {
        self.recognizer.models().into_iter().map(|info| SpeechModel { id: info.id.into(), bytes: info.bytes as i64, present: info.present }).collect()
    }

    /// Fetches what a model needs, the voice detector first; what is there
    /// already is not fetched again. Waits until it is all here.
    pub fn download(&self, id: String, progress: Box<dyn DownloadProgress>) -> Result<(), SpeechError> {
        models::able()?;
        let missing = self.recognizer.missing(&id)?;
        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut slot = self.stop.lock().unwrap_or_else(PoisonError::into_inner);
            if slot.is_some() {
                return Err("the speech model is being downloaded already".to_string().into());
            }
            *slot = Some(stop.clone());
        }
        let total: u64 = missing.iter().map(|file| file.bytes).sum();
        let mut before = 0;
        let mut outcome = Ok(());
        for file in missing {
            outcome = fetch(file, self.recognizer.folder(), &stop, |done| progress.told((before + done) as i64, total as i64));
            if outcome.is_err() {
                break;
            }
            before += file.bytes;
        }
        *self.stop.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(outcome?)
    }

    /// Removes a model, stopping its download if one is under way.
    pub fn delete(&self, id: String) -> Result<(), SpeechError> {
        if let Some(stop) = self.stop.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            stop.store(true, Ordering::Relaxed);
        }
        Ok(self.recognizer.delete(&id)?)
    }

    /// Lets go of the model in memory, when voice input is turned off.
    pub fn unload(&self) {
        self.cancel();
        self.recognizer.unload();
    }

    /// Starts listening, with `model` read into memory if it is not.
    pub fn start(&self, model: String, language: String, before: String) -> Result<(), SpeechError> {
        self.cancel();
        let dictation = self.recognizer.start(&model, &language, &before)?;
        *self.dictation.lock().unwrap_or_else(PoisonError::into_inner) = Some(dictation);
        Ok(())
    }

    /// The microphone's sound since the last call, 16 kHz mono in [-1, 1].
    pub fn feed(&self, samples: Vec<f32>) -> Result<Heard, SpeechError> {
        let mut slot = self.dictation.lock().unwrap_or_else(PoisonError::into_inner);
        let dictation = slot.as_mut().ok_or_else(|| "not listening".to_string())?;
        let fed = dictation.feed(&samples)?;
        Ok(Heard { phrases: fed.phrases, speaking: fed.speaking, ended: fed.ended, level: fed.level })
    }

    /// The microphone is off: what was said last comes back once heard.
    pub fn finish(&self) -> Result<Vec<String>, SpeechError> {
        let dictation = self.dictation.lock().unwrap_or_else(PoisonError::into_inner).take();
        Ok(dictation.map_or(Ok(Vec::new()), Dictation::finish)?)
    }

    /// The microphone is off, and what is not heard yet is dropped.
    pub fn cancel(&self) {
        drop(self.dictation.lock().unwrap_or_else(PoisonError::into_inner).take());
    }
}

/// Progress is told once a megabyte.
const PROGRESS_STEP: u64 = 1 << 20;

/// One file over HTTPS, written through `Download`, which checks it.
fn fetch(file: &'static Model, folder: &Path, stop: &AtomicBool, tell: impl Fn(u64)) -> Result<(), String> {
    let mut part = Download::begin(folder, file)?;
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_connect(Some(Duration::from_secs(30))).build().into();
    let mut answer = agent.get(file.url()).call().map_err(|e| format!("{}: {e}", file.file))?;
    part.expect(answer.body().content_length())?;
    let mut reader = answer.body_mut().with_config().limit(file.bytes + 1).reader();
    let mut buffer = vec![0u8; 1 << 16];
    let mut told = 0;
    tell(0);
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err("the download was stopped".into());
        }
        let read = reader.read(&mut buffer).map_err(|e| format!("{}: {e}", file.file))?;
        if read == 0 {
            break;
        }
        part.write(&buffer[..read])?;
        if part.done() - told >= PROGRESS_STEP {
            told = part.done();
            tell(told);
        }
    }
    let done = part.done();
    part.finish()?;
    if told != done {
        tell(done);
    }
    Ok(())
}
