//! Voice messages (#89), tried on the desktop alone: what is heavy about them
//! lives here, out of the page. A voice message travels as text (see
//! `protocol/voice.ts`), packed with zstd and a dictionary trained on Russian
//! speech, the one MeshSpeech-200 trained on subtitles. A part has room for
//! 147 bytes, so the frame is cut to the bone: no magic number, no dictionary
//! id and no checksum, which the datagram's own seal already covers.
//!
//! The text is written down from the sender's speech on this computer:
//! whisper.cpp hears the recording with a model the reader downloads once,
//! so the voice itself never leaves the machine. It runs on the processor
//! alone, decoding greedily on four threads at most: for a message of a few
//! seconds that is quick enough, and it spends as little power as it can.
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufWriter, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use zstd::bulk::{Compressor, Decompressor};
use zstd::zstd_safe::{CParameter, DParameter, FrameFormat};

/// The dictionary every Ommesh reads `VoiceCodec.ZstdRuV1` with. Changing a
/// single byte of it makes a new packing, with a new number.
const DICTIONARY: &[u8] = include_bytes!("../voice/meshspeech-ru-v1.zstd");
/// Effort spent packing: a part is a few dozen bytes, so the slowest level costs nothing noticeable.
const LEVEL: i32 = 19;
/// More than any part unpacks to: 147 packed bytes of speech are some 300 letters.
const UNPACKED_MAX: usize = 4096;

fn packer() -> &'static Mutex<Compressor<'static>> {
    static PACKER: OnceLock<Mutex<Compressor<'static>>> = OnceLock::new();
    PACKER.get_or_init(|| {
        let mut packer = Compressor::with_dictionary(LEVEL, DICTIONARY).expect("the voice dictionary loads");
        for parameter in [
            CParameter::Format(FrameFormat::Magicless),
            CParameter::DictIdFlag(false),
            CParameter::ChecksumFlag(false),
            CParameter::ContentSizeFlag(true),
        ] {
            packer.set_parameter(parameter).expect("zstd takes the frame parameters");
        }
        Mutex::new(packer)
    })
}

fn unpacker() -> &'static Mutex<Decompressor<'static>> {
    static UNPACKER: OnceLock<Mutex<Decompressor<'static>>> = OnceLock::new();
    UNPACKER.get_or_init(|| {
        let mut unpacker = Decompressor::with_dictionary(DICTIONARY).expect("the voice dictionary loads");
        unpacker.set_parameter(DParameter::Format(FrameFormat::Magicless)).expect("zstd takes the frame format");
        Mutex::new(unpacker)
    })
}

pub fn pack(text: &str) -> Result<Vec<u8>, String> {
    let mut packer = packer().lock().map_err(|e| e.to_string())?;
    packer.compress(text.as_bytes()).map_err(|e| e.to_string())
}

pub fn unpack(data: &[u8]) -> Result<String, String> {
    let mut unpacker = unpacker().lock().map_err(|e| e.to_string())?;
    let bytes = unpacker.decompress(data, UNPACKED_MAX).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_pack(text: String) -> Result<Vec<u8>, String> {
    pack(&text)
}

#[tauri::command]
pub fn voice_unpack(data: Vec<u8>) -> Result<String, String> {
    unpack(&data)
}

/// A speech model the page can choose. Both are whisper.cpp's own,
/// quantised to five bits: two fifths of the full size, and on forty
/// recordings of Russian speech the quantised base model got as many words
/// right as the full one. The size and digest are those of the published
/// files; a download that does not match them is thrown away rather than
/// handed to the C++ that reads it.
struct Model {
    id: &'static str,
    file: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const MODELS: [Model; 2] = [
    // Hears Russian noticeably better (a fifth fewer words wrong than base on
    // the same forty recordings), so it is the one offered first.
    Model {
        id: "small",
        file: "ggml-small-q5_1.bin",
        bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
    // A third of the download and some four times as quick, for a slow computer.
    Model {
        id: "base",
        file: "ggml-base-q5_1.bin",
        bytes: 59_707_625,
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    },
];

/// Where the models are published. The files there have not changed in years; the digests would notice if they did.
const SOURCE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
/// Download progress, as `{ model, done, total }`.
const PROGRESS: &str = "voice-model-progress";
/// Progress is told once a megabyte: some two hundred times for the small model.
const PROGRESS_STEP: u64 = 1 << 20;
/// What the page records and whisper hears: 16 kHz mono.
const RATE: usize = 16_000;
/// The longest recording heard. A voice message is a few sentences; this
/// leaves room for half a minute of them and refuses what would keep the
/// processor busy for much longer.
const LONGEST_SECONDS: usize = 35;
/// -60 dB: below it throughout, the microphone was muted or the recording
/// stopped at once.
const QUIET: f32 = 0.001;
#[cfg(not(target_pointer_width = "64"))]
const NOT_HERE: &str = "speech recognition needs a 64-bit Windows";

fn model(id: &str) -> Result<&'static Model, String> {
    MODELS.iter().find(|model| model.id == id).ok_or_else(|| format!("no speech model is called {id:?}"))
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("voice"))
}

fn part_path(folder: &Path, model: &Model) -> PathBuf {
    folder.join(format!("{}.part", model.file))
}

/// A file of the right size is taken as whole: it gets its name only once its digest has been checked.
fn present(path: &Path, model: &Model) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.len() == model.bytes)
}

fn check_length(samples: usize) -> Result<(), String> {
    if samples > RATE * LONGEST_SECONDS {
        return Err(format!(
            "{} s of speech is more than the {LONGEST_SECONDS} s a voice message may hold",
            samples / RATE
        ));
    }
    Ok(())
}

/// Nothing to hear, so whisper is not asked: given silence it writes a line
/// it learnt from subtitles ("Редактор субтитров А.Семкин Корректор
/// А.Егорова") rather than nothing. Room noise without speech is not caught
/// here and can still come back as words.
fn silent(samples: &[f32]) -> bool {
    samples.iter().all(|sample| !(sample.abs() >= QUIET))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Whether this computer can run the recogniser as the release is built.
/// The build workflow compiles whisper.cpp for a known set of instructions
/// rather than for the runner it happens to run on: AVX2 on x86 (Intel since
/// 2013 and AMD since 2015, though not their cheapest Pentiums and Celerons
/// for some years after) and the ARMv8.2 dot product on ARM. A processor
/// without them would stop the app at the first instruction it lacks, so it
/// is told no here instead, before it downloads a model it cannot use.
fn able() -> Result<(), String> {
    #[cfg(not(target_pointer_width = "64"))]
    return Err(NOT_HERE.into());
    #[cfg(target_arch = "x86_64")]
    if !(is_x86_feature_detected!("avx2")
        && is_x86_feature_detected!("fma")
        && is_x86_feature_detected!("f16c")
        && is_x86_feature_detected!("bmi2"))
    {
        return Err("speech recognition needs a processor with AVX2".into());
    }
    #[cfg(target_arch = "aarch64")]
    if !(std::arch::is_aarch64_feature_detected!("dotprod") && std::arch::is_aarch64_feature_detected!("fp16")) {
        return Err("speech recognition needs an ARMv8.2 processor".into());
    }
    #[cfg(target_pointer_width = "64")]
    Ok(())
}

/// whisper.cpp, which the 64-bit apps alone carry: built for 32-bit Windows
/// (`i686` in the build workflow), ggml takes the processor for an unknown
/// one and falls back to plain C, and a computer that old seldom has AVX2
/// anyway.
#[cfg(target_pointer_width = "64")]
mod engine {
    use std::path::Path;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    /// A model read into memory.
    pub struct Engine(WhisperContext);

    pub fn load(path: &Path) -> Result<Engine, String> {
        // whisper.cpp and ggml print a page about the model on every load; this
        // sends it to `log`, where `RUST_LOG` shows it, rather than to stderr.
        whisper_rs::install_logging_hooks();
        let mut params = WhisperContextParameters::default();
        // Flash attention came out slower on the processor for messages this short.
        params.flash_attn(false);
        WhisperContext::new_with_params(path, params)
            .map(Engine)
            .map_err(|e| format!("the speech model did not load: {e}"))
    }

    impl Engine {
        /// The Russian words in 16 kHz mono speech.
        pub fn hear(&self, samples: &[f32]) -> Result<String, String> {
            // The recogniser's working memory, made for each message and freed
            // after: it takes milliseconds to make and much memory to keep.
            let mut state = self.0.create_state().map_err(|e| e.to_string())?;
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some("ru"));
            params.set_n_threads(threads());
            // Each message stands alone: the last one's words are no clue to this one's.
            params.set_no_context(true);
            params.set_no_timestamps(true);
            params.set_suppress_blank(true);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            state.full(params, samples).map_err(|e| e.to_string())?;
            let mut text = String::new();
            for segment in state.as_iter() {
                text.push_str(&segment.to_str_lossy().map_err(|e| e.to_string())?);
            }
            Ok(text.trim().to_string())
        }
    }

    /// Four threads at most, for power rather than the last bit of speed: on a
    /// 12-core Snapdragon X, eight heard a message 30% sooner but spent 40%
    /// more processor time on it.
    fn threads() -> i32 {
        std::thread::available_parallelism().map_or(1, |n| n.get().min(4)) as i32
    }
}

#[cfg(not(target_pointer_width = "64"))]
mod engine {
    pub struct Engine;

    pub fn load(_: &std::path::Path) -> Result<Engine, String> {
        Err(super::NOT_HERE.into())
    }

    impl Engine {
        pub fn hear(&self, _: &[f32]) -> Result<String, String> {
            Err(super::NOT_HERE.into())
        }
    }
}

/// What the shell keeps for speech between calls.
#[derive(Default)]
pub struct Voice {
    /// The model last used, by id. It stays in memory while voice messages
    /// are on, since reading it in again would cost time and power on every
    /// message; the lock is held through a whole recognition, so one runs at
    /// a time.
    loaded: Arc<Mutex<Option<(&'static str, engine::Engine)>>>,
    /// A flag for each download under way, raised to stop it.
    downloads: Mutex<HashMap<&'static str, Arc<AtomicBool>>>,
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: &'static str,
    file: &'static str,
    bytes: u64,
    present: bool,
}

#[derive(Serialize, Clone)]
struct Progress {
    model: &'static str,
    done: u64,
    total: Option<u64>,
}

#[tauri::command]
pub fn voice_models(app: AppHandle) -> Vec<ModelInfo> {
    let folder = folder(&app).ok();
    MODELS
        .iter()
        .map(|model| ModelInfo {
            id: model.id,
            file: model.file,
            bytes: model.bytes,
            present: folder.as_ref().is_some_and(|folder| present(&folder.join(model.file), model)),
        })
        .collect()
}

/// Fetches a model, telling `voice-model-progress` how far it has got. One
/// already there is not fetched again.
#[tauri::command]
pub async fn voice_model_download(app: AppHandle, state: State<'_, Voice>, id: String) -> Result<(), String> {
    let model = model(&id)?;
    able()?;
    let folder = folder(&app)?;
    if present(&folder.join(model.file), model) {
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
    let outcome = fetch(model, &folder, &stop, |done| tell(&app, model, done)).await;
    state.downloads.lock().unwrap().remove(model.id);
    outcome
}

/// A download's file under its working name, removed unless the download
/// got to rename it: nothing resumes a broken download, so a part is only
/// disk taken.
struct Part {
    path: PathBuf,
    kept: bool,
}

impl Drop for Part {
    fn drop(&mut self) {
        if !self.kept {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// The download itself, which says how far it has got through `tell`.
async fn fetch(model: &Model, folder: &Path, stop: &AtomicBool, tell: impl Fn(u64)) -> Result<(), String> {
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let path = part_path(folder, model);
    let file = OpenOptions::new().create(true).write(true).truncate(false).open(&path).map_err(|e| e.to_string())?;
    // Another copy of the app (#12) fetching the same model at the same time
    // holds the part; it is left to that copy, not emptied under it.
    if file.try_lock().is_err() {
        return Err("the speech model is being downloaded by another Ommesh window".into());
    }
    let mut part = Part { path: path.clone(), kept: false };
    file.set_len(0).map_err(|e| e.to_string())?;
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
        .get(format!("{SOURCE}{}", model.file))
        .send()
        .await
        .and_then(|answer| answer.error_for_status())
        .map_err(|e| crate::updates::with_causes(&e))?;
    if let Some(length) = answer.content_length().filter(|length| *length != model.bytes) {
        return Err(format!("{} is {length} bytes there, not {}", model.file, model.bytes));
    }
    let mut out = BufWriter::with_capacity(1 << 20, &file);
    let mut digest = Sha256::new();
    let (mut done, mut told) = (0u64, 0u64);
    tell(done);
    while let Some(chunk) = answer.chunk().await.map_err(|e| crate::updates::with_causes(&e))? {
        if stop.load(Ordering::Relaxed) {
            return Err("the download was stopped".into());
        }
        done += chunk.len() as u64;
        if done > model.bytes {
            return Err(format!("{} is longer than it should be", model.file));
        }
        digest.update(&chunk);
        out.write_all(&chunk).map_err(|e| e.to_string())?;
        if done - told >= PROGRESS_STEP {
            tell(done);
            told = done;
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if done != model.bytes || hex(&digest.finalize()) != model.sha256 {
        return Err(format!("{} arrived damaged; try again", model.file));
    }
    if told != done {
        tell(done);
    }
    // On disk before it takes the model's name, so that a model found there
    // after a power cut is whole. Renamed while still locked, so no other
    // copy can start on the part in between.
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&path, folder.join(model.file)).map_err(|e| e.to_string())?;
    part.kept = true;
    Ok(())
}

fn tell(app: &AppHandle, model: &'static Model, done: u64) {
    let _ = app.emit(PROGRESS, Progress { model: model.id, done, total: Some(model.bytes) });
}

/// Removes a model: stops its download if one is under way, and lets go of
/// it if it is in memory. Removing what is not there is not an error.
#[tauri::command]
pub async fn voice_model_delete(app: AppHandle, state: State<'_, Voice>, id: String) -> Result<(), String> {
    let model = model(&id)?;
    if let Some(stop) = state.downloads.lock().unwrap().get(model.id) {
        stop.store(true, Ordering::Relaxed);
    }
    let loaded = state.loaded.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.as_ref().is_some_and(|(id, _)| *id == model.id) {
            *slot = None;
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let folder = folder(&app)?;
    // A part left by a download the app was closed in the middle of goes too,
    // unless another copy of the app is writing it now.
    let part = part_path(&folder, model);
    if let Ok(file) = OpenOptions::new().write(true).open(&part) {
        if file.try_lock().is_ok() {
            drop(file);
            let _ = std::fs::remove_file(&part);
        }
    }
    match std::fs::remove_file(folder.join(model.file)) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// The words in a recording of 16 kHz mono samples in [-1, 1], as the page
/// records them; an empty answer when nothing was said. The model stays in
/// memory for the next message until `voice_unload`.
#[tauri::command]
pub async fn voice_transcribe(
    app: AppHandle,
    state: State<'_, Voice>,
    id: String,
    mut samples: Vec<f32>,
) -> Result<String, String> {
    let model = model(&id)?;
    able()?;
    check_length(samples.len())?;
    // A sample that is not a number would spoil the whole spectrogram.
    samples.iter_mut().filter(|sample| !sample.is_finite()).for_each(|sample| *sample = 0.0);
    if silent(&samples) {
        return Ok(String::new());
    }
    let path = folder(&app)?.join(model.file);
    if !present(&path, model) {
        return Err(format!("the {} speech model is not downloaded", model.id));
    }
    let loaded = state.loaded.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if !slot.as_ref().is_some_and(|(id, _)| *id == model.id) {
            // The old model goes before the new one is read in, so the two are never in memory together.
            *slot = None;
            *slot = Some((model.id, engine::load(&path)?));
        }
        let (_, engine) = slot.as_ref().expect("a model was just loaded");
        engine.hear(&samples)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lets go of the model in memory, when voice messages are switched off.
#[tauri::command]
pub async fn voice_unload(state: State<'_, Voice>) -> Result<(), String> {
    let loaded = state.loaded.clone();
    tauri::async_runtime::spawn_blocking(move || *loaded.lock().unwrap_or_else(PoisonError::into_inner) = None)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn russian_speech_packs_small_and_comes_back_whole() {
        for text in [
            "Можешь включить сериал «Теория большого взрыва».",
            "Буду у вышки через десять минут, возьми запасную батарею.",
            "Принял. Батарея в машине, подойду к шлагбауму минут через пять.",
        ] {
            let packed = pack(text).unwrap();
            assert_eq!(unpack(&packed).unwrap(), text);
            let letters = text.chars().count();
            eprintln!("{} letters, {} bytes of UTF-8, {} packed: {text}", letters, text.len(), packed.len());
            // MeshSpeech measured about a byte a letter with its frame; ours drops some ten bytes of it.
            assert!(packed.len() < letters, "{text}: {} bytes for {letters} letters", packed.len());
            assert!(packed.len() < text.len() / 2 + 8, "{text}: {} bytes against {} of UTF-8", packed.len(), text.len());
        }
    }

    #[test]
    fn ten_seconds_of_speech_fit_one_part() {
        // About 130 letters, ten seconds said aloud.
        let text = "Всем привет, это Борис с вышки. Батарея на ретрансляторе садится, утром было три и семь вольта, сейчас меньше. Кто едет мимо, захватите запасную.";
        let packed = pack(text).unwrap();
        eprintln!("{} letters, {} bytes of UTF-8, {} packed", text.chars().count(), text.len(), packed.len());
        assert!(packed.len() <= 147, "{} bytes", packed.len());
    }

    #[test]
    fn something_else_is_refused_rather_than_misread() {
        assert!(unpack(&[0x41, 0x42, 0x43]).is_err());
    }

    #[test]
    fn a_model_is_found_by_its_id_alone() {
        assert_eq!(model("small").unwrap().file, "ggml-small-q5_1.bin");
        assert_eq!(model("base").unwrap().file, "ggml-base-q5_1.bin");
        for id in ["", "tiny", "SMALL", "small/../base", "ggml-small-q5_1.bin"] {
            assert!(model(id).is_err(), "{id:?}");
        }
        assert_eq!(part_path(Path::new("voice"), model("base").unwrap()), Path::new("voice").join("ggml-base-q5_1.bin.part"));
    }

    #[test]
    fn half_a_minute_is_heard_and_more_than_35_seconds_is_not() {
        assert!(check_length(0).is_ok());
        assert!(check_length(30 * RATE).is_ok());
        assert!(check_length(35 * RATE).is_ok());
        assert!(check_length(35 * RATE + 1).is_err());
    }

    #[test]
    fn a_muted_microphone_is_silence_and_a_whisper_is_not() {
        assert!(silent(&[]));
        assert!(silent(&[0.0; RATE]));
        assert!(silent(&[0.0005, -0.0009, f32::NAN]));
        assert!(!silent(&[0.0, 0.002, -0.0001]));
    }

    #[test]
    fn digests_are_compared_as_lowercase_hex() {
        assert_eq!(hex(&Sha256::digest(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert!(MODELS.iter().all(|model| model.sha256.len() == 64 && model.sha256 == model.sha256.to_lowercase()));
    }

    /// The base model fetched from Hugging Face into a folder of the system's
    /// temporary one, stopped once and then whole: `cargo test --lib voice --
    /// --ignored --nocapture`, with some 120 MB to spare on the line.
    #[test]
    #[ignore]
    fn fetches_a_model_whole_or_not_at_all() {
        let folder = std::env::temp_dir().join("ommesh-voice-test");
        let _ = std::fs::remove_dir_all(&folder);
        let model = model("base").unwrap();
        let stop = AtomicBool::new(false);
        let stopped = tauri::async_runtime::block_on(fetch(model, &folder, &stop, |done| {
            if done >= 4 * PROGRESS_STEP {
                stop.store(true, Ordering::Relaxed);
            }
        }));
        assert_eq!(stopped, Err("the download was stopped".to_string()));
        assert!(!part_path(&folder, model).exists() && !folder.join(model.file).exists());

        let stop = AtomicBool::new(false);
        let told = Mutex::new(Vec::new());
        let started = std::time::Instant::now();
        tauri::async_runtime::block_on(fetch(model, &folder, &stop, |done| told.lock().unwrap().push(done))).unwrap();
        let told = told.into_inner().unwrap();
        eprintln!("{} bytes in {:?}, told {} times", model.bytes, started.elapsed(), told.len());
        assert!(present(&folder.join(model.file), model));
        assert!(!part_path(&folder, model).exists());
        assert_eq!((told.first(), told.last()), (Some(&0), Some(&model.bytes)));
        assert!(told.windows(2).all(|pair| pair[0] < pair[1]));
        let _ = std::fs::remove_dir_all(&folder);
    }

    /// Reads a 16 kHz mono 16-bit WAV, what the page records once it is made a file.
    #[cfg(target_pointer_width = "64")]
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

    /// Recognition end to end, with a model and a recording from elsewhere:
    /// `VOICE_TEST_MODEL=…/ggml-base-q5_1.bin VOICE_TEST_WAV=…/speech.wav
    /// cargo test --lib voice -- --ignored --nocapture`.
    #[test]
    #[ignore]
    #[cfg(target_pointer_width = "64")]
    fn hears_russian_speech() {
        let model = std::env::var("VOICE_TEST_MODEL").expect("VOICE_TEST_MODEL names a ggml model");
        let samples = read_wav(&std::env::var("VOICE_TEST_WAV").expect("VOICE_TEST_WAV names a recording"));
        able().unwrap();
        let started = std::time::Instant::now();
        let engine = engine::load(Path::new(&model)).unwrap();
        eprintln!("loaded in {:?}", started.elapsed());
        for _ in 0..2 {
            let started = std::time::Instant::now();
            let text = engine.hear(&samples).unwrap();
            eprintln!("{:.1} s of speech heard in {:?}: {text}", samples.len() as f32 / RATE as f32, started.elapsed());
            assert!(!text.is_empty());
        }
        // What whisper makes of silence, which `voice_transcribe` never asks it.
        eprintln!("silence: {:?}", engine.hear(&vec![0.0; 3 * RATE]).unwrap());
    }
}
