//! Voice input (#89) on the desktop: the page hands in the microphone's
//! sound as it records it, and gets back the phrases heard, which it writes
//! into the message field. The hearing is `crates/speech`'s, on this
//! computer; this module fetches the models it reads and keeps the one
//! dictation under way.
//!
//! The models live in the app's data folder under `voice`, where voice
//! messages kept them, so that one downloaded then is not fetched again.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde::Serialize;
use speech::{Dictation, Download, Model, Recognizer};
use tauri::{AppHandle, Emitter, Manager, State};

/// Download progress, as `{ model, done, total }`.
const PROGRESS: &str = "speech-model-progress";
/// Progress is told once a megabyte: some two hundred times for the small model.
const PROGRESS_STEP: u64 = 1 << 20;

/// What the shell keeps for voice input between calls.
#[derive(Default)]
pub struct Speech {
    recognizer: OnceLock<Arc<Recognizer>>,
    /// The microphone's turn under way; one at a time, in whichever window spoke last.
    dictation: Arc<Mutex<Option<Dictation>>>,
    /// A flag for each download under way, raised to stop it.
    downloads: Mutex<HashMap<&'static str, Arc<AtomicBool>>>,
}

impl Speech {
    fn recognizer(&self, app: &AppHandle) -> Result<Arc<Recognizer>, String> {
        if let Some(recognizer) = self.recognizer.get() {
            return Ok(recognizer.clone());
        }
        let folder = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("voice");
        Ok(self.recognizer.get_or_init(|| Arc::new(Recognizer::new(folder))).clone())
    }
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: &'static str,
    bytes: u64,
    present: bool,
}

#[derive(Serialize)]
pub struct Models {
    models: Vec<ModelInfo>,
    /// Why this computer cannot hear speech (a 32-bit build, a processor without AVX2); null when it can.
    unable: Option<String>,
}

#[derive(Serialize, Clone)]
struct Progress {
    model: &'static str,
    done: u64,
    total: u64,
}

#[derive(Serialize)]
pub struct Fed {
    phrases: Vec<String>,
    speaking: bool,
    ended: bool,
}

#[tauri::command]
pub fn speech_models(app: AppHandle, state: State<'_, Speech>) -> Result<Models, String> {
    let models = state
        .recognizer(&app)?
        .models()
        .into_iter()
        .map(|info| ModelInfo { id: info.id, bytes: info.bytes, present: info.present })
        .collect();
    Ok(Models { models, unable: speech::able().err() })
}

/// Fetches what a model needs, the voice detector first, telling
/// `speech-model-progress` how far it has got. What is there already is not
/// fetched again.
#[tauri::command]
pub async fn speech_model_download(app: AppHandle, state: State<'_, Speech>, id: String) -> Result<(), String> {
    speech::able()?;
    let model = speech::models::model(&id)?;
    let recognizer = state.recognizer(&app)?;
    let missing = recognizer.missing(&id)?;
    if missing.is_empty() {
        return Ok(());
    }
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = state.downloads.lock().unwrap();
        if downloads.contains_key(model.id) {
            return Err("the speech model is being downloaded already".into());
        }
        downloads.insert(model.id, stop.clone());
    }
    let total = missing.iter().map(|file| file.bytes).sum();
    let mut before = 0;
    let mut outcome = Ok(());
    for file in missing {
        let tell = |done: u64| {
            let _ = app.emit(PROGRESS, Progress { model: model.id, done: before + done, total });
        };
        outcome = fetch(file, &recognizer, &stop, tell).await;
        if outcome.is_err() {
            break;
        }
        before += file.bytes;
    }
    state.downloads.lock().unwrap().remove(model.id);
    outcome
}

/// One file, which says how far it has got through `tell`.
async fn fetch(file: &'static Model, recognizer: &Recognizer, stop: &AtomicBool, tell: impl Fn(u64)) -> Result<(), String> {
    let mut part = Download::begin(recognizer.folder(), file)?;
    // reqwest comes without a TLS crypto provider of its own and would panic
    // here; the updater installs ring's before its first check, and a model
    // fetched before any update check installs the same.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // There is no deadline for the whole, which on a slow line may take an
        // hour; a connection that stops sending is given up instead.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| crate::updates::with_causes(&e))?;
    let mut answer = client
        .get(file.url())
        .send()
        .await
        .and_then(|answer| answer.error_for_status())
        .map_err(|e| crate::updates::with_causes(&e))?;
    part.expect(answer.content_length())?;
    let mut told = 0;
    tell(0);
    while let Some(chunk) = answer.chunk().await.map_err(|e| crate::updates::with_causes(&e))? {
        if stop.load(Ordering::Relaxed) {
            return Err("the download was stopped".into());
        }
        part.write(&chunk)?;
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

/// Removes a model: stops its download if one is under way, and lets go of
/// it if it is in memory. Removing what is not there is not an error.
#[tauri::command]
pub async fn speech_model_delete(app: AppHandle, state: State<'_, Speech>, id: String) -> Result<(), String> {
    let model = speech::models::model(&id)?;
    if let Some(stop) = state.downloads.lock().unwrap().get(model.id) {
        stop.store(true, Ordering::Relaxed);
    }
    let recognizer = state.recognizer(&app)?;
    tauri::async_runtime::spawn_blocking(move || recognizer.delete(model.id)).await.map_err(|e| e.to_string())?
}

/// Starts listening, with `model` read into memory if it is not; `language`
/// is what is spoken, `before` what the field holds before the caret. A
/// dictation already under way is dropped.
#[tauri::command]
pub async fn speech_start(app: AppHandle, state: State<'_, Speech>, model: String, language: String, before: String) -> Result<(), String> {
    let recognizer = state.recognizer(&app)?;
    let slot = state.dictation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        drop(slot.lock().unwrap_or_else(PoisonError::into_inner).take());
        let dictation = recognizer.start(&model, &language, &before)?;
        *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(dictation);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The microphone's sound since the last call, 16 kHz mono; the phrases
/// heard since then come back.
#[tauri::command]
pub async fn speech_feed(state: State<'_, Speech>, samples: Vec<f32>) -> Result<Fed, String> {
    let slot = state.dictation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = slot.lock().unwrap_or_else(PoisonError::into_inner);
        let dictation = slot.as_mut().ok_or("not listening")?;
        let fed = dictation.feed(&samples)?;
        Ok(Fed { phrases: fed.phrases, speaking: fed.speaking, ended: fed.ended })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The microphone is off: the rest of what was said comes back once heard.
#[tauri::command]
pub async fn speech_finish(state: State<'_, Speech>) -> Result<Vec<String>, String> {
    let slot = state.dictation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dictation = slot.lock().unwrap_or_else(PoisonError::into_inner).take();
        dictation.map_or(Ok(Vec::new()), Dictation::finish)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The microphone is off and what was not heard yet is dropped.
#[tauri::command]
pub fn speech_cancel(state: State<'_, Speech>) {
    drop(state.dictation.lock().unwrap_or_else(PoisonError::into_inner).take());
}

/// Lets go of the model in memory, when voice input is turned off.
#[tauri::command]
pub async fn speech_unload(app: AppHandle, state: State<'_, Speech>) -> Result<(), String> {
    drop(state.dictation.lock().unwrap_or_else(PoisonError::into_inner).take());
    let recognizer = state.recognizer(&app)?;
    tauri::async_runtime::spawn_blocking(move || recognizer.unload()).await.map_err(|e| e.to_string())
}
